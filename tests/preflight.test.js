import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { trainingTestMode } from "../scripts/training-test-mode.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { python, skip } = trainingTestMode();

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
  skip,
}, () => {
  run(python, ["--real"]);
});
