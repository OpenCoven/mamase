import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.MAMASE_TRAINING_PYTHON || fileURLToPath(new URL("../.venv/bin/python", import.meta.url));

function run(executable, args) {
  const result = spawnSync(executable, ["-B", "tests/preflight_checks.py", ...args], {
    cwd: root, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", OMP_NUM_THREADS: "1" },
  });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
}

test("offline preflight validates sources, inventory and failure reports with stdlib Python", () => {
  run(process.env.MAMASE_TEST_PYTHON || "python3", []);
});

test("offline preflight checks real local tokenizer and PEFT APIs without weights, training or writes", {
  skip: !existsSync(python) && "Set MAMASE_TRAINING_PYTHON to an existing PEFT environment; stdlib coverage always runs.",
}, () => {
  run(python, ["--real"]);
});
