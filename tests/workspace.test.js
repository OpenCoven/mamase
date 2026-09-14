import test from "node:test";
import assert from "node:assert/strict";
import {
  STORAGE_KEY, createWorkspace, parseDataset, validateDataset, splitCounts, createRun, recordProgress,
  validateRecipe, validateWorkspace, saveWorkspace, loadWorkspace, validateArtifact, validateEvaluation,
  exportRecipe, runsCsv, escapeHtml,
} from "../workspace.js";

const timestamp = "2026-09-13T15:00:00.000Z";
const dataset = {
  id: "dataset-1", name: "Coven examples", filename: "examples.jsonl", records: 100, bytes: 5000,
  format: "prompt-response", kind: "supervised", teacher: "", provenance: "Written by the coven; permitted for training.",
  holdout: 10, sha256: "a".repeat(64), createdAt: timestamp,
};
const recipe = {
  method: "lora", programId: "coven", datasetId: dataset.id, student: "Qwen/Qwen2.5-7B-Instruct", teacher: "",
  rank: 16, alpha: 32, learningRate: 0.0002, epochs: 3, batchSize: 1, accumulation: 4,
  maxSequence: 2048, outputPath: "./outputs/coven", objective: "Improve factual calibration.",
};
function fixture() {
  const workspace = createWorkspace();
  workspace.datasets.push({ ...dataset });
  workspace.runs.push(createRun({ id: "run-1", name: "Coven v1", recipe, createdAt: timestamp }, workspace));
  return workspace;
}
const event = (overrides = {}) => ({
  status: "running", step: 10, totalSteps: 69, loss: 1.2, evalLoss: null, note: "From local trainer",
  recordedAt: "2026-09-13T16:00:00.000Z", ...overrides,
});
const fakeStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test("new workspace has no invented models, progress, or metrics", () => {
  const workspace = createWorkspace();
  assert.equal(workspace.programs.length, 1);
  assert.deepEqual(workspace.runs, []);
  assert.deepEqual(workspace.datasets, []);
  assert.deepEqual(workspace.artifacts, []);
  assert.deepEqual(workspace.evaluations, []);
});

test("JSONL import validates each record, handles blank lines, CRLF and BOM", () => {
  assert.deepEqual(parseDataset('\uFEFF{"prompt":"one","response":"two"}\r\n\r\n{"prompt":"three","response":"four"}\n'), { records: 2, format: "prompt-response" });
  const messages = JSON.stringify({ messages: [{ role: "user", content: "Question" }, { role: "assistant", content: "Answer" }] });
  assert.deepEqual(parseDataset(`${messages}\n${messages}`), { records: 2, format: "messages" });
});

test("invalid and mixed datasets fail without accepting a partial import", () => {
  for (const source of ["", "null", "[]", '{"prompt":"one","response":"two"}', '{"prompt":"","response":"two"}']) {
    assert.throws(() => parseDataset(source));
  }
  assert.throws(() => parseDataset('{"prompt":"a","response":"b"}\ninvalid'), /Line 2/);
  assert.throws(() => parseDataset('{"prompt":"a","response":"b"}\n{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]}'), /mix/);
  assert.throws(() => parseDataset('{"messages":[{"role":"user","content":"a"},{"role":"user","content":"b"}]}'), /assistant response/);
});

test("dataset validation requires provenance, fingerprint, and teacher identity", () => {
  assert.deepEqual(validateDataset(dataset), dataset);
  assert.throws(() => validateDataset({ ...dataset, provenance: "" }), /provenance/);
  assert.throws(() => validateDataset({ ...dataset, sha256: "wrong" }), /SHA-256/);
  assert.throws(() => validateDataset({ ...dataset, kind: "teacher" }), /Teacher model/);
  assert.deepEqual(splitCounts(dataset), { train: 90, holdout: 10 });
  assert.deepEqual(splitCounts({ ...dataset, records: 2, holdout: 1 }), { train: 1, holdout: 1 });
});

test("response distillation needs actual teacher-generated data with matching lineage", () => {
  const workspace = fixture();
  const distillation = { ...recipe, method: "distillation", teacher: "teacher/72B" };
  assert.throws(() => validateRecipe(distillation, workspace), /teacher-generated/);
  workspace.datasets[0].kind = "teacher";
  workspace.datasets[0].teacher = "teacher/different";
  assert.throws(() => validateRecipe(distillation, workspace), /must match/);
  workspace.datasets[0].teacher = "teacher/72B";
  assert.equal(validateRecipe(distillation, workspace).teacher, "teacher/72B");
});

test("recipe hyperparameters are bounded, numeric, and refer to existing data", () => {
  const workspace = fixture();
  for (const override of [{ rank: 12 }, { rank: NaN }, { learningRate: 0 }, { epochs: 1.5 }, { batchSize: 0 }, { accumulation: Infinity }, { datasetId: "missing" }, { programId: "missing" }]) {
    assert.throws(() => validateRecipe({ ...recipe, ...override }, workspace));
  }
});

