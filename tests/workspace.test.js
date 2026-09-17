import test from "node:test";
import assert from "node:assert/strict";
import {
  STORAGE_KEY, createWorkspace, parseDataset, validateDataset, splitCounts, createRun, recordProgress,
  validateRecipe, validateWorkspace, saveWorkspace, loadWorkspace, validateArtifact, validateEvaluation,
  exportRecipe, runsCsv, escapeHtml,
} from "../workspace.js";
import * as reports from "../workspace.js";
import { BACKUP_SCHEMA, MAX_BACKUP_BYTES, exportWorkspaceBackup, parseWorkspaceBackup } from "../backups.js";

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

const report = (updates, runId = "run-1") => ({ schema: "mamase.run-report.v1", runId, updates });

test("cumulative progress previews additions without changing the workspace", () => {
  const workspace = fixture();
  const before = JSON.stringify(workspace);
  const input = report([event(), event({ step: 20, recordedAt: "2026-09-13T17:00:00.000Z" })]);
  const preview = reports.previewProgressReport(workspace.runs[0], input);
  assert.equal(preview.additions.length, 2);
  assert.equal(preview.duplicates.length, 0);
  assert.deepEqual(preview.conflicts, []);
  assert.equal(JSON.stringify(workspace), before);
  const next = reports.importProgressReport(workspace, input);
  assert.deepEqual(next.runs[0].history, input.updates);
  assert.equal(JSON.stringify(workspace), before);
});

test("repeated reports and strict extensions preserve recorded observations", () => {
  const first = event();
  const second = event({ step: 20, recordedAt: "2026-09-13T17:00:00.000Z" });
  const workspace = reports.importProgressReport(fixture(), report([first]));
  const before = JSON.stringify(workspace);
  assert.equal(reports.importProgressReport(workspace, report([first])), workspace);
  const preview = reports.previewProgressReport(workspace.runs[0], report([first, second]));
  assert.equal(preview.duplicates.length, 1);
  assert.equal(preview.additions.length, 1);
  const next = reports.importProgressReport(workspace, report([first, second]));
  assert.deepEqual(next.runs[0].history, [first, second]);
  assert.equal(reports.importProgressReport(next, report([first])), next);
  assert.equal(JSON.stringify(workspace), before);
});

test("same-step observations need distinct identities, not guessed loss reconciliation", () => {
  const first = event();
  const second = event({ evalLoss: 0.9, recordedAt: "2026-09-13T16:01:00.000Z" });
  const paused = event({ status: "paused", recordedAt: second.recordedAt });
  const workspace = reports.importProgressReport(fixture(), report([first, second, paused]));
  assert.deepEqual(workspace.runs[0].history, [first, second, paused]);
  assert.throws(() => reports.importProgressReport(workspace, report([first, paused, second])), /journal order/);
  const competing = report([first, { ...second, evalLoss: 0.8 }]);
  const before = JSON.stringify(workspace);
  const preview = reports.previewProgressReport(workspace.runs[0], competing);
  assert.equal(preview.duplicates.length, 1);
  assert.match(preview.conflicts[0].message, /evalLoss/);
  assert.equal(preview.run, workspace.runs[0]);
  assert.throws(() => reports.importProgressReport(workspace, competing), /conflict/i);
  assert.equal(JSON.stringify(workspace), before);
});

test("progress identity is independent of JSON key order and timestamp spelling", () => {
  const first = event({ loss: 0 });
  const workspace = reports.importProgressReport(fixture(), report([first]));
  const equivalent = Object.fromEntries(Object.entries({ ...first, recordedAt: "2026-09-13T18:00:00+02:00" }).reverse());
  assert.equal(reports.importProgressReport(workspace, report([equivalent])), workspace);
  assert.equal(workspace.runs[0].history[0].recordedAt, first.recordedAt);
  assert.throws(() => reports.importProgressReport(workspace, report([{ ...first, loss: null }])), /conflict/i);
});

test("closed histories allow exact replays but cannot be extended or altered", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const input = report([event(), event({ status, step: status === "completed" ? 69 : 10, recordedAt: "2026-09-13T17:00:00.000Z" })]);
    const workspace = reports.importProgressReport(fixture(), input);
    const before = JSON.stringify(workspace);
    assert.equal(reports.importProgressReport(workspace, input), workspace);
    assert.throws(() => reports.importProgressReport(workspace, report([...input.updates, { ...input.updates[1], recordedAt: "2026-09-13T18:00:00.000Z" }])), /closed/);
    assert.throws(() => reports.importProgressReport(workspace, report([input.updates[0], { ...input.updates[1], note: "Changed evidence" }])), /conflict/i);
    assert.equal(JSON.stringify(workspace), before);
  }
});

