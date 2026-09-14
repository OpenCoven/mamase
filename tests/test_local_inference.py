"""Isolated genuine MLX smoke: python -m unittest discover -s tests -p test_local_inference.py."""

import contextlib
import hashlib
import io
import json
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile
import unittest

from training.create_smoke_fixture import create_fixture
from training.mlx_runner import run as train
from training.mlx_infer import (
    InferenceError, encode_conversation, load_managed_model, run, validate_request,
)

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "training" / "mlx_infer.py"


class LocalInferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="mamase-real-inference-")
        cls.addClassCleanup(cls.directory.cleanup)
        cls.root = Path(cls.directory.name)
        fixture = create_fixture(cls.root / "fixture")
        cls.model = Path(fixture["modelPath"])
        cls.adapter = cls.root / "adapter"
        source = Path(fixture["datasetPath"])
        dataset = {
            "id": "data", "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "format": "messages", "records": 9, "holdout": 25,
        }
        recipe = {
            "method": "lora", "datasetId": "data", "rank": 4, "alpha": 8,
            "learningRate": 0.01, "epochs": 1, "batchSize": 2,
            "accumulation": 2, "maxSequence": 96,
        }
        manifest = cls.root / "job.json"
        manifest.write_text(json.dumps({
            "version": 1, "jobId": "job-inference-smoke",
            "run": {"id": "real-inference-smoke", "recipe": recipe},
            "dataset": dataset, "sourcePath": str(source),
            "modelPath": str(cls.model), "outputPath": str(cls.adapter),
        }))
        with contextlib.redirect_stdout(sys.stderr):
            train(manifest, io.StringIO())
        cls.request = {
            "jobId": "job-inference-smoke", "variant": "adapter",
            "messages": [{"role": "user", "content": "Say red."}],
            "temperature": 0, "maxTokens": 8, "seed": 42,
            "modelPath": str(cls.model), "adapterPath": str(cls.adapter),
        }

    def test_real_training_changes_logits_and_saved_adapters_are_applied(self):
        import mlx.core as mx

        base, tokenizer, config = load_managed_model({**self.request, "variant": "base"})
        adapted, _, _ = load_managed_model(self.request)
        prompt = encode_conversation(tokenizer, config, self.request)
        tokens = mx.array([prompt])
        base_logits = base(tokens).astype(mx.float32)
        adapted_logits = adapted(tokens).astype(mx.float32)
        self.assertGreater(mx.max(mx.abs(base_logits - adapted_logits)).item(), 0.00001)

    def test_actual_streamed_reply_for_base_and_adapter_and_seed_repeatability(self):
        for variant in ("base", "adapter"):
            request = {**self.request, "variant": variant, "temperature": 0.7}
            replies = []
            for _ in range(2):
                output = io.StringIO()
                run(request, output)
                events = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual(events[0], {"type": "status", "message": "loading"})
                self.assertEqual(events[1], {"type": "status", "message": "generating"})
                complete = events[-1]
                self.assertEqual(complete["type"], "complete")
                self.assertIn(complete["finishReason"], ("stop", "length"))
                self.assertGreater(complete["promptTokens"], 0)
                self.assertLessEqual(complete["generatedTokens"], 8)
                replies.append("".join(event["text"] for event in events if event["type"] == "token"))
            self.assertEqual(replies[0], replies[1])

    def test_worker_process_protocol_and_successful_exit(self):
        # communicate would close stdin early, intentionally activating EOF
        # cancellation. Keep it open until the process has exited.
        with subprocess.Popen(
            [sys.executable, "-u", str(WORKER)], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        ) as child:
            child.stdin.write((json.dumps(self.request) + "\n").encode())
            child.stdin.flush()
            self.assertEqual(child.wait(timeout=120), 0, child.stderr.read().decode())
            events = [json.loads(line) for line in child.stdout.read().splitlines()]
            self.assertEqual(events[-1]["type"], "complete")
            self.assertGreater(events[-1]["generatedTokens"], 0)

    def test_parent_eof_cancels_a_live_worker_without_completion(self):
        with subprocess.Popen(
            [sys.executable, "-u", str(WORKER)], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        ) as child:
            child.stdin.write((json.dumps(self.request) + "\n").encode())
            child.stdin.flush()
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=120), "Worker never started")
            self.assertEqual(json.loads(child.stdout.readline())["message"], "loading")
            child.stdin.close()
            self.assertNotEqual(child.wait(timeout=30), 0)
            self.assertNotIn(b'"type": "complete"', child.stdout.read())

    def test_native_context_and_input_budget_reject_without_truncating(self):
        _, tokenizer, config = load_managed_model(self.request)
        with self.assertRaisesRegex(InferenceError, "256-token context"):
            encode_conversation(tokenizer, config, {
                **self.request, "messages": [{"role": "user", "content": "x" * 250}],
            })

        class TooManyTokens:
            chat_template = "fixture"
            model_max_length = 1_000_000

            def apply_chat_template(self, messages, **kwargs):
                self.kwargs = kwargs
                return [1] * 8193

        fake = TooManyTokens()
        with self.assertRaisesRegex(InferenceError, "8192-token"):
            encode_conversation(fake, {}, self.request)
        self.assertFalse(fake.kwargs["truncation"])
        with self.assertRaisesRegex(InferenceError, "context"):
            encode_conversation(tokenizer, {"max_position_embeddings": 8}, self.request)

    def test_missing_and_unsupported_templates_are_not_replaced(self):
        _, tokenizer, config = load_managed_model(self.request)
        tokenizer.chat_template = None
        with self.assertRaisesRegex(InferenceError, "no chat template"):
            encode_conversation(tokenizer, config, self.request)
        tokenizer.chat_template = "{{ raise_exception(messages[0]['content']) }}"
        with self.assertRaises(InferenceError) as caught:
            encode_conversation(tokenizer, config, self.request)
        self.assertNotIn("Say red.", str(caught.exception))

    def test_partial_and_unrecognized_adapter_weights_cannot_be_ignored(self):
        import mlx.core as mx

        for mutation in ("missing", "extra"):
            destination = self.root / f"adapter-{mutation}"
            shutil.copytree(self.adapter, destination)
            weights = mx.load(str(destination / "adapters.safetensors"))
            if mutation == "missing":
                weights.pop(next(iter(weights)))
            else:
                weights["invented.lora_a"] = mx.ones((1, 1))
            mx.eval(weights)
            mx.save_safetensors(str(destination / "adapters.safetensors"), weights)
            with self.assertRaisesRegex(InferenceError, "tensor names"):
                load_managed_model({**self.request, "adapterPath": str(destination)})

    def test_worker_rejects_paths_remote_code_and_invalid_messages(self):
        with self.assertRaisesRegex(InferenceError, "absolute local"):
            load_managed_model({**self.request, "modelPath": "remote/model"})
        for key, value in (("seed", True), ("maxTokens", 0), ("temperature", float("nan")),
                           ("messages", [{"role": "user", "content": ["image"]}])):
            with self.subTest(key=key), self.assertRaises(InferenceError):
                validate_request({**self.request, key: value})
        destination = self.root / "custom-model"
        destination.mkdir()
        (destination / "config.json").write_text(json.dumps({"model_type": "llama", "model_file": "evil.py"}))
        (destination / "tokenizer_config.json").write_text("{}")
        with self.assertRaisesRegex(InferenceError, "without custom code"):
            load_managed_model({**self.request, "modelPath": str(destination)})


if __name__ == "__main__":
    unittest.main()
