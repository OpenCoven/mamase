import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { catalog, OPERATIONS, runOperation, CATALOG_SCHEMA, RECEIPT_SCHEMA, WORKSPACE_FILE_SCHEMA } from "../ops.mjs";
import { parseWorkspaceBackup } from "../backups.js";
import { sha256 } from "../familiar-context.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (letter) => letter.repeat(64);
const later = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const cli = (...args) => {
  const result = spawnSync(process.execPath, [join(root, "ops.mjs"), ...args], { encoding: "utf8", cwd: root });
  assert.equal(result.stderr, "", result.stderr);
  return { code: result.status, output: JSON.parse(result.stdout) };
};
const dataset = Buffer.from(Array.from({ length: 6 }, (_, index) => JSON.stringify({ prompt: `Task ${index}`, response: `Result ${index}.` })).join("\n") + "\n");
const recipe = {
  method: "lora", programId: "coven", datasetId: "dataset-1", student: "local-fixture", teacher: "", adapter: "lora",
  familiarId: "cody", instanceId: "test-coven", rank: 4, alpha: 8, learningRate: 0.001, epochs: 1, batchSize: 1, accumulation: 4,
  maxSequence: 512, outputPath: "./outputs/hint-only", objective: "Test the headless operations, not model quality.",
};

test("operation catalog is versioned and self-describing", () => {
  const listing = catalog();
  assert.equal(listing.schema, CATALOG_SCHEMA);
  assert.deepEqual(listing.operations.map((operation) => operation.name), Object.keys(OPERATIONS));
  for (const operation of listing.operations) {
    assert.equal(typeof operation.mutates, "boolean");
    assert.ok(operation.output && operation.description && operation.input);
  }
  assert.deepEqual(listing.exitCodes, { changed: 0, unchanged: 0, blocked: 2, failed: 1 });
  assert.deepEqual(cli("catalog").output, listing);
  assert.equal(cli("catalog").code, 0);
  const help = spawnSync(process.execPath, [join(root, "ops.mjs"), "--help"], { encoding: "utf8", cwd: root });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: npm run ops/);
  const unknown = cli("nope", "--workspace", "x.json");
  assert.equal(unknown.code, 1);
  assert.deepEqual(unknown.output.error, { code: "unknown-operation", message: "Unknown operation. Run catalog for the supported list." });
});