test("unordered, missing historical and cross-run evidence fails atomically", () => {
  const first = event();
  const second = event({ step: 20, recordedAt: "2026-09-13T17:00:00.000Z" });
  const workspace = reports.importProgressReport(fixture(), report([first, second]));
  const before = JSON.stringify(workspace);
  for (const input of [
    report([second, first]),
    report([event({ step: 15, recordedAt: "2026-09-13T16:30:00.000Z" })]),
    report([first], "another-run"),
    report([second, event({ step: 21, recordedAt: "2026-09-13T18:00:00.000Z" }), event({ step: 19, recordedAt: "2026-09-13T19:00:00.000Z" })]),
    report([{ ...second, loss: -1 }]),
    report([]),
  ]) {
    assert.throws(() => reports.importProgressReport(workspace, input));
    assert.equal(JSON.stringify(workspace), before);
  }
});

test("duplicate entries in a file do not add duplicate history", () => {
  const first = event();
  const second = event({ step: 20 });
  const input = report([first, first, second, second]);
  const preview = reports.previewProgressReport(fixture().runs[0], input);
  assert.equal(preview.additions.length, 2);
  assert.equal(preview.duplicates.length, 2);
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(reports.importProgressReport(fixture(), input).runs[0].history, [first, second]);
});

test("legacy repeated observations remain replayable without rewriting their history", () => {
  const workspace = fixture();
  for (const update of [event(), event({ note: "Another manual observation" }), event()]) {
    workspace.runs[0] = recordProgress(workspace.runs[0], update);
  }
  assert.equal(reports.importProgressReport(workspace, report(workspace.runs[0].history)), workspace);
});

test("managed progress cannot be replaced by an external report", () => {
  const workspace = fixture();
  workspace.runs[0].localJobId = "job-1";
  assert.throws(() => reports.importProgressReport(workspace, report([event()])), /Managed/);
});

