import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspace, createRun, recordProgress, importTrainingResult, importEvaluationReport,
  validateWorkspace, saveWorkspace, loadWorkspace,
} from "../workspace.js";
import { exportWorkspaceBackup, parseWorkspaceBackup } from "../backups.js";

const timestamp = "2026-09-13T18:00:00.000Z";
const hash = (letter) => letter.repeat(64);
const resultMetadata = { id: "artifact-1", sha256: hash("b"), createdAt: timestamp };
const evalMetadata = { id: "eval-1", sha256: hash("e"), createdAt: timestamp };

function fixture() {
  const workspace = createWorkspace();
  workspace.datasets.push({
    id: "dataset-1", name: "Synthetic source", filename: "examples.jsonl", records: 10, bytes: 1000,
    format: "prompt-response", kind: "supervised", teacher: "", provenance: "Synthetic fixture.",
    holdout: 20, sha256: hash("a"), createdAt: timestamp,
  });
  let run = createRun({
    id: "run-1", name: "Cody fixture", createdAt: timestamp,
    recipe: {
      method: "lora", programId: "coven", datasetId: "dataset-1", student: "local-fixture", teacher: "",
      familiarId: "cody", instanceId: "test-coven", adapter: "lora", rank: 4, alpha: 8,
      learningRate: 0.001, epochs: 1, batchSize: 1, accumulation: 4, maxSequence: 512,
      outputPath: "./outputs/hint-only", objective: "Test imported evidence, not model quality.",
    },
  }, workspace);
  run = recordProgress(run, { status: "running", step: 0, totalSteps: 2, loss: null, evalLoss: 2, note: "", recordedAt: timestamp });
  run = recordProgress(run, { status: "completed", step: 2, totalSteps: 2, loss: 1, evalLoss: 1.5, note: "", recordedAt: timestamp });
  workspace.runs.push(run);
  const result = {
    schema: "mamase.training-result.v1", runId: run.id, bundleSha256: hash("c"),
    familiar: { familiarId: "cody", instanceId: "test-coven" },
    baseModel: { label: "local-fixture", localPath: "/local/model", files: { "model.safetensors": hash("d") } },
    adapter: { path: "/private/bundle/adapter", technique: "lora", files: { "adapter_model.safetensors": hash("f"), "adapter_config.json": hash("a") } },
    datasetSha256: hash("a"), holdoutSha256: hash("d"), optimizerSteps: 2,
    evaluation: { metric: "completion-token-weighted-negative-log-likelihood", samples: 2, baseLoss: 2, adapterLoss: 1.5, delta: -0.5 },
    trainableParameters: 100, totalParameters: 1000, promotion: "not-authorized",
  };
  const report = {
    schema: "mamase.evaluation-report.v1", runId: run.id, createdAt: timestamp,
    resultSha256: resultMetadata.sha256, bundleSha256: result.bundleSha256, datasetSha256: result.datasetSha256,
    familiar: result.familiar, adapterPath: result.adapter.path,
    suite: { name: "Synthetic regressions", version: "1", sha256: hash("f") },
    decoding: { doSample: false, numBeams: 1, maxNewTokens: 16, seed: 42 },
    device: "cpu", promotion: "not-authorized",
    cases: [
      { id: "task-1", category: "task", prompt: "private task prompt", checks: [{ type: "equals", value: "pass" }], base: { response: "pass", passed: true }, adapter: { response: "fail", passed: false } },
      { id: "identity-1", category: "identity", prompt: "private identity prompt", checks: [{ type: "contains", value: "Cody" }], base: { response: "unknown", passed: false }, adapter: { response: "I am Cody", passed: true } },
      { id: "consent-1", category: "consent", prompt: "private consent prompt", checks: [{ type: "not_contains", value: "forbidden" }], base: { response: "consent", passed: true }, adapter: { response: "consent", passed: true } },
      { id: "tool-1", category: "tool-boundary", prompt: "private tool prompt", checks: [{ type: "equals", value: "approval" }], base: { response: "no", passed: false }, adapter: { response: "no", passed: false } },
    ],
    summary: { samples: 4, basePassed: 2, adapterPassed: 2, regressions: 1 },
  };
  return { workspace, result, report };
}

test("training result import binds actual adapter output, identity, and holdout evidence", () => {
  const { workspace, result } = fixture();
  const imported = importTrainingResult(workspace, result, resultMetadata);
  assert.equal(workspace.artifacts.length, 0);
  assert.equal(imported.artifacts[0].path, "/private/bundle/adapter");
  assert.equal(imported.artifacts[0].lineage.familiarId, "cody");
  assert.equal(imported.artifacts[0].lineage.baseLoss, 2);
  assert.equal(imported.artifacts[0].lineage.adapterLoss, 1.5);
  assert.equal(imported.artifacts[0].lineage.promotion, "not-authorized");
  assert.throws(() => importTrainingResult(imported, result, { ...resultMetadata, id: "another" }), /already imported/);
});

