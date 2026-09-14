import test from "node:test";
import assert from "node:assert/strict";
import { parseRoute, runUrl, selectRuns, searchWorkspace, compareEvaluations, readRecipeDraft, DRAFT_KEY } from "../experience.js";
import { createWorkspace } from "../workspace.js";

test("run filters round-trip through shareable hash routes", () => {
  const filters = { query: "Coven / & local", status: "running", program: "coven", sort: "progress", runPage: 3 };
  assert.deepEqual(parseRoute(runUrl(filters)), { page: "sessions", id: undefined, ...filters });
  assert.equal(runUrl({ query: "", status: "all", program: "all", sort: "updated", runPage: 1 }), "#/sessions");
  assert.equal(parseRoute("#/checkpoints/model-1").id, "model-1");
});

test("run exploration filters and sorts without changing the workspace", () => {
  const runs = [
    { id: "a", name: "Alpha", status: "running", step: 1, totalSteps: 10, updatedAt: "2026-09-12", createdAt: "2026-09-12", recipe: { student: "Local/model", programId: "coven" } },
    { id: "b", name: "Beta", status: "planned", step: 0, totalSteps: 10, updatedAt: "2026-09-13", createdAt: "2026-09-13", recipe: { student: "Local/model", programId: "other" } },
  ];
  const defaults = parseRoute("#/sessions");
  assert.deepEqual(selectRuns(runs, defaults).map((run) => run.id), ["b", "a"]);
  assert.deepEqual(selectRuns(runs, { ...defaults, query: " local ", status: "running", program: "coven" }).map((run) => run.id), ["a"]);
  assert.deepEqual(selectRuns(runs, { ...defaults, sort: "progress" }).map((run) => run.id), ["a", "b"]);
  assert.deepEqual(runs.map((run) => run.id), ["a", "b"]);
});

test("workspace search resolves records to their own destinations", () => {
  const workspace = createWorkspace();
  workspace.datasets.push({ id: "d1", name: "Needle examples", filename: "data.jsonl", teacher: "" });
  workspace.runs.push({ id: "r1", name: "Needle run", recipe: { student: "model" } });
  workspace.artifacts.push({ id: "a1", name: "Needle adapter", path: "./models/a" });
  const results = searchWorkspace(workspace, "needle");
  assert.deepEqual(results.map((result) => result.href), ["#/datasets/d1", "#/sessions/r1", "#/checkpoints/a1"]);
  assert.equal(searchWorkspace(workspace, "does not exist").length, 0);
});

test("evaluation deltas require matching, explicit comparison metadata", () => {
  const first = { id: "e1", benchmark: "Reasoning v1", score: 60, maximum: 100, samples: 50, notes: "holdout-v1; seed=42; greedy" };
  const second = { ...first, id: "e2", score: 75 };
  assert.deepEqual(compareEvaluations(first, second), { compatible: true, reasons: [], delta: 15 });
  for (const change of [{ benchmark: "Reasoning v2" }, { maximum: 200 }, { samples: 51 }, { notes: "" }, { notes: "different split" }]) {
    const result = compareEvaluations(first, { ...second, ...change });
    assert.equal(result.compatible, false);
    assert.equal(result.delta, null);
    assert.ok(result.reasons.length);
  }
  assert.equal(compareEvaluations(first, first).compatible, false);
});

test("draft recovery rejects corrupt or unexpected data without deleting it", () => {
  const defaults = { name: "", method: "lora", datasetId: "" };
  let source = null;
  const storage = { getItem: (key) => { assert.equal(key, DRAFT_KEY); return source; } };
  assert.equal(readRecipeDraft(storage, defaults), null);
  source = JSON.stringify({ version: 1, draft: { ...defaults, name: "Draft" } });
  assert.equal(readRecipeDraft(storage, defaults).name, "Draft");
  source = '{"version":1,"draft":{"name":42}}';
  assert.throws(() => readRecipeDraft(storage, defaults), /draft/i);
  assert.equal(source, '{"version":1,"draft":{"name":42}}');
  source = "broken";
  assert.throws(() => readRecipeDraft(storage, defaults));
});

test("paired comparisons also require identical suite, decoding, and familiar conditions", () => {
  const first = {
    id: "paired-1", benchmark: "Coven v1", score: 2, maximum: 4, samples: 4, notes: "Paired rule checks",
    comparison: {
      suite: { sha256: "a".repeat(64) }, decoding: { doSample: false, numBeams: 1, maxNewTokens: 128, seed: 42 },
      familiarId: "cody", instanceId: "test-coven", device: "cpu",
    },
  };
  const second = { ...structuredClone(first), id: "paired-2", score: 3 };
  assert.equal(compareEvaluations(first, second).delta, 25);
  for (const change of [
    { comparison: undefined },
    { comparison: { ...second.comparison, suite: { sha256: "b".repeat(64) } } },
    { comparison: { ...second.comparison, decoding: { ...second.comparison.decoding, maxNewTokens: 64 } } },
    { comparison: { ...second.comparison, familiarId: "nova" } },
    { comparison: { ...second.comparison, instanceId: "another-coven" } },
    { comparison: { ...second.comparison, device: "mps" } },
  ]) {
    const result = compareEvaluations(first, { ...second, ...change });
    assert.equal(result.compatible, false);
    assert.equal(result.delta, null);
  }
});

test("pre-lab drafts recover with explicit new-field defaults without accepting arbitrary omissions", () => {
  const legacy = { name: "Keep my draft", method: "lora", datasetId: "data" };
  const defaults = { name: "", method: "lora", datasetId: "", adapter: "lora", familiarId: "", instanceId: "" };
  let source = JSON.stringify({ version: 1, draft: legacy });
  const storage = { getItem: () => source };
  assert.deepEqual(readRecipeDraft(storage, defaults), { ...defaults, ...legacy });
  for (const draft of [{ ...legacy, extra: "unexpected" }, { method: "lora", datasetId: "data" }, { ...legacy, adapter: null }]) {
    source = JSON.stringify({ version: 1, draft });
    assert.throws(() => readRecipeDraft(storage, defaults), /invalid fields/);
  }
});
