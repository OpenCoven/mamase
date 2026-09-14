import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.MAMASE_TRAINING_PYTHON || join(root, ".venv/bin/python");

test("independent evaluation validates bounded suites, leakage, rules, and generation budgets", () => {
  const result = spawnSync(python, ["-c", `
import copy
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from training.evaluate import load_suite, validate_suite, score_response, prepare_prompts, context_limit, validate_max_new_tokens, write_report

categories = ("task", "identity", "consent", "tool-boundary")
suite = {
    "schema": "mamase.eval-suite.v1", "name": "Synthetic independent prompts", "version": "1",
    "cases": [{"id": category, "category": category, "prompt": "Independent " + category,
               "checks": [{"type": "contains", "value": "Cody"}]} for category in categories],
}
rows = {
    "train": [{"prompt": [{"role": "system", "content": "canonical identity"}, {"role": "user", "content": " training question "}, {"role": "assistant", "content": "prior answer"}, {"role": "user", "content": "followup question"}]}],
    "holdout": [{"prompt": [{"role": "system", "content": "canonical identity"}, {"role": "user", "content": " holdout question\\n"}]}],
}

class Tokenizer:
    chat_template = "synthetic"
    model_max_length = 10000
    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        return "".join(m["role"] + ":" + m["content"] + ";" for m in messages) + ("assistant:" if add_generation_prompt else "")
    def encode(self, text, add_special_tokens=False):
        return list(text.encode())

class EvaluationValidation(unittest.TestCase):
    def test_valid_suite_preserves_exact_strings(self):
        original = copy.deepcopy(suite)
        original["cases"][0]["prompt"] = "  Independent task\\n"
        original["cases"][0]["checks"][0]["value"] = " Cody "
        self.assertEqual(validate_suite(original, rows), original)
        with TemporaryDirectory() as directory:
            path = Path(directory) / "suite.json"
            source = json.dumps(original).encode() + b"\\n"
            path.write_bytes(source)
            parsed, digest = load_suite(path, rows)
            import hashlib
            self.assertEqual(parsed, original)
            self.assertEqual(digest, hashlib.sha256(source).hexdigest())
            path.write_bytes(b" " * (1024 * 1024 + 1))
            with self.assertRaisesRegex(ValueError, "1 MiB"):
                load_suite(path, rows)
            path.write_text('{"schema":"other","schema":"mamase.eval-suite.v1"}')
            with self.assertRaisesRegex(ValueError, "Duplicate JSON"):
                load_suite(path, rows)
            path.write_text(json.dumps(original)[:-1] + ', "extra": NaN}')
            with self.assertRaisesRegex(ValueError, "Non-finite JSON"):
                load_suite(path, rows)

    def test_invalid_suites(self):
        mutations = [
            lambda s: s.update(schema="other"),
            lambda s: s.update(name=" "),
            lambda s: s.update(name="x" * 101),
            lambda s: s.update(version=""),
            lambda s: s.update(version="x" * 81),
            lambda s: s.update(cases=s["cases"][:3]),
            lambda s: s.update(cases=s["cases"] * 51),
            lambda s: s["cases"][0].update(id="../bad"),
            lambda s: s["cases"][0].update(id="x" * 81),
            lambda s: s["cases"][0].update(id=s["cases"][1]["id"]),
            lambda s: s["cases"][0].update(category="judge"),
            lambda s: s["cases"][0].update(category="identity"),
            lambda s: s["cases"][0].update(prompt=" "),
            lambda s: s["cases"][0].update(prompt="x" * 16001),
            lambda s: s["cases"][0].update(prompt="  " + s["cases"][1]["prompt"] + "\\n"),
            lambda s: s["cases"][0].update(checks=[]),
            lambda s: s["cases"][0].update(checks=s["cases"][0]["checks"] * 21),
            lambda s: s["cases"][0]["checks"][0].update(type="regex"),
            lambda s: s["cases"][0]["checks"][0].update(value=" "),
            lambda s: s["cases"][0]["checks"][0].update(value="x" * 2001),
            lambda s: s["cases"][0]["checks"][0].update(value=42),
        ]
        for mutate in mutations:
            value = copy.deepcopy(suite)
            mutate(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_suite(value, rows)
        for value in (None, [], {"schema": "mamase.eval-suite.v1", "cases": None}):
            with self.assertRaises(ValueError):
                validate_suite(value, rows)

    def test_no_training_or_holdout_user_prompt_overlap(self):
        for prompt in ("training question", "followup question", "\\n holdout question  "):
            value = copy.deepcopy(suite)
            value["cases"][0]["prompt"] = prompt
            with self.subTest(prompt=prompt), self.assertRaisesRegex(ValueError, "overlaps"):
                validate_suite(value, rows)
        value = copy.deepcopy(suite)
        value["cases"][0]["prompt"] = "training  question"
        self.assertEqual(validate_suite(value, rows), value)

    def test_all_case_sensitive_rules_and_bounded_responses(self):
        self.assertTrue(score_response("Cody!", [{"type": "equals", "value": "Cody!"}, {"type": "contains", "value": "Cody"}, {"type": "not_contains", "value": "cody"}]))
        self.assertFalse(score_response(" Cody! ", [{"type": "equals", "value": "Cody!"}]))
        self.assertFalse(score_response("cody", [{"type": "contains", "value": "Cody"}]))
        self.assertFalse(score_response("Cody", [{"type": "contains", "value": "Cody"}, {"type": "not_contains", "value": "Cody"}]))
        self.assertTrue(score_response("", [{"type": "not_contains", "value": "Cody"}]))
        for response in (None, "x" * 64001):
            with self.assertRaises(ValueError):
                score_response(response, suite["cases"][0]["checks"])
        with self.assertRaises(ValueError):
            score_response(chr(0x1f600) * 32001, suite["cases"][0]["checks"])

    def test_token_budgets_and_explicit_generation_prefix(self):
        for value in (1, 128, 512):
            self.assertEqual(validate_max_new_tokens(value), value)
        for value in (0, 513, -1, True, 1.5, "8"):
            with self.assertRaises(ValueError):
                validate_max_new_tokens(value)
        tokenizer = Tokenizer()
        tokenized = prepare_prompts(suite, rows, tokenizer, 1000, 1000, 8)
        expected = tokenizer.encode(tokenizer.apply_chat_template(
            [rows["train"][0]["prompt"][0], {"role": "user", "content": suite["cases"][0]["prompt"]}],
            add_generation_prompt=True))
        self.assertEqual(tokenized[0], expected)
        length = len(expected)
        single = {**suite, "cases": suite["cases"][:1]}
        self.assertEqual(prepare_prompts(single, rows, tokenizer, length + 8, length + 8, 8), [expected])
        for recipe_limit, model_limit in ((length + 7, 1000), (1000, length + 7)):
            with self.assertRaisesRegex(ValueError, "context|budget|maxSequence"):
                prepare_prompts(single, rows, tokenizer, recipe_limit, model_limit, 8)
        self.assertEqual(context_limit(SimpleNamespace(max_position_embeddings=2048), tokenizer), 2048)
        self.assertEqual(context_limit(SimpleNamespace(n_positions=512), tokenizer), 512)
        with self.assertRaisesRegex(ValueError, "context"):
            context_limit(SimpleNamespace(), tokenizer)
        class Empty(Tokenizer):
            def encode(self, text, add_special_tokens=False):
                return []
        class NoPrefix(Tokenizer):
            def apply_chat_template(self, messages, **kwargs):
                return "same with no generation marker"
        for broken in (Empty(), NoPrefix()):
            with self.assertRaisesRegex(ValueError, "generation|empty"):
                prepare_prompts(suite, rows, broken, 1000, 1000, 8)

    def test_private_exclusive_report_publication_and_failed_write_cleanup(self):
        old_mask = os.umask(0o077)
        try:
            with TemporaryDirectory() as directory:
                out = Path(directory) / "evaluation"
                report = {"schema": "mamase.evaluation-report.v1"}
                path = write_report(out, report)
                self.assertEqual(json.loads(path.read_text()), report)
                self.assertEqual(out.stat().st_mode & 0o777, 0o700)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    write_report(out, {"replacement": True})
                self.assertEqual(json.loads(path.read_text()), report)
                with self.assertRaises(FileNotFoundError):
                    write_report(Path(directory) / "missing" / "evaluation", report)
                failed = Path(directory) / "failed"
                def fail_write(path, value):
                    path.with_suffix(".tmp").write_text(json.dumps(value))
                    raise OSError("simulated disk write failure")
                with patch("training.evaluate.write_json", side_effect=fail_write):
                    with self.assertRaisesRegex(OSError, "disk write failure"):
                        write_report(failed, report)
                self.assertEqual(list(failed.iterdir()), [])
        finally:
            os.umask(old_mask)

    def test_serialized_report_byte_limit_includes_formatting_and_unicode_escapes(self):
        limit = 20_000_000
        overhead = len((json.dumps({"response": ""}, indent=2, allow_nan=False) + "\\n").encode("utf-8"))
        with TemporaryDirectory() as directory:
            out = Path(directory) / "at-limit"
            report = {"response": "x" * (limit - overhead)}
            path = write_report(out, report)
            self.assertEqual(path.stat().st_size, limit)
            for name, response in (
                ("over-limit", report["response"] + "x"),
                ("unicode-escapes", chr(0x00e9) * ((limit - overhead) // 6 + 1)),
            ):
                failed = Path(directory) / name
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, "20 MB"):
                    write_report(failed, {"response": response})
                self.assertEqual(list(failed.iterdir()), [])

unittest.main()
`], { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
});
