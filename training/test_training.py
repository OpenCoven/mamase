"""Run with .venv-training/bin/python -m unittest discover -s training -v."""

import hashlib
import json
import math
from pathlib import Path
import random
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

from training.create_smoke_fixture import create_fixture
from training.data import (
    EncodedExample, Example, accumulation_groups, collate, deterministic_split,
    encode_example, optimizer_steps, read_source, split_counts, validate_record,
    write_splits,
)
from training.mlx_runner import (
    evaluate, load_local_model, optimizer_update, read_job, supervised_loss,
    should_report_progress, validated_model_config,
)

TRAINING = Path(__file__).resolve().parent
ROOT = TRAINING.parent


class SplitTests(unittest.TestCase):
    def test_seed_42_full_shuffle_holdout_prefix_and_no_global_rng_mutation(self):
        state = random.getstate()
        train, valid = deterministic_split(list(range(9)), 25)
        self.assertEqual(valid, [3, 6])
        self.assertEqual(train, [7, 4, 8, 2, 5, 0, 1])
        self.assertEqual(random.getstate(), state)
        self.assertFalse(set(train) & set(valid))
        self.assertEqual(sorted(train + valid), list(range(9)))

    def test_counts_floor_and_at_least_one_holdout(self):
        self.assertEqual(split_counts(9, 25), (7, 2))
        self.assertEqual(split_counts(6, 0), (5, 1))
        self.assertEqual(split_counts(7, 28.5), (6, 1))
        for count, percentage in ((1, 20), (6, 100), (6, -1), (6, math.nan)):
            with self.subTest(count=count, percentage=percentage), self.assertRaises(ValueError):
                split_counts(count, percentage)

    def test_optimizer_steps_and_partial_groups(self):
        groups = list(accumulation_groups(list(range(7)), 2, 3))
        self.assertEqual(groups, [[[0, 1], [2, 3], [4, 5]], [[6]]])
        self.assertEqual(optimizer_steps(7, 2, 3, 2), 4)
        self.assertEqual(optimizer_steps(2, 8, 10, 3), 3)
        self.assertEqual(optimizer_steps(10, 2, 1, 2), 10)
        for examples in range(1, 20):
            for batch in (1, 2, 4, 30):
                for accumulation in (1, 2, 5):
                    actual = len(list(accumulation_groups(list(range(examples)), batch, accumulation)))
                    self.assertEqual(optimizer_steps(examples, batch, accumulation, 3), actual * 3)

    def test_source_hash_count_format_and_written_split_counts(self):
        with tempfile.TemporaryDirectory(dir=TRAINING) as directory:
            source = Path(directory) / "source.jsonl"
            records = [{"prompt": f"Question {i}", "response": f"Answer {i}"} for i in range(9)]
            original = "".join(json.dumps(record) + "\n" for record in records).encode()
            source.write_bytes(original)
            metadata = {
                "sha256": hashlib.sha256(original).hexdigest(),
                "records": 9, "format": "prompt-response",
            }
            examples = read_source(source, metadata)
            train, valid = deterministic_split(examples, 25)
            write_splits(source.parent, train, valid)
            self.assertEqual(len((source.parent / "train.jsonl").read_text().splitlines()), 7)
            self.assertEqual(len((source.parent / "valid.jsonl").read_text().splitlines()), 2)
            self.assertEqual(source.read_bytes(), original)
            with self.assertRaisesRegex(ValueError, "count mismatch"):
                read_source(source, {**metadata, "records": 8})
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                read_source(source, {**metadata, "sha256": "0" * 64})
            with self.assertRaisesRegex(ValueError, "messages"):
                read_source(source, {**metadata, "format": "messages"})

    def test_split_files_are_never_overwritten(self):
        for existing in ("train.jsonl", "valid.jsonl"):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory(dir=TRAINING) as directory:
                path = Path(directory)
                (path / existing).write_text("preserve existing content")
                example = Example(1, {"prompt": "Hello", "response": "World"})
                with self.assertRaisesRegex(FileExistsError, "Refusing to overwrite"):
                    write_splits(path, [example], [example])
                self.assertEqual((path / existing).read_text(), "preserve existing content")
                self.assertEqual(list(path.iterdir()), [path / existing])

    def test_final_progress_when_interval_does_not_divide_total(self):
        for total in (5001, 9999, 10001, 25003):
            with self.subTest(total=total):
                interval = (total + 4999) // 5000
                self.assertNotEqual(total % interval, 0)
                reports = [
                    step for step in range(1, total + 1)
                    if should_report_progress(step, total)
                ]
                self.assertEqual(reports[-1], total)
                self.assertLessEqual(len(reports), 5000)
                self.assertTrue(all(step % interval == 0 for step in reports[:-1]))

    def test_reject_empty_response_and_non_text(self):
        for record in (
            {"prompt": "x", "response": ""},
            {"prompt": "x", "response": ["no"]},
        ):
            with self.assertRaises(ValueError):
                validate_record(record, "prompt-response", 1)

    def test_padding_mask_and_causal_target_positions(self):
        first = EncodedExample((1, 2, 3, 4), (False, False, True, True), 1)
        second = EncodedExample((1, 5, 4), (False, True, True), 2)
        tokens, masks = collate([first, second], 0)
        self.assertEqual(tokens, [[1, 2, 3, 4], [1, 5, 4, 0]])
        self.assertEqual(masks, [[False, False, True, True], [False, True, True, False]])


class MLXTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(dir=TRAINING)
        cls.addClassCleanup(cls.directory.cleanup)
        cls.fixture = create_fixture(Path(cls.directory.name) / "fixture")
        cls.model_path = Path(cls.fixture["modelPath"])
        _, cls.tokenizer, _ = load_local_model(cls.model_path)

    def test_real_chat_template_masks_all_assistant_turns_not_prompts(self):
        record = {"messages": [
            {"role": "system", "content": "Be brief."},
            {"role": "user", "content": "First?"},
            {"role": "assistant", "content": "red"},
            {"role": "user", "content": "Next?"},
            {"role": "assistant", "content": "blue"},
        ]}
        example = encode_example(Example(1, record), "messages", self.tokenizer, 256)
        expected = self.tokenizer.apply_chat_template(
            record["messages"], tokenize=True, add_generation_prompt=False, return_dict=False,
        )
        self.assertEqual(list(example.tokens), expected)
        supervised = self.tokenizer.decode([
            token for token, mask in zip(example.tokens, example.mask) if mask
        ])
        self.assertEqual(supervised, "red<eos>blue<eos>")
        self.assertFalse(example.mask[0])

    def test_prompt_response_uses_chat_template_when_available(self):
        plain = Example(1, {"prompt": "Say red.", "response": "red"})
        chat = Example(1, {"messages": [
            {"role": "user", "content": "Say red."},
            {"role": "assistant", "content": "red"},
        ]})
        self.assertEqual(
            encode_example(plain, "prompt-response", self.tokenizer, 96),
            encode_example(chat, "messages", self.tokenizer, 96),
        )

    def test_plain_format_and_messages_without_template(self):
        from transformers import AutoTokenizer

        tokenizer = AutoTokenizer.from_pretrained(
            self.model_path, trust_remote_code=False, local_files_only=True
        )
        tokenizer.chat_template = None
        example = encode_example(
            Example(3, {"prompt": "Say red.", "response": "red"}),
            "prompt-response", tokenizer, 96,
        )
        self.assertEqual(tokenizer.decode(example.tokens), "<bos>Say red.\nred<eos>")
        self.assertEqual(
            tokenizer.decode([token for token, mask in zip(example.tokens, example.mask) if mask]),
            "red<eos>",
        )
        with self.assertRaisesRegex(ValueError, "real chat template"):
            encode_example(Example(3, {"messages": [
                {"role": "user", "content": "Say red."},
                {"role": "assistant", "content": "red"},
            ]}), "messages", tokenizer, 96)

    def test_reject_entirely_truncated_response_not_drop_example(self):
        example = Example(9, {"prompt": "x" * 120, "response": "red"})
        with self.assertRaisesRegex(ValueError, "Source line 9.*no content targets"):
            encode_example(example, "prompt-response", self.tokenizer, 16)
        later_response = Example(10, {"messages": [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "red"},
            {"role": "user", "content": "x" * 120},
            {"role": "assistant", "content": "blue"},
        ]})
        with self.assertRaisesRegex(ValueError, "Source line 10.*no content targets"):
            encode_example(later_response, "messages", self.tokenizer, 32)

    def test_partial_response_truncation_is_recorded(self):
        example = encode_example(
            Example(1, {"prompt": "Hi", "response": "red" * 100}),
            "prompt-response", self.tokenizer, 32,
        )
        self.assertEqual(len(example.tokens), 32)
        self.assertTrue(example.truncated)
        self.assertGreater(example.target_count, 0)

    def test_loss_ignores_prompt_and_padding_logits(self):
        import mlx.core as mx
        from mlx import nn

        tokens = mx.array([[1, 2, 3, 4, 0]])
        mask = mx.array([[False, False, True, True, False]])
        base = mx.zeros((1, 4, 8))
        changed = base.at[:, 0, 2].add(20).at[:, 3, 0].add(20)
        self.assertAlmostEqual(
            supervised_loss(lambda _: base, tokens, mask).item(),
            supervised_loss(lambda _: changed, tokens, mask).item(),
        )
        expected = nn.losses.cross_entropy(base[:, 1:3], tokens[:, 2:4]).mean().item()
        self.assertAlmostEqual(supervised_loss(lambda _: base, tokens, mask).item(), expected)

    def test_real_accumulation_matches_combined_token_weighted_gradients(self):
        import mlx.core as mx
        import mlx.nn as nn
        import mlx.optimizers as optim
        from mlx.utils import tree_flatten

        class TinyLogits(nn.Module):
            def __init__(self):
                super().__init__()
                self.embedding = nn.Embedding(8, 8)

            def __call__(self, tokens):
                return self.embedding(tokens)

        mx.random.seed(42)
        accumulated, combined = TinyLogits(), TinyLogits()
        combined.load_weights(tree_flatten(accumulated.parameters()))
        first, second = optim.SGD(learning_rate=0.1), optim.SGD(learning_rate=0.1)
        examples = [
            EncodedExample((1, 2, 3), (False, False, True), 1),
            EncodedExample((1, 3, 4, 5, 6), (False, True, True, True, True), 2),
            EncodedExample((2, 4, 6, 3), (False, False, True, True), 3),
            EncodedExample((2, 1, 5), (False, True, True), 4),
            EncodedExample((1, 5, 3, 2, 6, 4), (False, True, True, True, True, True), 5),
        ]
        for group in accumulation_groups(examples, 2, 2):
            actual_loss, count = optimizer_update(
                accumulated, first, nn.value_and_grad(accumulated, supervised_loss), group, 0
            )
            expected_loss, expected_count = optimizer_update(
                combined, second, nn.value_and_grad(combined, supervised_loss),
                [[example for batch in group for example in batch]], 0,
            )
            self.assertEqual(count, expected_count)
            self.assertAlmostEqual(actual_loss, expected_loss, places=6)
            self.assertTrue(mx.allclose(
                accumulated.embedding.weight, combined.embedding.weight,
                rtol=1e-6, atol=1e-7,
            ).item())
        self.assertEqual(first.step.item(), 2)
        self.assertEqual(second.step.item(), 2)
        # Entire holdout is evaluated even when batchSize exceeds holdout size.
        loss = evaluate(accumulated, examples[:1], 20, 0)
        self.assertTrue(math.isfinite(loss))

    def test_custom_model_configs_are_rejected_before_execution(self):
        original = json.loads((self.model_path / "config.json").read_text())
        with tempfile.TemporaryDirectory(dir=TRAINING) as directory:
            path = Path(directory)
            for patch in (
                {"model_file": "custom.py"}, {"auto_map": {"AutoModel": "custom.Model"}},
                {"model_type": "../custom"}, {"vision_config": {"hidden_size": 4}},
            ):
                (path / "config.json").write_text(json.dumps({**original, **patch}))
                with self.subTest(patch=patch), self.assertRaises(ValueError):
                    validated_model_config(path)

    def make_job(self, directory, **recipe_overrides):
        directory = Path(directory)
        job_directory = directory / "job"
        job_directory.mkdir()
        source = directory / "data" / "original.jsonl"
        source.parent.mkdir()
        shutil.copyfile(self.fixture["datasetPath"], source)
        (directory / "adapters").mkdir(mode=0o700)
        job = {
            "version": 1, "jobId": "unittest-real-worker",
            "run": {"id": "test", "name": "Real fixture", "recipe": {
                "method": "lora", "programId": "fixture", "datasetId": "fixture",
                "student": "random-fixture", "teacher": None, "rank": 2,
                "alpha": 4, "learningRate": 0.01, "epochs": 1,
                "batchSize": 2, "accumulation": 3, "maxSequence": 96,
                "outputPath": str(directory / "external-do-not-create"),
                "objective": "supervised", **recipe_overrides,
            }},
            "dataset": {
                "id": "fixture", "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "records": 9, "format": "messages", "kind": "curated",
                "teacher": None, "holdout": 25,
            },
            "sourcePath": str(source), "modelPath": str(self.model_path),
            "outputPath": str(directory / "adapters"),
        }
        path = job_directory / "job.json"
        path.write_text(json.dumps(job))
        return path, job

    def test_real_worker_distillation_plain_format_with_open_parent_pipe(self):
        from transformers import AutoTokenizer

        with tempfile.TemporaryDirectory(dir=TRAINING) as directory:
            path, job = self.make_job(directory, method="distillation", batchSize=20, accumulation=5)
            local_model = Path(directory) / "plain-model"
            shutil.copytree(self.model_path, local_model)
            (local_model / "chat_template.jinja").unlink()
            tokenizer = AutoTokenizer.from_pretrained(
                local_model, trust_remote_code=False, local_files_only=True
            )
            self.assertIsNone(tokenizer.chat_template)
            source = Path(directory) / "original.jsonl"
            source.write_text("".join(
                json.dumps({"prompt": f"Say {i}.", "response": str(i)}) + "\n"
                for i in range(9)
            ))
            original = source.read_bytes()
            job["modelPath"] = str(local_model)
            job["sourcePath"] = str(source)
            job["dataset"].update({
                "format": "prompt-response", "kind": "teacher-generated",
                "teacher": "pre-generated-only", "sha256": hashlib.sha256(original).hexdigest(),
            })
            job["run"]["recipe"]["teacher"] = "pre-generated-only"
            path.write_text(json.dumps(job))
            with tempfile.TemporaryFile(mode="w+") as stdout, tempfile.TemporaryFile(mode="w+") as stderr:
                process = subprocess.Popen(
                    [sys.executable, "-u", str(TRAINING / "mlx_runner.py"), str(path)],
                    stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, text=True,
                )
                try:
                    result = process.wait(timeout=60)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    process.stdin.close()
                stdout.seek(0)
                stderr.seek(0)
                self.assertEqual(result, 0, stderr.read())
                events = []
                for line in stdout:
                    self.assertTrue(line.startswith("MAMASE_EVENT "))
                    events.append(json.loads(line[13:]))
            self.assertEqual(events[-1], {"type": "complete"})
            progress = [event for event in events if event["type"] == "progress"]
            self.assertEqual([event["step"] for event in progress], [0, 1, 1])
            self.assertTrue(math.isfinite(progress[-1]["evalLoss"]))
            self.assertEqual(source.read_bytes(), original)
            self.assertFalse(Path(job["run"]["recipe"]["outputPath"]).exists())
            self.assertGreater((Path(job["outputPath"]) / "adapters.safetensors").stat().st_size, 0)
            self.assertEqual(len((source.parent / "train.jsonl").read_text().splitlines()), 7)
            self.assertEqual(len((source.parent / "valid.jsonl").read_text().splitlines()), 2)
            self.assertFalse((path.parent / "train.jsonl").exists())
            self.assertEqual(
                json.loads((Path(job["outputPath"]) / "adapter_config.json").read_text()),
                {
                    "fine_tune_type": "lora", "num_layers": 2,
                    "lora_parameters": {"rank": 2, "scale": 2.0, "dropout": 0.0},
                    "model": str(local_model),
                },
            )

    def test_real_worker_rejects_tampered_source_and_existing_output(self):
        with tempfile.TemporaryDirectory(dir=TRAINING) as directory:
            path, job = self.make_job(directory)
            original = path.read_text()
            job["dataset"]["sha256"] = "0" * 64
            path.write_text(json.dumps(job))
            command = [
                sys.executable, "-u", str(TRAINING / "mlx_runner.py"), "--standalone", str(path)
            ]
            result = subprocess.run(command, capture_output=True, text=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SHA-256 mismatch", result.stderr)
            self.assertNotIn('"type": "complete"', result.stdout)
            self.assertEqual(list(Path(job["outputPath"]).iterdir()), [])
            path.write_text(original)
            output = Path(job["outputPath"])
            sentinel = output / "owned-by-someone-else"
            sentinel.write_text("must not change")
            result = subprocess.run(command, capture_output=True, text=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("new or empty", result.stderr)
            self.assertEqual(sentinel.read_text(), "must not change")
            self.assertEqual(list(output.iterdir()), [sentinel])

    def test_manifest_rejects_unsupported_adapter_techniques(self):
        for adapter in ("rslora", "dora", "qlora"):
            with self.subTest(adapter=adapter), tempfile.TemporaryDirectory(dir=TRAINING) as directory:
                path, job = self.make_job(directory, adapter=adapter)
                with self.assertRaisesRegex(ValueError, "Managed MLX supports LoRA only"):
                    read_job(path)
                self.assertEqual(list(Path(job["outputPath"]).iterdir()), [])

    def test_resolve_parent_directory_alias_but_reject_symlink_output(self):
        with tempfile.TemporaryDirectory(dir=TRAINING) as directory:
            path, job = self.make_job(directory)
            real = Path(directory) / "real"
            real.mkdir()
            alias = Path(directory) / "alias"
            alias.symlink_to(real, target_is_directory=True)
            job["outputPath"] = str(alias / "adapters")
            path.write_text(json.dumps(job))
            self.assertEqual(read_job(path)[-1], real / "adapters")
            leaf = Path(directory) / "leaf-link"
            leaf.symlink_to(real, target_is_directory=True)
            job["outputPath"] = str(leaf)
            path.write_text(json.dumps(job))
            with self.assertRaisesRegex(ValueError, "must not be a symlink"):
                read_job(path)

    def test_real_worker_cancellation_during_loading_never_finalizes(self):
        for action in ("stdin-eof", "sigterm"):
            with self.subTest(action=action), tempfile.TemporaryDirectory(dir=TRAINING) as directory:
                path, job = self.make_job(directory)
                process = subprocess.Popen(
                    [sys.executable, "-u", str(TRAINING / "mlx_runner.py"), str(path)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    # Unbuffered reads ensure select observes every log record.
                    bufsize=0,
                )
                collected = b""
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stdout, selectors.EVENT_READ)
                        while b"Loading local MLX model" not in collected:
                            self.assertTrue(selector.select(timeout=10), "Worker did not reach loading")
                            chunk = process.stdout.read(4096)
                            self.assertTrue(chunk, "Worker exited before loading")
                            collected += chunk
                    if action == "stdin-eof":
                        process.stdin.close()
                        expected = 143
                    else:
                        process.send_signal(signal.SIGTERM)
                        expected = -signal.SIGTERM
                    self.assertEqual(process.wait(timeout=5), expected)
                    collected += process.stdout.read()
                    self.assertNotIn(b'"type": "complete"', collected)
                    self.assertFalse((Path(job["outputPath"]) / "adapters.safetensors").exists())
                    self.assertFalse((Path(job["outputPath"]) / "adapter_config.json").exists())
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    for stream in (process.stdin, process.stdout, process.stderr):
                        stream.close()


class ParentLivenessTests(unittest.TestCase):
    def test_finished_monitor_exits_cleanly_with_open_stdin_or_late_eof(self):
        code = (
            "from training.mlx_runner import monitor_parent; import time; "
            "finish = monitor_parent(); finish(); "
            "print('finalized', flush=True); time.sleep(0.2); print('clean exit', flush=True)"
        )
        for close_stdin in (False, True):
            with self.subTest(close_stdin=close_stdin):
                process = subprocess.Popen(
                    [sys.executable, "-u", "-c", code], cwd=ROOT,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                try:
                    self.assertEqual(process.stdout.readline().strip(), "finalized")
                    if close_stdin:
                        process.stdin.close()
                    self.assertEqual(process.wait(timeout=5), 0)
                    self.assertEqual(process.stdout.read().strip(), "clean exit")
                    self.assertEqual(process.stderr.read(), "")
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    for stream in (process.stdin, process.stdout, process.stderr):
                        stream.close()

    def test_stdin_eof_terminates_monitor_during_blocking_work(self):
        code = (
            "from training.mlx_runner import monitor_parent; import time; "
            "monitor_parent(); print('ready', flush=True); time.sleep(60)"
        )
        process = subprocess.Popen(
            [sys.executable, "-u", "-c", code], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            self.assertEqual(process.stdout.readline().strip(), "ready")
            process.stdin.close()
            self.assertEqual(process.wait(timeout=5), 143)
            self.assertIn("Parent stdin closed", process.stderr.read())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

    def test_real_entrypoint_closed_pipe_never_completes(self):
        process = subprocess.run(
            [sys.executable, "-u", str(TRAINING / "mlx_runner.py"), "/nonexistent/job.json"],
            input="", capture_output=True, text=True, timeout=10,
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertNotIn('"type": "complete"', process.stdout)

    def test_sigterm_is_default_and_prompt(self):
        process = subprocess.Popen(
            [sys.executable, "-u", "-c",
             "from training.mlx_runner import monitor_parent; import time; "
             "monitor_parent(); print('ready', flush=True); time.sleep(60)"],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(process.stdout.readline().strip(), "ready")
            process.send_signal(signal.SIGTERM)
            self.assertEqual(process.wait(timeout=5), -signal.SIGTERM)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()


if __name__ == "__main__":
    unittest.main()