test("saving a recipe only plans training and calculates optimizer steps with accumulation", () => {
  const run = fixture().runs[0];
  assert.equal(run.status, "planned");
  assert.equal(run.step, 0);
  assert.equal(run.totalSteps, 69);
  assert.deepEqual(run.history, []);
});

test("progress transitions record actual observations and preserve prior values", () => {
  const planned = fixture().runs[0];
  const running = recordProgress(planned, event());
  assert.equal(planned.status, "planned");
  assert.equal(running.status, "running");
  assert.equal(running.history.length, 1);
  const paused = recordProgress(running, event({ status: "paused", step: 20 }));
  assert.equal(recordProgress(paused, event({ status: "completed", step: 69 })).status, "completed");
  const resumed = recordProgress(paused, event({ step: 25 }));
  const completed = recordProgress(resumed, event({ status: "completed", step: 69, loss: 0.6 }));
  assert.equal(completed.status, "completed");
  assert.equal(completed.history.length, 4);
  assert.throws(() => recordProgress(completed, event()), /Cannot change/);
});

test("bad progress is rejected rather than faked or clamped", () => {
  const planned = fixture().runs[0];
  assert.throws(() => recordProgress(planned, event({ status: "completed", step: 69 })), /Cannot change/);
  const running = recordProgress(planned, event());
  for (const override of [{ step: 9 }, { step: 70 }, { totalSteps: 0 }, { loss: -1 }, { loss: "0.9" }, { status: "completed", step: 50 }, { recordedAt: timestamp }, { status: "planned", step: 0 }]) {
    assert.throws(() => recordProgress(running, event(override)));
  }
  const failed = recordProgress(running, event({ status: "failed" }));
  assert.throws(() => recordProgress(failed, event({ status: "failed" })), /closed/);
});

test("artifacts and evaluations preserve relationships and bounded scores", () => {
  const workspace = fixture();
  const artifact = validateArtifact({ id: "model-1", runId: "run-1", name: "Coven adapter", kind: "adapter", path: "./outputs/coven", notes: "", createdAt: timestamp }, workspace);
  workspace.artifacts.push(artifact);
  const evaluation = { id: "eval-1", artifactId: artifact.id, benchmark: "coven-v1", score: 80, maximum: 100, samples: 50, notes: "", createdAt: timestamp };
  workspace.evaluations.push(validateEvaluation(evaluation, workspace));
  assert.deepEqual(validateWorkspace(workspace), workspace);
  assert.throws(() => validateArtifact({ ...artifact, runId: "missing" }, workspace), /existing run/);
  assert.throws(() => validateEvaluation({ ...evaluation, artifactId: "missing" }, workspace), /artifact/);
  assert.throws(() => validateEvaluation({ ...evaluation, score: 101 }, workspace), /Score/);
  assert.throws(() => validateEvaluation({ ...evaluation, samples: 0 }, workspace), /samples/);
});

test("workspace persistence round-trips and never hides corrupt or unavailable storage", () => {
  const storage = fakeStorage();
  assert.deepEqual(loadWorkspace(storage), createWorkspace());
  const workspace = fixture();
  workspace.runs[0] = recordProgress(workspace.runs[0], event());
  saveWorkspace(storage, workspace);
  assert.deepEqual(loadWorkspace(storage), workspace);
  storage.setItem(STORAGE_KEY, "not json");
  assert.throws(() => loadWorkspace(storage), SyntaxError);
  assert.equal(storage.getItem(STORAGE_KEY), "not json");
  assert.throws(() => saveWorkspace({ setItem() { throw new Error("Storage full"); } }, workspace), /Storage full/);
});

test("backup validation detects duplicate IDs, broken links, and inconsistent history", () => {
  const workspace = fixture();
  assert.throws(() => validateWorkspace({ ...workspace, version: 2 }), /version/);
  assert.throws(() => validateWorkspace({ ...workspace, programs: [] }), /at least one/);
  assert.throws(() => validateWorkspace({ ...workspace, datasets: [dataset, dataset] }), /Duplicate/);
  assert.throws(() => validateWorkspace({ ...workspace, runs: [{ ...workspace.runs[0], step: 50 }] }), /history/);
  assert.throws(() => validateWorkspace({ ...workspace, datasets: [] }), /dataset/);
});

test("exported recipe describes an external plan, split policy, and recorded dataset", () => {
  const workspace = fixture();
  const exported = exportRecipe(workspace.runs[0], workspace);
  assert.equal(exported.execution, "external");
  assert.equal(exported.dataset.sha256, dataset.sha256);
  assert.deepEqual(exported.dataset.split, { train: 90, holdout: 10 });
  assert.equal(exported.dataset.splitSeed, 42);
  assert.equal(exported.distillation, null);
  assert.equal(exported.estimatedOptimizerSteps, 69);
});

test("user text is escaped and CSV cells cannot become spreadsheet formulas", () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  const run = fixture().runs[0];
  const csv = runsCsv([{ ...run, name: '=HYPERLINK("test")' }]);
  assert.match(csv, /"'=HYPERLINK\(""test""\)"/);
  assert.equal(runsCsv([]).split("\r\n").length, 1);
});
