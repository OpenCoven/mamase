"""Synthetic, local-only preflight checks launched by Node's existing test runner."""

import argparse
import contextlib
import copy
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
REAL = "--real" in sys.argv
if REAL:
    sys.argv.remove("--real")

from training import preflight as pf
from training import train


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_bundle(root):
    identity = root / "fixture"
    identity.mkdir()
    (identity / "IDENTITY.md").write_text("- **Name:** Fixture\n", encoding="utf-8")
    (identity / "SOUL.md").write_text("Synthetic fixture only. Preserve consent.\n", encoding="utf-8")
    recipe = {
        "method": "lora", "adapter": "lora", "familiarId": "fixture", "instanceId": "test-instance",
        "student": "synthetic-base-label", "teacher": "", "rank": 4, "alpha": 8, "learningRate": 0.001,
        "epochs": 1, "batchSize": 1, "accumulation": 1, "maxSequence": 512,
    }
    dataset = {"sha256": "a" * 64, "kind": "supervised"}
    bundle_dir = root / "bundle"
    bundle_dir.mkdir()
    files = {name: {"path": str(identity / name), "sha256": digest(identity / name),
                    "content": (identity / name).read_text()} for name in ("IDENTITY.md", "SOUL.md")}
    write_json(bundle_dir / "identity.json", {"familiarId": "fixture", "instanceId": "test-instance", "files": files})
    canonical = f'Coven instance: test-instance\nFamiliar ID: fixture\n\n{files["IDENTITY.md"]["content"]}\n\n{files["SOUL.md"]["content"]}'
    for split in ("train", "holdout"):
        row = {"prompt": [{"role": "system", "content": canonical}, {"role": "user", "content": split + " question"}],
               "completion": [{"role": "assistant", "content": "Synthetic answer"}]}
        (bundle_dir / f"{split}.jsonl").write_text(json.dumps(row) + "\n", encoding="utf-8")
    write_json(bundle_dir / "recipe.json", {"runId": "run-fixture", "recipe": recipe, "dataset": dataset})
    bundle = {
        "schema": "mamase.local-bundle.v1", "runId": "run-fixture", "recipe": recipe, "dataset": dataset,
        "identity": {"familiarId": "fixture", "instanceId": "test-instance", "workspace": str(identity)},
        "split": {"train": 1, "holdout": 1}, "execution": "not-started", "promotion": "not-authorized",
    }
    refresh_bundle(bundle_dir, bundle)
    return bundle_dir


def refresh_bundle(directory, bundle=None):
    if bundle is None:
        bundle = json.loads((directory / "bundle.json").read_text())
    bundle["files"] = {name: digest(directory / name) for name in ("train.jsonl", "holdout.jsonl", "identity.json", "recipe.json")}
    write_json(directory / "bundle.json", bundle)


def change_recipe(directory, **changes):
    bundle = json.loads((directory / "bundle.json").read_text())
    manifest = json.loads((directory / "recipe.json").read_text())
    bundle["recipe"].update(changes)
    manifest["recipe"].update(changes)
    write_json(directory / "recipe.json", manifest)
    refresh_bundle(directory, bundle)