test("headless workspace operations create, inspect, import and hand off through shared validators", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mamase-ops-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "private", "workspace.json");
  const datasetPath = join(directory, "examples.jsonl");
  await writeFile(datasetPath, dataset);
  const revision = async () => (await runOperation("inspect", { workspace })).revision.after;

  const created = cli("init", "--workspace", workspace, "--name", "Agent lab");
  assert.equal(created.output.outcome, "changed");
  assert.equal(created.output.revision.before, null);
  assert.equal((await stat(workspace)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "private"))).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(workspace, "utf8")).schema, WORKSPACE_FILE_SCHEMA);
  const again = cli("init", "--workspace", workspace);
  assert.equal(again.code, 2);
  assert.equal(again.output.error.code, "workspace-exists");

  let current = await revision();
  assert.equal(current, sha256(await readFile(workspace)));
  const inspected = cli("inspect", "--workspace", workspace).output;
  assert.equal(inspected.schema, RECEIPT_SCHEMA);
  assert.equal(inspected.name, "Agent lab");
  assert.deepEqual(inspected.workspace.datasets, []);

  const datasetArgs = ["add-dataset", "--workspace", workspace, "--file", datasetPath, "--name", "Synthetic", "--kind", "supervised", "--holdout", "34", "--provenance", "Synthetic fixture, not familiar memory.", "--id", "dataset-1"];
  const stale = cli(...datasetArgs, "--expected-revision", hash("0"));
  assert.equal(stale.code, 2);
  assert.equal(stale.output.error.code, "stale-revision");
  assert.equal(await revision(), current, "blocked writes never mutate");
  const added = cli(...datasetArgs, "--expected-revision", current);
  assert.equal(added.code, 0);
  assert.equal(added.output.outcome, "changed");
  assert.equal(added.output.sha256, sha256(dataset));
  assert.equal(added.output.records, 6);
  assert.equal(added.output.revision.before, current);
  assert.notEqual(added.output.revision.after, current);
  assert.ok(!(await readFile(workspace, "utf8")).includes("Task 0"), "dataset bytes are never stored");
  current = await revision();
  assert.equal(current, added.output.revision.after);

  const replay = cli(...datasetArgs, "--expected-revision", current);
  assert.equal(replay.output.outcome, "unchanged");
  assert.equal(replay.output.dataset, "dataset-1");
  assert.equal(await revision(), current);
  const conflict = cli(...datasetArgs.slice(0, -2), "--id", "dataset-2", "--expected-revision", current);
  assert.equal(conflict.code, 2);
  assert.equal(conflict.output.error.code, "dataset-conflict");
  assert.equal(conflict.output.details.dataset, "dataset-1");
  const badKind = cli(...datasetArgs.slice(0, -2), "--id", "dataset-3", "--kind", "teacher", "--expected-revision", current);
  assert.equal(badKind.code, 1);
  assert.equal(badKind.output.error.code, "validation");
  assert.equal(await revision(), current);

  const recipePath = join(directory, "recipe-input.json");
  await writeFile(recipePath, JSON.stringify({ id: "run-1", name: "Planned run", recipe }));
  const planned = cli("create-recipe", "--workspace", workspace, "--expected-revision", current, "--input", recipePath);
  assert.equal(planned.output.outcome, "changed");
  assert.deepEqual([planned.output.run, planned.output.status, planned.output.totalSteps], ["run-1", "planned", 1]);
  current = await revision();
  assert.equal(cli("create-recipe", "--workspace", workspace, "--expected-revision", current, "--input", recipePath).output.outcome, "unchanged");
  await writeFile(recipePath, JSON.stringify({ id: "run-1", name: "Different name", recipe }));
  const runConflict = cli("create-recipe", "--workspace", workspace, "--expected-revision", current, "--input", recipePath);
  assert.equal(runConflict.output.error.code, "run-conflict");
  await writeFile(recipePath, JSON.stringify({ id: "run-1", name: "Planned run", recipe: { ...recipe, method: "distillation" } }));
  const invalid = cli("create-recipe", "--workspace", workspace, "--expected-revision", current, "--input", recipePath);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.output.error.code, "validation");
  assert.match(invalid.output.error.message, /Teacher model/);
  assert.equal(await revision(), current);

  const exported = cli("export-recipe", "--workspace", workspace, "--run", "run-1", "--out", join(directory, "recipe.json"));
  assert.equal(exported.output.schema, "mamase.training-recipe.v1");
  assert.equal(exported.output.execution, "external");
  assert.equal(exported.output.dataset.sha256, sha256(dataset));
  assert.deepEqual(JSON.parse(await readFile(join(directory, "recipe.json"), "utf8")), exported.output);
  assert.equal(cli("export-recipe", "--workspace", workspace, "--run", "run-1", "--out", join(directory, "recipe.json")).output.error.code, "validation");
  assert.equal(cli("export-recipe", "--workspace", workspace, "--run", "run-9").output.error.code, "record-missing");
  assert.equal(cli("inspect", "--workspace", workspace, "--record", "run-1").output.record.status, "planned");

  const progressPath = join(directory, "progress.json");
  const updates = [
    { status: "running", step: 0, totalSteps: 1, loss: null, evalLoss: 2, note: "", recordedAt: later(1) },
    { status: "completed", step: 1, totalSteps: 1, loss: 1, evalLoss: 1.5, note: "", recordedAt: later(2) },
  ];
  await writeFile(progressPath, JSON.stringify({ schema: "mamase.run-report.v1", runId: "run-1", updates: [updates[0]] }));
  const first = cli("import-progress", "--workspace", workspace, "--expected-revision", current, "--file", progressPath);
  assert.deepEqual([first.output.outcome, first.output.additions, first.output.duplicates, first.output.status], ["changed", 1, 0, "running"]);
  current = await revision();
  await writeFile(progressPath, JSON.stringify({ schema: "mamase.run-report.v1", runId: "run-1", updates }));
  const second = cli("import-progress", "--workspace", workspace, "--expected-revision", current, "--file", progressPath);
  assert.deepEqual([second.output.outcome, second.output.additions, second.output.duplicates, second.output.status], ["changed", 1, 1, "completed"]);
  current = await revision();
  const duplicate = cli("import-progress", "--workspace", workspace, "--expected-revision", current, "--file", progressPath);
  assert.deepEqual([duplicate.code, duplicate.output.outcome, duplicate.output.duplicates], [0, "unchanged", 2]);
  await writeFile(progressPath, JSON.stringify({ schema: "mamase.run-report.v1", runId: "run-1", updates: [{ ...updates[1], loss: 0.5 }] }));
  const conflicting = cli("import-progress", "--workspace", workspace, "--expected-revision", current, "--file", progressPath);
  assert.equal(conflicting.code, 2);
  assert.equal(conflicting.output.error.code, "progress-conflict");
  assert.equal(conflicting.output.details.conflicts.length, 1);
  assert.ok(!JSON.stringify(conflicting.output).includes("Task 0"));
  assert.equal(await revision(), current);

  const result = {
    schema: "mamase.training-result.v1", runId: "run-1", bundleSha256: hash("c"),
    familiar: { familiarId: "cody", instanceId: "test-coven" },
    baseModel: { label: "local-fixture", localPath: "/local/model", files: { "model.safetensors": hash("d") } },
    adapter: { path: "/private/bundle/adapter", technique: "lora", files: { "adapter_model.safetensors": hash("f"), "adapter_config.json": hash("a") } },
    datasetSha256: sha256(dataset), holdoutSha256: hash("d"), optimizerSteps: 1,
    evaluation: { metric: "completion-token-weighted-negative-log-likelihood", samples: 2, baseLoss: 2, adapterLoss: 1.5, delta: -0.5 },
    trainableParameters: 100, totalParameters: 1000, promotion: "not-authorized",
  };
  const resultPath = join(directory, "result.json");
  await writeFile(resultPath, JSON.stringify(result));
  const resultSha256 = sha256(await readFile(resultPath));
  const imported = cli("import-result", "--workspace", workspace, "--expected-revision", current, "--file", resultPath, "--id", "artifact-1");
  assert.deepEqual([imported.output.outcome, imported.output.artifact, imported.output.sha256], ["changed", "artifact-1", resultSha256]);
  current = await revision();
  assert.equal(cli("import-result", "--workspace", workspace, "--expected-revision", current, "--file", resultPath).output.outcome, "unchanged");

  const report = {
    schema: "mamase.evaluation-report.v1", runId: "run-1", createdAt: later(3),
    resultSha256, bundleSha256: result.bundleSha256, datasetSha256: result.datasetSha256,
    familiar: result.familiar, adapterPath: result.adapter.path,
    suite: { name: "Synthetic regressions", version: "1", sha256: hash("f") },
    decoding: { doSample: false, numBeams: 1, maxNewTokens: 16, seed: 42 }, device: "cpu", promotion: "not-authorized",
    cases: [
      { id: "task-1", category: "task", prompt: "private task prompt", checks: [{ type: "equals", value: "pass" }], base: { response: "pass", passed: true }, adapter: { response: "pass", passed: true } },
      { id: "identity-1", category: "identity", prompt: "private identity prompt", checks: [{ type: "contains", value: "Cody" }], base: { response: "unknown", passed: false }, adapter: { response: "I am Cody", passed: true } },
      { id: "consent-1", category: "consent", prompt: "private consent prompt", checks: [{ type: "not_contains", value: "forbidden" }], base: { response: "consent", passed: true }, adapter: { response: "consent", passed: true } },
      { id: "tool-1", category: "tool-boundary", prompt: "private tool prompt", checks: [{ type: "equals", value: "approval" }], base: { response: "no", passed: false }, adapter: { response: "approval", passed: true } },
    ],
    summary: { samples: 4, basePassed: 2, adapterPassed: 4, regressions: 0 },
  };
  const reportPath = join(directory, "evaluation.json");
  await writeFile(reportPath, JSON.stringify(report));
  const evaluated = cli("import-evaluation", "--workspace", workspace, "--expected-revision", current, "--file", reportPath, "--id", "evaluation-1");
  assert.equal(evaluated.output.outcome, "changed", JSON.stringify(evaluated.output));
  current = await revision();
  assert.equal(cli("import-evaluation", "--workspace", workspace, "--expected-revision", current, "--file", reportPath).output.outcome, "unchanged");
  const stored = await readFile(workspace, "utf8");
  assert.ok(!stored.includes("private identity prompt") && !stored.includes("I am Cody"), "evaluation prompts and outputs stay private");
  const record = cli("inspect", "--workspace", workspace, "--record", "evaluation-1").output.record;
  assert.equal(record.comparison.reportSha256, sha256(await readFile(reportPath)));

  const backupPath = join(directory, "backup.json");
  const backup = cli("export-backup", "--workspace", workspace, "--out", backupPath);
  assert.equal(backup.output.outcome, "unchanged");
  const parsed = parseWorkspaceBackup(await readFile(backupPath, "utf8"));
  assert.equal(parsed.format, "mamase.workspace-backup.v1");
  assert.deepEqual(parsed.workspace.evaluations.map((item) => item.id), ["evaluation-1"]);
  assert.equal(cli("import-backup", "--workspace", workspace, "--expected-revision", current, "--file", backupPath).output.outcome, "unchanged");

  const other = join(directory, "other.json");
  cli("init", "--workspace", other);
  const otherRevision = (await runOperation("inspect", { workspace: other })).revision.after;
  const restored = cli("import-backup", "--workspace", other, "--expected-revision", otherRevision, "--file", backupPath);
  assert.equal(restored.output.outcome, "changed");
  assert.deepEqual((await runOperation("inspect", { workspace: other })).workspace.runs.map((run) => run.id), ["run-1"]);
  await writeFile(backupPath, JSON.stringify({ schema: "mamase.workspace-backup.v9", workspace: {} }));
  const unsupported = cli("import-backup", "--workspace", other, "--expected-revision", restored.output.revision.after, "--file", backupPath);
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.output.error.message, /Unsupported backup schema/);
  assert.equal((await runOperation("inspect", { workspace: other })).revision.after, restored.output.revision.after);

  const lock = await open(`${workspace}.lock`, "wx");
  await writeFile(recipePath, JSON.stringify({ id: "run-2", name: "Blocked by lock", recipe }));
  const locked = cli("create-recipe", "--workspace", workspace, "--expected-revision", current, "--input", recipePath);
  assert.deepEqual([locked.code, locked.output.error.code], [2, "workspace-locked"]);
  await lock.close();
  assert.equal(await revision(), current);
  await rm(`${workspace}.lock`);
  assert.equal(cli("create-recipe", "--workspace", workspace, "--expected-revision", current, "--input", recipePath).output.outcome, "changed");
  await writeFile(workspace, "{not json");
  const corrupt = cli("inspect", "--workspace", workspace);
  assert.deepEqual([corrupt.code, corrupt.output.error.code], [1, "invalid-json"]);
  assert.equal(cli("inspect", "--workspace", join(directory, "missing.json")).output.error.code, "workspace-missing");
});
