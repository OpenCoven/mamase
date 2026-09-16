import test from "node:test";
import assert from "node:assert/strict";
import { handbookModel, STEP_COPY } from "../handbook.js";
import { workflowReceipt } from "../workflow-receipt.mjs";
import { createWorkspace, createRun } from "../workspace.js";

const createdAt = "2026-09-14T00:00:00.000Z";

function workspaceWith(recipeOverrides = {}) {
  const workspace = createWorkspace();
  workspace.datasets.push({
    id: "data", name: "Examples", filename: "data.jsonl", bytes: 100, records: 6,
    format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original",
    holdout: 20, sha256: "a".repeat(64), createdAt,
  });
  workspace.runs.push(createRun({
    id: "run-1", name: "Coven adapter", createdAt,
    recipe: {
      workflow: "cli", method: "lora", programId: workspace.programs[0].id, datasetId: "data",
      student: "./models/local", teacher: "", rank: 4, alpha: 8, learningRate: 0.001,
      epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 128,
      objective: "Learn examples.", outputPath: "./outputs/local",
      familiarId: "fam", instanceId: "inst", ...recipeOverrides,
    },
  }, workspace));
  return workspace;
}

test("an empty workspace teaches the first steps instead of erroring", () => {
  const model = handbookModel(createWorkspace(), {});
  assert.equal(model.empty, true);
  assert.equal(model.run, null);
  assert.ok(model.steps.length, "The empty state is still a path, not a blank page");
  assert.ok(model.steps.every((step) => step.title && step.purpose));
});

test("the model's steps equal the receipt's steps exactly", () => {
  const workspace = workspaceWith();
  const model = handbookModel(workspace, {});
  const receipt = workflowReceipt(workspace, workspace.runs[0]);
  assert.equal(model.lane, receipt.lane);
  assert.deepEqual(
    model.steps.map(({ id, state }) => ({ id, state })),
    receipt.steps.map(({ id, state }) => ({ id, state })),
    "The page must never disagree with npm run ops -- receipt",
  );
  assert.ok(model.next, "This run genuinely has a next step");
  assert.equal(model.next.id, receipt.nextAction.step);
  assert.equal(model.next.state, "next");
  assert.equal(typeof model.next.title, "string");
  assert.ok(model.next.title.length, "model.next must be decorated");
});

test("every branch returns exactly the documented eight keys, with an honest state and lane", () => {
  const KEYS = ["blockers", "choices", "empty", "lane", "next", "run", "state", "steps"];

  const empty = handbookModel(createWorkspace(), {});
  assert.deepEqual(Object.keys(empty).sort(), KEYS, "empty-workspace branch");
  assert.equal(empty.state, null, "no receipt ran, so state must not be invented");

  const missingDataset = workspaceWith();
  missingDataset.datasets = [];
  const errored = handbookModel(missingDataset, {});
  assert.deepEqual(Object.keys(errored).sort(), KEYS, "receipt-unavailable branch");
  assert.equal(errored.state, null, "no receipt ran, so state must not be invented");

  const workspace = workspaceWith();
  const model = handbookModel(workspace, {});
  const receipt = workflowReceipt(workspace, workspace.runs[0]);
  assert.deepEqual(Object.keys(model).sort(), KEYS, "success branch");
  assert.equal(model.state, receipt.state);
  assert.equal(model.lane, receipt.lane);
});

test("every rendered step carries copy, and every receipt step ID is covered", () => {
  const model = handbookModel(workspaceWith(), {});
  for (const step of model.steps) {
    assert.ok(step.title, `${step.id} has no title`);
    assert.ok(step.purpose, `${step.id} has no purpose`);
  }
  for (const id of ["plan", "prepare", "preflight", "train", "evaluate", "human-review", "launch", "job", "register", "test", "select-lane", "capability"]) {
    assert.ok(STEP_COPY[id]?.title, `Missing copy for receipt step ${id}`);
  }
});

test("the managed lane is derived with capability and job, never with a bundle", () => {
  const workspace = workspaceWith({ workflow: "managed", familiarId: "", instanceId: "" });
  const model = handbookModel(workspace, { capability: { enabled: true, available: true, hosted: false } });
  assert.equal(model.lane, "managed-mlx");
  assert.deepEqual(model.steps.map((step) => step.id), ["plan", "capability", "launch", "job", "register", "test", "human-review"]);
});

test("an unselected lane blocks and offers no next action", () => {
  const workspace = workspaceWith({ workflow: undefined, familiarId: "", instanceId: "" });
  const model = handbookModel(workspace, {});
  assert.equal(model.lane, "unselected");
  assert.ok(model.blockers.length);
  assert.equal(model.next, null);
});

test("a blocked run offers no next action", () => {
  const workspace = workspaceWith({ workflow: undefined, familiarId: "", instanceId: "" });
  const model = handbookModel(workspace, {});
  assert.ok(model.blockers.length);
  assert.equal(model.next, null);
});

test("a run whose dataset was deleted renders a blocker, not a crash", () => {
  const workspace = workspaceWith();
  workspace.datasets = [];
  const model = handbookModel(workspace, {});
  assert.equal(model.next, null);
  assert.equal(model.blockers.length, 1);
  assert.match(model.blockers[0].message, /dataset/i);
});

test("the most recently updated run is adopted and others are offered", () => {
  const workspace = workspaceWith();
  workspace.runs.push({ ...workspace.runs[0], id: "run-2", name: "Newer", updatedAt: "2026-09-15T00:00:00.000Z" });
  workspace.runs[0].updatedAt = "2026-09-13T00:00:00.000Z";
  const model = handbookModel(workspace, {});
  assert.equal(model.run.id, "run-2");
  assert.deepEqual(model.choices.map((choice) => choice.id).sort(), ["run-1", "run-2"]);
  assert.equal(handbookModel(workspace, { runId: "run-1" }).run.id, "run-1");
});