def make_header(path, name="fixture.weight"):
    raw = json.dumps({name: {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}).encode()
    raw += b" " * (-len(raw) % 8)
    path.write_bytes(struct.pack("<Q", len(raw)) + raw + struct.pack("<f", 0))


def make_model_metadata(root):
    model = root / "model"
    model.mkdir()
    write_json(model / "config.json", {"model_type": "llama", "max_position_embeddings": 512})
    write_json(model / "tokenizer_config.json", {"tokenizer_class": "PreTrainedTokenizerFast"})
    make_header(model / "model.safetensors")
    return model


class Sources(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory(prefix="mamase-preflight-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.bundle = make_bundle(self.root)
        self.model = make_model_metadata(self.root)

    def test_valid_bundle_and_header_inventory(self):
        bundle, rows = pf.prepared_bundle(self.bundle)
        self.assertEqual(bundle["runId"], "run-fixture")
        self.assertEqual(len(rows["holdout"]), 1)
        config, inventory = pf.model_inventory(self.model)
        self.assertEqual(config["model_type"], "llama")
        self.assertEqual(inventory["tensorElements"], 1)
        self.assertEqual(inventory["weights"]["model.safetensors"]["path"], str(self.model / "model.safetensors"))
        self.assertEqual(inventory["metadataSha256"]["config.json"], digest(self.model / "config.json"))
        self.assertIn("neither read nor hashed", inventory["identityScope"])
        self.assertTrue(pf.unused_bundle(self.bundle))

    def test_corrupt_bundle_and_changed_live_identity(self):
        path = self.root / "fixture/SOUL.md"
        original = path.read_bytes()
        path.write_text("Changed synthetic identity")
        with self.assertRaisesRegex(ValueError, "Familiar identity changed"):
            pf.prepared_bundle(self.bundle)
        path.write_bytes(original)
        (self.bundle / "train.jsonl").write_text("{}")
        with self.assertRaisesRegex(ValueError, "fingerprint mismatch"):
            pf.prepared_bundle(self.bundle)
        write_json(self.bundle / "bundle.json", [])
        with self.assertRaisesRegex(ValueError, "JSON object"):
            pf.prepared_bundle(self.bundle)

    def test_invalid_recipe_and_existing_outputs(self):
        for changes in ({"adapter": "mlx"}, {"rank": 5}, {"epochs": True},
                        {"learningRate": float("nan")}, {"maxSequence": 0}):
            with self.subTest(changes=changes):
                original = {name: (self.bundle / name).read_bytes() for name in ("bundle.json", "recipe.json")}
                change_recipe(self.bundle, **changes)
                with self.assertRaises(ValueError):
                    pf.prepared_bundle(self.bundle)
                for name, content in original.items():
                    (self.bundle / name).write_bytes(content)
        for name in ("training.lock", "adapter", "checkpoints", "run-report.json", "result.json"):
            path = self.bundle / name
            path.write_text("existing evidence")
            with self.assertRaisesRegex(ValueError, name.replace(".", r"\.")):
                pf.unused_bundle(self.bundle)
            self.assertEqual(path.read_text(), "existing evidence")
            path.unlink()

    def test_bad_sources_and_unsafe_code_metadata(self):
        for change in ({"auto_map": {"AutoModel": "custom.Model"}}, {"model_file": "custom.py"},
                       {"quantization": {"bits": 4}}, {"quantization_config": {"load_in_4bit": True}},
                       {"vision_config": {"hidden_size": 1}}, {"is_encoder_decoder": True}):
            with self.subTest(change=change):
                write_json(self.model / "config.json", {"model_type": "llama", **change})
                with self.assertRaises(ValueError):
                    pf.model_inventory(self.model)
        write_json(self.model / "config.json", {"model_type": "llama"})
        write_json(self.model / "tokenizer_config.json", {"auto_map": {"AutoTokenizer": "custom.Tokenizer"}})
        with self.assertRaisesRegex(ValueError, "custom auto_map"):
            pf.model_inventory(self.model)
        write_json(self.model / "tokenizer_config.json", {})
        (self.model / "adapter_config.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "adapter/redirect"):
            pf.model_inventory(self.model)
        (self.model / "adapter_config.json").unlink()
        (self.model / "model.safetensors").write_bytes(b"broken")
        with self.assertRaisesRegex(ValueError, "header"):
            pf.model_inventory(self.model)
        make_header(self.model / "model.safetensors")
        with (self.model / "model.safetensors").open("ab") as stream:
            stream.write(b"trailing")
        with self.assertRaisesRegex(ValueError, "unaccounted"):
            pf.model_inventory(self.model)
        (self.model / "model.safetensors").unlink()
        (self.model / "pytorch_model.bin").write_bytes(b"never unpickle")
        with self.assertRaisesRegex(ValueError, "pickle"):
            pf.model_inventory(self.model)

    def test_shard_inventory_and_local_symlinks(self):
        weight = self.model / "model.safetensors"
        blob = self.root / "synthetic-blob"
        weight.rename(blob)
        (self.model / "model-00001.safetensors").symlink_to(blob)
        index = self.model / "model.safetensors.index.json"
        write_json(index, {"weight_map": {"fixture.weight": "model-00001.safetensors"}})
        _, facts = pf.model_inventory(self.model)
        self.assertEqual(facts["weights"]["model-00001.safetensors"]["path"], str(blob))
        for mapping in ({"fixture.weight": "../synthetic-blob"}, {"fixture.weight": "missing.safetensors"},
                        {"wrong.weight": "model-00001.safetensors"}):
            write_json(index, {"weight_map": mapping})
            with self.subTest(mapping=mapping), self.assertRaises((ValueError, FileNotFoundError)):
                pf.model_inventory(self.model)

    def test_shared_mlx_metadata_guards_stay_read_only(self):
        from training.mlx_runner import validated_model_config
        original = json.loads((self.model / "config.json").read_text())
        self.assertEqual(validated_model_config(self.model), {**original, "model_file": None})
        for changes in ({"model_file": "custom.py"}, {"auto_map": {"AutoModel": "custom.Model"}},
                        {"model_type": "../custom"}, {"vision_config": {"hidden_size": 4}}):
            write_json(self.model / "config.json", {**original, **changes})
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validated_model_config(self.model)
        write_json(self.model / "config.json", original)
        self.assertNotIn("mlx", sys.modules)
        self.assertNotIn("mlx_lm", sys.modules)

    def test_missing_dependencies_and_device_probes(self):
        report = pf.Report()
        with patch.object(importlib.metadata, "version", side_effect=importlib.metadata.PackageNotFoundError("synthetic")):
            self.assertIsNone(pf.dependencies(report, "qlora"))
        self.assertEqual(len(report.value["errors"]), len(train.TRAINING_PACKAGES) + 1)
        self.assertTrue(all(item["code"] == "dependencies.missing" for item in report.value["errors"]))
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False),
                                backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)))
        for adapter, device, message in (("lora", "metal", "Unsupported"), ("lora", "mps", "MPS"),
                                         ("lora", "cuda", "CUDA"), ("qlora", "cpu", "QLoRA")):
            with self.subTest(device=device), self.assertRaisesRegex(ValueError, message):
                pf.device_facts(torch, adapter, device)
        with patch.dict(os.environ, {"WORLD_SIZE": "2"}), self.assertRaisesRegex(ValueError, "distributed"):
            pf.device_facts(torch, "lora", "cpu")
        torch.cuda = SimpleNamespace(is_available=lambda: True, current_device=lambda: 0,
                                     get_device_capability=lambda _: (5, 0), get_device_name=lambda _: "Synthetic CUDA")
        with patch.object(importlib.metadata, "version", return_value="fixture"), self.assertRaisesRegex(ValueError, "Pascal"):
            pf.device_facts(torch, "qlora", "cuda")
        report = pf.Report()
        with patch.object(importlib.metadata, "version", return_value="fixture"), patch.object(importlib, "import_module", side_effect=ImportError("incompatible installation")):
            self.assertIsNone(pf.dependencies(report, "lora"))
        self.assertEqual(report.value["errors"][0]["code"], "dependencies.import")

    def test_cli_reports_errors_as_json_without_site_packages_or_writes(self):
        before = {str(path.relative_to(self.root)): digest(path) for path in self.root.rglob("*") if path.is_file()}
        result = subprocess.run([sys.executable, "-B", "-S", str(ROOT / "training/preflight.py"),
                                 "--bundle", str(self.bundle), "--model", str(self.model), "--device", "metal"],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1, result.stderr)
        report = json.loads(result.stdout)
        self.assertFalse(report["ready"])
        self.assertEqual(report["schema"], "mamase.preflight.v1")
        self.assertIn("device.unsupported", [item["code"] for item in report["errors"]])
        self.assertIn("dependencies.missing", [item["code"] for item in report["errors"]])
        self.assertIn("model", report["facts"])
        self.assertTrue(report["skipped"])
        self.assertEqual(before, {str(path.relative_to(self.root)): digest(path) for path in self.root.rglob("*") if path.is_file()})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = pf.main([])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue())["errors"][0]["code"], "arguments.invalid")
        change_recipe(self.bundle, adapter="qlora")
        args = argparse.Namespace(bundle=str(self.bundle), model=str(self.model), device="cpu")
        with patch.object(importlib.metadata, "version", side_effect=importlib.metadata.PackageNotFoundError("synthetic")):
            report = pf.preflight(args)
        self.assertTrue(any(item["code"] == "device.constraints" and "QLoRA" in item["message"] for item in report["errors"]))