test("training result mismatches and non-completed runs are rejected atomically", () => {
  for (const mutate of [
    (result) => { result.schema = "wrong"; },
    (result) => { result.runId = "other-run"; },
    (result) => { result.familiar.familiarId = "nova"; },
    (result) => { result.familiar.instanceId = "other-coven"; },
    (result) => { result.baseModel.label = "another-base"; },
    (result) => { result.adapter.technique = "dora"; },
    (result) => { result.datasetSha256 = hash("b"); },
    (result) => { result.evaluation.samples = 3; },
    (result) => { result.evaluation.delta = -100; },
    (result) => { result.evaluation.adapterLoss = NaN; },
    (result) => { result.optimizerSteps = 1; },
    (result) => { result.promotion = "approved"; },
    (result) => { result.baseModel.files = {}; },
    (result) => { result.adapter.files["adapter_config.json"] = "invalid"; },
    (result) => { result.trainableParameters = result.totalParameters; },
  ]) {
    const { workspace, result } = fixture();
    mutate(result);
    assert.throws(() => importTrainingResult(workspace, result, resultMetadata));
    assert.equal(workspace.artifacts.length, 0);
  }
  const { workspace, result } = fixture();
  workspace.runs[0].status = "running";
  assert.throws(() => importTrainingResult(workspace, result, resultMetadata), /completed run report/);
});

test("paired reports retain comparisons and category regressions without private prompts or responses", () => {
  const { workspace, result, report } = fixture();
  const artifacts = importTrainingResult(workspace, result, resultMetadata);
  const imported = importEvaluationReport(artifacts, report, evalMetadata);
  assert.equal(artifacts.evaluations.length, 0);
  const evaluation = imported.evaluations[0];
  assert.equal(evaluation.score, 2);
  assert.equal(evaluation.maximum, 4);
  assert.equal(evaluation.comparison.basePassed, 2);
  assert.equal(evaluation.comparison.regressions, 1);
  assert.deepEqual(evaluation.comparison.categories[0], { category: "task", samples: 1, basePassed: 1, adapterPassed: 0, regressions: 1 });
  const saved = JSON.stringify(imported);
  assert.ok(!saved.includes("private task prompt") && !saved.includes("I am Cody"));
  assert.ok(!saved.includes('"cases"') && !saved.includes('"response"') && !saved.includes('"checks"'));
  assert.deepEqual(validateWorkspace(imported), imported);
  let stored;
  const storage = { setItem: (_key, value) => { stored = value; }, getItem: () => stored };
  saveWorkspace(storage, imported);
  assert.deepEqual(loadWorkspace(storage), imported);
  const backup = exportWorkspaceBackup(imported, timestamp);
  assert.ok(!backup.includes('"cases"') && !backup.includes('"response"') && !backup.includes('"checks"'));
  assert.deepEqual(parseWorkspaceBackup(backup).workspace, imported);
  assert.deepEqual(parseWorkspaceBackup(saved).workspace, imported);
  assert.throws(() => importEvaluationReport(imported, report, { ...evalMetadata, id: "another" }), /already imported/);
});

test("paired imports require result lineage and reject forged counts or check outcomes", () => {
  const initial = fixture();
  assert.throws(() => importEvaluationReport(initial.workspace, initial.report, evalMetadata), /matching training result/);
  for (const mutate of [
    (report) => { report.schema = "wrong"; },
    (report) => { report.runId = "other-run"; },
    (report) => { report.resultSha256 = hash("d"); },
    (report) => { report.bundleSha256 = hash("d"); },
    (report) => { report.datasetSha256 = hash("d"); },
    (report) => { report.familiar = { familiarId: "nova", instanceId: "test-coven" }; },
    (report) => { report.adapterPath = "/wrong/adapter"; },
    (report) => { report.summary.adapterPassed = 4; },
    (report) => { report.summary.regressions = 0; },
    (report) => { report.summary.samples = 5; },
    (report) => { report.cases[0].adapter.passed = true; },
    (report) => { report.cases[0].checks.push({ type: "execute", value: "anything" }); },
    (report) => { report.cases[0].checks[0].value = ""; },
    (report) => { report.cases[1].base.response = "Cody"; },
    (report) => { report.cases[1].id = report.cases[0].id; },
    (report) => { report.cases[1].prompt = ` ${report.cases[0].prompt} `; },
    (report) => { report.cases[1].category = "task"; },
    (report) => { report.cases[0] = null; },
    (report) => { report.decoding.doSample = true; },
    (report) => { report.decoding.maxNewTokens = 513; },
    (report) => { report.suite.sha256 = "bad"; },
    (report) => { report.promotion = "approved"; },
  ]) {
    const { workspace, result, report } = fixture();
    const imported = importTrainingResult(workspace, result, resultMetadata);
    mutate(report);
    assert.throws(() => importEvaluationReport(imported, report, evalMetadata));
    assert.equal(imported.evaluations.length, 0);
  }
});

test("restored summaries must remain bound and internally consistent", () => {
  for (const mutate of [
    (workspace) => { workspace.artifacts[0].lineage.datasetSha256 = hash("d"); },
    (workspace) => { workspace.artifacts[0].kind = "gguf"; },
    (workspace) => { workspace.evaluations[0].score = 4; },
    (workspace) => { workspace.evaluations[0].benchmark = "Another suite"; },
    (workspace) => { workspace.evaluations[0].comparison.resultSha256 = hash("d"); },
    (workspace) => { workspace.evaluations[0].comparison.categories[0].regressions = 0; },
    (workspace) => { workspace.evaluations[0].comparison.promotion = "approved"; },
    (workspace) => { workspace.evaluations[0].comparison.categories[0].category = "identity"; },
  ]) {
    const { workspace, result, report } = fixture();
    const imported = importEvaluationReport(importTrainingResult(workspace, result, resultMetadata), report, evalMetadata);
    mutate(imported);
    assert.throws(() => validateWorkspace(imported));
  }
});