test("a full journal still permits duplicate-only reports but cannot grow past its limit", () => {
  const workspace = fixture();
  const history = Array.from({ length: 10000 }, (_, step) => event({
    step, totalSteps: 10001, recordedAt: new Date(Date.parse("2026-09-13T16:00:00.000Z") + step).toISOString(),
  }));
  const last = history.at(-1);
  workspace.runs[0] = { ...workspace.runs[0], status: last.status, step: last.step, totalSteps: last.totalSteps, updatedAt: last.recordedAt, history };
  assert.deepEqual(validateWorkspace(workspace), workspace);
  assert.equal(reports.importProgressReport(workspace, report([last])), workspace);
  const update = { ...last, step: 10000, recordedAt: "2026-09-13T17:00:00.000Z" };
  const before = JSON.stringify(workspace);
  assert.throws(() => reports.importProgressReport(workspace, report([last, update])), /history limit/);
  assert.equal(JSON.stringify(workspace), before);
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
  // Still a SyntaxError, but in words: this message reaches the recovery banner, which reads
  // "Your workspace could not be opened: <message>. Your stored data has not been changed."
  assert.throws(() => loadWorkspace(storage), (error) => {
    assert.ok(error instanceof SyntaxError);
    assert.doesNotMatch(error.message, /JSON input|Unexpected token|position \d+|in JSON at/);
    assert.match(error.message, /not valid JSON/);
    return true;
  });
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

test("versioned backups and the explicit legacy migration preserve workspace v1", () => {
  const workspace = fixture();
  workspace.runs[0] = recordProgress(workspace.runs[0], event());
  const before = JSON.stringify(workspace);
  const source = exportWorkspaceBackup(workspace, timestamp);
  assert.deepEqual(Object.keys(JSON.parse(source)), ["schema", "exportedAt", "workspace"]);
  const restored = parseWorkspaceBackup(source);
  assert.equal(restored.format, BACKUP_SCHEMA);
  assert.equal(restored.exportedAt, timestamp);
  assert.equal(restored.migration, null);
  assert.deepEqual(restored.workspace, workspace);
  const legacy = structuredClone(workspace);
  for (const key of ["adapter", "familiarId", "instanceId"]) delete legacy.runs[0].recipe[key];
  const migrated = parseWorkspaceBackup(JSON.stringify(legacy));
  assert.equal(migrated.format, "legacy-workspace-v1");
  assert.equal(migrated.exportedAt, null);
  assert.equal(migrated.migration, "legacy-workspace-v1-to-backup-v1");
  assert.deepEqual(migrated.workspace, workspace);
  assert.equal(JSON.stringify(workspace), before);
});

test("future backup schemas and corrupt histories are rejected without mutation", () => {
  const workspace = fixture();
  const before = JSON.stringify(workspace);
  const envelope = JSON.parse(exportWorkspaceBackup(workspace, timestamp));
  for (const input of [
    { ...workspace, version: 2 },
    { ...workspace, schema: "mamase.workspace-backup.v2" },
    { ...envelope, schema: "mamase.workspace-backup.v2" },
    { ...envelope, workspace: { ...workspace, version: 2 } },
    { ...envelope, futureField: "not silently discarded" },
    { ...envelope, exportedAt: "not a date" },
    { ...envelope, exportedAt: " ".repeat(90) + "September 13, 2026" },
    { ...workspace, runs: [{ ...workspace.runs[0], step: 1 }] },
    null, [],
  ]) {
    assert.throws(() => parseWorkspaceBackup(JSON.stringify(input)));
    assert.equal(JSON.stringify(workspace), before);
  }
  assert.throws(() => parseWorkspaceBackup("broken JSON"), SyntaxError);
  assert.throws(() => parseWorkspaceBackup(" ".repeat(MAX_BACKUP_BYTES + 1)), /size limit/);
});

test("compact envelopes round-trip a full-size workspace without bypassing storage limits", () => {
  const workspace = createWorkspace();
  workspace.programs = Array.from({ length: 5000 }, (_, index) => ({ id: `p-${index}`, name: "Synthetic", description: "" }));
  const limit = 4 * 1024 * 1024;
  let remaining = limit - new TextEncoder().encode(JSON.stringify(workspace)).length;
  for (const program of workspace.programs) {
    const bytes = Math.min(1000, remaining);
    program.description = "x".repeat(bytes);
    remaining -= bytes;
  }
  assert.equal(remaining, 0);
  const source = exportWorkspaceBackup(workspace, timestamp);
  assert.ok(new TextEncoder().encode(source).length > limit);
  assert.ok(new TextEncoder().encode(source).length <= MAX_BACKUP_BYTES);
  assert.deepEqual(parseWorkspaceBackup(source).workspace, workspace);
  workspace.programs.at(-1).description += "x";
  assert.throws(() => exportWorkspaceBackup(workspace, timestamp), /4 MB storage limit/);
  assert.throws(() => parseWorkspaceBackup(JSON.stringify(workspace)), /4 MB storage limit/);
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
  assert.match(exported.description, /npm run lab -- prepare/);
  assert.match(exported.splitPolicy, /SHA-256/);
  assert.equal(Object.hasOwn(exported, "localJobId"), false);
});

test("managed recipe exports retain job identity and the managed split policy", () => {
  const workspace = fixture();
  const exported = exportRecipe({ ...workspace.runs[0], localJobId: "job-1" }, workspace);
  assert.equal(exported.execution, "local-mlx");
  assert.equal(exported.localJobId, "job-1");
  assert.match(exported.description, /does not start training/);
  assert.match(exported.splitPolicy, /shuffles source indices with seed 42/);
  assert.equal(exported.dataset.sha256, dataset.sha256);
  assert.equal(exported.estimatedOptimizerSteps, 69);
});

test("user text is escaped and CSV cells cannot become spreadsheet formulas", () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  const run = fixture().runs[0];
  const csv = runsCsv([{ ...run, name: '=HYPERLINK("test")' }]);
  assert.match(csv, /"'=HYPERLINK\(""test""\)"/);
  assert.equal(runsCsv([]).split("\r\n").length, 1);
});

// #44: a screen-reader pass over the accessibility tree found that a failed restore announces
// "Unexpected end of JSON input" -- the JavaScript engine's own words, in an assertive alert. Every
// other failure in parseWorkspaceBackup has a written message, and two other file-parsing paths in
// this codebase already catch SyntaxError and say what failed and that nothing changed. This one
// did not, so the one moment a user most needs to know their workspace survived was the moment the
// message stopped being about their workspace at all.
test("a backup that is not valid JSON fails in words, not in the parser's", () => {
  for (const malformed of ['{"version":1,"workspace":{"runs":', "", "not json at all", "{,}"]) {
    assert.throws(() => parseWorkspaceBackup(malformed), (error) => {
      assert.doesNotMatch(error.message, /JSON input|Unexpected token|position \d+|in JSON at/,
        `raw parser text reached the user for ${JSON.stringify(malformed.slice(0, 24))}: ${error.message}`);
      assert.match(error.message, /not valid JSON/);
      // An atomic failure that does not say so is indistinguishable from a partial one by ear.
      assert.match(error.message, /No changes were made/);
      return true;
    }, JSON.stringify(malformed.slice(0, 24)));
  }
});

test("a syntactically valid backup that is the wrong shape keeps its own written message", () => {
  // The new guard must catch SyntaxError only, and leave every other assertion's wording alone.
  assert.throws(() => parseWorkspaceBackup('"a string"'), /Expected a workspace backup object/);
  assert.throws(() => parseWorkspaceBackup('{"schema":"nope"}'), /Unsupported backup schema/);
});