@unittest.skipUnless(REAL, "Real PEFT checks use the explicitly selected environment")
class LocalRuntime(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = TemporaryDirectory(prefix="mamase-preflight-real-")
        cls.root = Path(cls.directory.name).resolve()
        cls.model = cls.root / "model"
        result = subprocess.run([sys.executable, "-B", str(ROOT / "tests/training_fixture.py"), "create", str(cls.model)],
                                capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise AssertionError(result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        self.directory = TemporaryDirectory(prefix="mamase-preflight-case-")
        self.addCleanup(self.directory.cleanup)
        self.case = Path(self.directory.name).resolve()
        self.bundle = make_bundle(self.case)
        self.args = argparse.Namespace(bundle=str(self.bundle), model=str(self.model), device="cpu")

    def test_real_readiness_all_adapter_configs_and_cli(self):
        for technique in ("lora", "rslora", "dora"):
            change_recipe(self.bundle, adapter=technique)
            report = pf.preflight(self.args)
            self.assertTrue(report["ready"], report["errors"])
            self.assertEqual(report["facts"]["adapter"]["technique"], technique)
            self.assertEqual(report["facts"]["device"]["requested"], "cpu")
            self.assertGreater(report["facts"]["tokens"]["holdout"]["completionTokens"], 0)
        result = subprocess.run([sys.executable, "-B", str(ROOT / "training/preflight.py"),
                                 "--bundle", str(self.bundle), "--model", str(self.model), "--device", "cpu"],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(json.loads(result.stdout)["ready"])
        change_recipe(self.bundle, adapter="qlora")
        report = pf.preflight(self.args)
        self.assertFalse(report["ready"])

    def test_actual_template_and_context_failures(self):
        original = pf.load_local_tokenizer(self.model)
        for template in ("", "{{ 'fixed' }}", "{{ raise_exception('system roles unsupported') }}",
                         "{% for m in messages if m['role'] != 'system' %}{{ '[' + m['role'] + '] ' + m['content'] + '\\n' }}{% endfor %}{% if add_generation_prompt %}{{ '[assistant] ' }}{% endif %}",
                         "{% for m in messages %}{{ m['content'] }}{% endfor %}{{ 'unstable' if add_generation_prompt else 'different' }}"):
            tokenizer = copy.deepcopy(original)
            tokenizer.chat_template = template
            with self.subTest(template=template), patch.object(pf, "load_local_tokenizer", return_value=tokenizer):
                report = pf.preflight(self.args)
                self.assertFalse(report["ready"])
                self.assertIn("tokens.invalid", [item["code"] for item in report["errors"]])
        change_recipe(self.bundle, maxSequence=1024)
        self.assertIn("context.overflow", [item["code"] for item in pf.preflight(self.args)["errors"]])
        change_recipe(self.bundle, maxSequence=128)
        for split in ("train", "holdout"):
            path = self.bundle / f"{split}.jsonl"
            original = path.read_text()
            row = json.loads(original)
            row["completion"][0]["content"] = "observed " * 600
            path.write_text(json.dumps(row) + "\n")
            refresh_bundle(self.bundle)
            report = pf.preflight(self.args)
            self.assertFalse(report["ready"])
            self.assertTrue(any(split + " example 1" in item["message"] and "never silently truncated" in item["message"] for item in report["errors"]))
            path.write_text(original)
            refresh_bundle(self.bundle)

    def test_templates_may_trim_surrounding_whitespace_but_not_rewrite_content(self):
        tokenizer = pf.load_local_tokenizer(self.model)
        tokenizer.chat_template = "{% for m in messages %}{{ '[' + m['role'] + '] ' + (m['content'] | trim) + '\\n' }}{% endfor %}{% if add_generation_prompt %}{{ '[assistant] ' }}{% endif %}"
        _, rows = pf.prepared_bundle(self.bundle)
        for split, examples in rows.items():
            for row in examples:
                row["prompt"][-1]["content"] = " \t" + row["prompt"][-1]["content"] + " \n"
                row["completion"][0]["content"] = " \t" + row["completion"][0]["content"] + " \n"
            (self.bundle / f"{split}.jsonl").write_text("".join(json.dumps(row) + "\n" for row in examples))
        refresh_bundle(self.bundle)
        with patch.object(pf, "load_local_tokenizer", return_value=tokenizer):
            report = pf.preflight(self.args)
        self.assertTrue(report["ready"], report["errors"])
        encoded = train.tokenize_rows(rows["train"], tokenizer, 512)
        normalized = copy.deepcopy(rows["train"])
        for row in normalized:
            for message in row["prompt"] + row["completion"]:
                message["content"] = message["content"].strip()
        self.assertEqual(encoded, train.tokenize_rows(normalized, tokenizer, 512))
        for content in ("Preserve consent.", "Synthetic answer"):
            rewritten = copy.deepcopy(tokenizer)
            rewritten.chat_template = tokenizer.chat_template.replace(
                "m['content'] | trim", f"m['content'] | replace('{content}', 'changed') | trim")
            with self.subTest(content=content), self.assertRaisesRegex(ValueError, "drops or rewrites"):
                train.tokenize_rows(rows["train"], rewritten, 512)

    def test_invalid_serialized_tokenizers_are_cli_blockers_not_tracebacks(self):
        model = self.case / "invalid-model"
        model.mkdir()
        for path in self.model.iterdir():
            if path.name != "tokenizer.json":
                (model / path.name).symlink_to(path)
        serialized = json.loads((self.model / "tokenizer.json").read_text())
        serialized["version"] = "invalid"
        for content in (json.dumps(serialized), "{"):
            with self.subTest(content=content[:80]):
                (model / "tokenizer.json").write_text(content)
                result = subprocess.run([sys.executable, "-B", str(ROOT / "training/preflight.py"),
                                         "--bundle", str(self.bundle), "--model", str(model), "--device", "cpu"],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertTrue(result.stdout, result.stderr)
                report = json.loads(result.stdout)
                self.assertEqual(report["schema"], "mamase.preflight.v1")
                self.assertFalse(report["ready"])
                self.assertTrue(any(item["code"] == "tokenizer.invalid" and item["message"]
                                    for item in report["errors"]))
                self.assertNotIn("Traceback", result.stderr)
                self.assertTrue(pf.unused_bundle(self.bundle))

    def test_tokenizer_loader_preserves_typed_unexpected_errors(self):
        from transformers import AutoTokenizer
        for error in (AssertionError("unexpected assertion"), RuntimeError("unexpected runtime failure")):
            with self.subTest(error=type(error).__name__), patch.object(AutoTokenizer, "from_pretrained", side_effect=error):
                with self.assertRaises(type(error)) as raised:
                    train.load_local_tokenizer(self.model)
                self.assertIs(raised.exception, error)

    def test_unknown_context_and_mismatched_tokenizer_vocabulary(self):
        from transformers import AutoConfig
        config = AutoConfig.from_pretrained(self.model, local_files_only=True, trust_remote_code=False)
        config.max_position_embeddings = 0
        with patch.object(AutoConfig, "from_pretrained", return_value=config):
            report = pf.preflight(self.args)
        self.assertTrue(any("unknown context budget" in item["message"] for item in report["errors"]))
        tokenizer = pf.load_local_tokenizer(self.model)
        with patch.object(tokenizer, "get_vocab", return_value={"bad": config.vocab_size}), patch.object(pf, "load_local_tokenizer", return_value=tokenizer):
            report = pf.preflight(self.args)
        self.assertTrue(any("vocab_size" in item["message"] for item in report["errors"]))

    def test_shared_helpers_preserve_actual_cpu_training_and_evaluation(self):
        # This separate regression deliberately trains a tiny random fixture.
        # The guarded preflight test below must never take this path.
        for technique in ("lora", "rslora", "dora", "distillation"):
            with self.subTest(technique=technique):
                root = self.case / technique
                root.mkdir()
                bundle = make_bundle(root)
                if technique == "distillation":
                    change_recipe(bundle, method="distillation", teacher="synthetic-teacher")
                    record = json.loads((bundle / "bundle.json").read_text())
                    manifest = json.loads((bundle / "recipe.json").read_text())
                    for value in (record, manifest):
                        value["dataset"].update(kind="teacher", teacher="synthetic-teacher")
                    write_json(bundle / "recipe.json", manifest)
                    refresh_bundle(bundle, record)
                else:
                    change_recipe(bundle, adapter=technique)
                result = subprocess.run([sys.executable, "-B", str(ROOT / "training/train.py"),
                                         "--bundle", str(bundle), "--model", str(self.model), "--device", "cpu"],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
                trained = json.loads((bundle / "result.json").read_text())
                self.assertEqual(trained["optimizerSteps"], 1)
                self.assertEqual(trained["promotion"], "not-authorized")
                self.assertEqual(trained["adapter"]["technique"], "lora" if technique == "distillation" else technique)
                self.assertEqual(json.loads((bundle / "run-report.json").read_text())["updates"][-1]["status"], "completed")
                if technique == "lora":
                    suite = root / "suite.json"
                    write_json(suite, {
                        "schema": "mamase.eval-suite.v1", "name": "Synthetic regression", "version": "1",
                        "cases": [{"id": category, "category": category, "prompt": "Independent " + category,
                                   "checks": [{"type": "not_contains", "value": "impossible-marker"}]}
                                  for category in ("task", "identity", "consent", "tool-boundary")],
                    })
                    evaluated = subprocess.run([sys.executable, "-B", str(ROOT / "training/evaluate.py"),
                                                "--bundle", str(bundle), "--suite", str(suite),
                                                "--out", str(root / "evaluation"), "--device", "cpu", "--max-new-tokens", "2"],
                                               capture_output=True, text=True, timeout=60)
                    self.assertEqual(evaluated.returncode, 0, evaluated.stderr)
                    self.assertEqual(json.loads((root / "evaluation/evaluation-report.json").read_text())["promotion"], "not-authorized")

    def test_no_model_weight_payload_training_network_pickle_or_filesystem_mutation(self):
        import pickle
        import socket
        import torch
        import transformers
        import peft
        import safetensors
        import safetensors.torch
        from training import mlx_runner

        active = [False]
        forbidden_events = {"os.mkdir", "os.remove", "os.rename", "os.rmdir", "os.link", "os.symlink",
                            "os.chmod", "os.truncate", "subprocess.Popen", "os.system", "socket.connect", "socket.getaddrinfo"}

        def audit(event, args):
            if not active[0]:
                return
            if event in forbidden_events:
                raise AssertionError(f"Preflight attempted forbidden side effect: {event}")
            if event == "open":
                _, mode, flags = args
                if (mode and any(c in mode for c in "wax+")) or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
                    raise AssertionError("Preflight attempted a filesystem write")

        sys.addaudithook(audit)
        original_open = Path.open

        class HeaderOnly:
            def __init__(self, stream, limit):
                self.stream, self.limit = stream, limit
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def read(self, count=-1):
                if count < 0 or self.stream.tell() + count > self.limit:
                    raise AssertionError("Preflight read a tensor payload")
                return self.stream.read(count)

        def header_open(path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            if path.suffix == ".safetensors":
                header_length = struct.unpack("<Q", stream.read(8))[0]
                stream.seek(0)
                return HeaderOnly(stream, header_length + 8)
            return stream

        prohibited = [
            (train, "train"), (train, "load_local_model"), (mlx_runner, "run"), (mlx_runner, "load_local_model"),
            (transformers.AutoModelForCausalLM, "from_pretrained"), (transformers.PreTrainedModel, "__init__"),
            (transformers.Trainer, "__init__"), (transformers.TrainingArguments, "__post_init__"),
            (torch.optim.Optimizer, "__init__"), (peft, "get_peft_model"), (torch, "load"),
            (safetensors, "safe_open"), (safetensors.torch, "load_file"),
            (pickle, "load"), (pickle, "loads"), (socket.socket, "connect"),
            (socket.socket, "connect_ex"), (socket, "create_connection"),
        ]
        before = {str(path): digest(path) for root in (self.case, self.model) for path in root.rglob("*") if path.is_file()}
        with contextlib.ExitStack() as stack:
            for owner, name in prohibited:
                stack.enter_context(patch.object(owner, name, side_effect=AssertionError(f"Forbidden: {name}")))
            stack.enter_context(patch.object(Path, "open", header_open))
            active[0] = True
            try:
                report = pf.preflight(self.args)
            finally:
                active[0] = False
        self.assertTrue(report["ready"], report["errors"])
        after = {str(path): digest(path) for root in (self.case, self.model) for path in root.rglob("*") if path.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(report["promotion"], "not-authorized")


if __name__ == "__main__":
    unittest.main(verbosity=2)
