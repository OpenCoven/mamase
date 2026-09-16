import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trainingTestMode } from "../scripts/training-test-mode.mjs";
import { contrastRatio, writeFailureEvidence } from "../scripts/ux-evidence.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const child = (args, extra = {}) => {
  const env = { ...process.env, MAMASE_SKIP_ML: "", MAMASE_REQUIRE_ML: "", ...extra };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 30_000, env });
};

test("required ML cannot silently skip absent interpreters or conflict with Node-only mode", () => {
  const env = { MAMASE_TRAINING_PYTHON: "/nonexistent/mamase-python" };
  assert.match(trainingTestMode(env).skip, /Optional ML not executed/);
  assert.equal(trainingTestMode({ ...env, MAMASE_REQUIRE_ML: "1" }).skip, false);
  assert.match(trainingTestMode({ ...env, MAMASE_SKIP_ML: "1" }).skip, /Explicit Node-only/);
  assert.throws(() => trainingTestMode({ ...env, MAMASE_SKIP_ML: "1", MAMASE_REQUIRE_ML: "1" }), /cannot also/);
  const result = child(["--test", "--test-reporter=tap", "--test-name-pattern=real local PEFT|offline preflight checks real", "tests/lab.test.js", "tests/preflight.test.js"], {
    ...env, MAMASE_REQUIRE_ML: "1",
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not ok .*real local PEFT/);
  assert.match(result.stdout, /not ok .*offline preflight checks real/);
  assert.match(result.stdout, /ENOENT/);
});

test("local gate records missing interpreter failures and leaves later matrix jobs unrun", async (context) => {
  const result = child(["scripts/validate.mjs", "all"], {
    MAMASE_NODE_22: "/nonexistent/mamase-node", MAMASE_NODE_24: process.execPath,
  });
  assert.equal(result.status, 1);
  const path = /Bounded execution summary: (.+\/summary\.json)/.exec(result.stdout)?.[1];
  assert.ok(path);
  context.after(() => rm(join(path, ".."), { recursive: true }));
  const evidence = JSON.parse(await readFile(path, "utf8"));
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.jobs[0].steps[0].errorCode, "ENOENT");
  assert.deepEqual(evidence.jobs.map((job) => job.status), ["failed", "not-run", "not-run", "not-run"]);
  assert.ok(!JSON.stringify(evidence).includes("/nonexistent"));
});

test("CPU gate fails before testing when its required Python executable is missing", async (context) => {
  const result = child(["scripts/validate.mjs", "cpu"], { MAMASE_TRAINING_PYTHON: "/nonexistent/mamase-python" });
  assert.equal(result.status, 1);
  const path = /Bounded execution summary: (.+\/summary\.json)/.exec(result.stdout)?.[1];
  assert.ok(path);
  context.after(() => rm(join(path, ".."), { recursive: true }));
  const evidence = JSON.parse(await readFile(path, "utf8"));
  assert.equal(evidence.jobs[0].status, "failed");
  assert.equal(evidence.jobs[0].steps.at(-1).errorCode, "ENOENT");
  assert.equal(evidence.jobs[0].steps.some((step) => step.command.includes("tests/lab.test.js")), false);
});

test("required Python dependency import fails with site packages unavailable", () => {
  const python = process.env.MAMASE_TRAINING_PYTHON || process.env.MAMASE_TEST_PYTHON || "python3";
  const result = spawnSync(python, ["-S", "-B", "scripts/check-training-env.py"], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PackageNotFoundError|requires Python 3\.14/);
});

test("a broken installed ML import fails the pinned environment probe", () => {
  const python = process.env.MAMASE_TEST_PYTHON || "python3";
  const result = spawnSync(python, ["-B", "-c", `
import runpy
from unittest.mock import patch
with patch("importlib.metadata.version", return_value="2.14.0"), patch("importlib.import_module", side_effect=ModuleNotFoundError("synthetic broken torch import")):
    runpy.run_path("scripts/check-training-env.py", run_name="__main__")
`], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /synthetic broken torch import|requires Python 3\.14/);
});

test("contrast calculation rejects insufficient contrast and unsupported transparent samples", () => {
  assert.equal(contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)"), 21);
  assert.equal(contrastRatio("rgb(255, 255, 255)", "rgb(0, 0, 0)"), 21);
  assert.equal(contrastRatio("rgb(42, 42, 42)", "rgb(42, 42, 42)"), 1);
  assert.ok(contrastRatio("rgb(140, 140, 140)", "rgb(255, 255, 255)") < 4.5);
  assert.ok(contrastRatio("rgb(142, 106, 47)", "rgb(250, 243, 228)") < 4.5, "Original paused badge failed text contrast");
  assert.ok(contrastRatio("rgb(128, 95, 40)", "rgb(250, 243, 228)") >= 4.5);
  assert.throws(() => contrastRatio("rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)"), /opaque/);
});

test("synthetic failure evidence is bounded and never dumps page contents or oversized images", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mamase-evidence-test-"));
  context.after(() => rm(directory, { recursive: true }));
  const page = {
    isClosed: () => false, viewportSize: () => ({ width: 320, height: 568 }),
    screenshot: async (options) => {
      assert.equal(options.fullPage, false);
      return Buffer.alloc(2 * 1024 * 1024 + 1);
    },
    content: () => assert.fail("Never export DOM or private storage"),
  };
  await writeFailureEvidence(directory, page, 3);
  assert.deepEqual(await readdir(directory), ["failure.json"]);
  const summary = JSON.parse(await readFile(join(directory, "failure.json")));
  assert.equal(summary.screenshot, "omitted: exceeds 2 MiB cap");
  assert.equal(summary.layoutsCompleted, 3);
  assert.ok((await stat(join(directory, "failure.json"))).size < 2048);
});

test("existing browser runner produces real bounded synthetic failure artifacts", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mamase-browser-evidence-"));
  context.after(() => rm(directory, { recursive: true }));
  const result = child(["scripts/verify-ux.mjs", "--failure-fixture"], { MAMASE_UX_EVIDENCE: directory, MAMASE_SCREENSHOTS: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Deliberate synthetic failure/);
  assert.deepEqual((await readdir(directory)).sort(), ["failure.json", "failure.png"]);
  assert.ok((await stat(join(directory, "failure.png"))).size <= 2 * 1024 * 1024);
  const summary = JSON.parse(await readFile(join(directory, "failure.json")));
  assert.equal(summary.layoutsCompleted, 0);
  assert.equal(summary.screenshot, "failure.png");
});

test("Node gates bound concurrent browser fixtures without excluding test files", async () => {
  const gate = await readFile(join(root, "scripts/validate.mjs"), "utf8");
  const args = /run\(job, node, (\["--test", [^\n]*\]), "node [^\n]*explicit Node-only mode/.exec(gate)?.[1];
  assert.ok(args, "The Node-only invocation must remain explicit.");
  assert.deepEqual(JSON.parse(args), ["--test", "--test-concurrency=1", "--test-reporter=tap"]);
});

test("CPU gate bounds model-runtime concurrency without removing required files", async () => {
  const gate = await readFile(join(root, "scripts/validate.mjs"), "utf8");
  const args = /run\(job, node, (\["--test", [^\n]*"tests\/preflight\.test\.js"\])/.exec(gate)?.[1];
  assert.ok(args, "The required CPU invocation must remain explicit.");
  assert.deepEqual(JSON.parse(args), [
    "--test", "--test-concurrency=1", "--test-reporter=tap",
    "tests/lab.test.js", "tests/evaluation.test.js", "tests/preflight.test.js",
  ]);
});
