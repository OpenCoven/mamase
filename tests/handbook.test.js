import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handbookModel, STEP_COPY, HANDBOOK_BOUNDARY } from "../handbook.js";
import { workflowReceipt } from "../workflow-receipt.mjs";
import { createWorkspace, createRun } from "../workspace.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const createdAt = "2026-09-14T00:00:00.000Z";

// Derived from the generator's own source, not a hand-kept list, so a new
// step id added to workflow-receipt.mjs cannot silently sail past coverage.
function receiptStepIds() {
  const source = readFileSync(fileURLToPath(new URL("../workflow-receipt.mjs", import.meta.url)), "utf8");
  const ids = new Set([...source.matchAll(/\bstep\(\s*"([^"]+)"/g)].map((match) => match[1]));
  assert.ok(ids.size, "The generator must declare at least one step id.");
  return [...ids];
}

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

test("first-run steps are fresh per call, and next shares identity with a steps entry on both branches", () => {
  const first = handbookModel(createWorkspace(), {});
  const second = handbookModel(createWorkspace(), {});
  assert.notEqual(first.steps, second.steps, "each call must get its own array");
  assert.notEqual(first.steps[0], second.steps[0], "each call must get its own step objects");
  first.steps[0].title = "MUTATED";
  assert.notEqual(second.steps[0].title, "MUTATED", "mutating one call's steps must not poison another's");
  assert.equal(first.next, first.steps[0], "empty branch: next is the same reference as steps[0]");

  const workspace = workspaceWith();
  const model = handbookModel(workspace, {});
  const matching = model.steps.find((step) => step.id === model.next.id);
  assert.equal(model.next, matching, "success branch: next must share identity with its entry in steps");
});

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

test("copy can never override a receipt field it collides with", () => {
  const workspace = workspaceWith();
  const original = STEP_COPY.prepare.requiresApproval;
  STEP_COPY.prepare.requiresApproval = "COPY MUST NOT WIN";
  try {
    const model = handbookModel(workspace, {});
    const receipt = workflowReceipt(workspace, workspace.runs[0]);
    const modelPrepare = model.steps.find((step) => step.id === "prepare");
    const receiptPrepare = receipt.steps.find((step) => step.id === "prepare");
    assert.equal(modelPrepare.requiresApproval, receiptPrepare.requiresApproval, "The receipt's field must survive a colliding copy key");
  } finally {
    if (original === undefined) delete STEP_COPY.prepare.requiresApproval;
    else STEP_COPY.prepare.requiresApproval = original;
  }
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

test("every rendered step carries copy, and every receipt step id is covered (derived from the generator)", () => {
  const model = handbookModel(workspaceWith(), {});
  for (const step of model.steps) {
    assert.ok(step.title, `${step.id} has no title`);
    assert.ok(step.purpose, `${step.id} has no purpose`);
  }
  for (const id of receiptStepIds()) {
    assert.ok(STEP_COPY[id]?.title, `Missing copy for receipt step ${id}`);
    assert.ok(STEP_COPY[id]?.purpose, `Missing purpose for receipt step ${id}`);
    assert.ok(STEP_COPY[id]?.boundaries, `Missing boundaries for receipt step ${id} — this is load-bearing honesty, not filler`);
  }
});

test("a step id with no STEP_COPY entry still renders instead of being dropped", () => {
  const workspace = workspaceWith();
  const original = STEP_COPY.prepare;
  delete STEP_COPY.prepare;
  try {
    const model = handbookModel(workspace, {});
    const prepare = model.steps.find((step) => step.id === "prepare");
    assert.ok(prepare, "An unrecognised step id must still render, not be dropped");
    assert.equal(prepare.title, "prepare");
    assert.equal(prepare.purpose, "");
    assert.equal(prepare.boundaries, "");
  } finally {
    STEP_COPY.prepare = original;
  }
});

test("the managed lane is derived with capability and job, never with a bundle", () => {
  const workspace = workspaceWith({ workflow: "managed", familiarId: "", instanceId: "" });
  const model = handbookModel(workspace, { capability: { enabled: true, available: true, hosted: false } });
  assert.equal(model.lane, "managed-mlx");
  assert.deepEqual(model.steps.map((step) => step.id), ["plan", "capability", "launch", "job", "register", "test", "human-review"]);
});

test("the managed lane's next action resolves by id, not position, when they would disagree", () => {
  const jobId = "job-11111111-2222-3333-4444-555555555555";
  const workspace = workspaceWith({ workflow: "managed", familiarId: "", instanceId: "" });
  workspace.runs[0].localJobId = jobId;
  const capability = { enabled: true, available: true, hosted: false };
  const job = { id: jobId, status: "running", run: { id: "run-1", status: "running", step: 1, totalSteps: 4 } };
  const model = handbookModel(workspace, { capability, job });
  const receipt = workflowReceipt(workspace, workspace.runs[0], { capability, job });
  // plan and launch are already "done" ahead of "job" in step order; a
  // heuristic that assumed a fixed position (e.g. "the step after launch is
  // always next") would still land on "job" here by luck. What proves the
  // resolution is id-based is that "launch" — earlier in array order — is
  // done, not next, while the receipt's nextAction explicitly names "job".
  assert.equal(receipt.nextAction.step, "job");
  assert.equal(model.steps.find((step) => step.id === "launch").state, "done");
  assert.equal(model.next.id, "job");
  assert.equal(model.next.state, "next");
});

test("a capability probe for a PEFT run is never forwarded to the receipt", () => {
  const workspace = workspaceWith();
  const model = handbookModel(workspace, { capability: { enabled: true, available: true, hosted: false } });
  assert.equal(model.lane, "peft");
  assert.equal(model.blockers.length, 0, "A capability lookup must never reach workflowReceipt for the PEFT lane");
  assert.ok(model.steps.length, "A leaked capability/job assertion must not collapse the whole handbook into the error branch");
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

test("an unknown runId falls back to the most recently updated run, not the empty branch", () => {
  const workspace = workspaceWith();
  const model = handbookModel(workspace, { runId: "deleted-run" });
  assert.equal(model.empty, false, "Real runs exist; the workspace is not empty");
  assert.equal(model.run.id, "run-1");
  assert.ok(model.choices.length, "choices must not contradict an empty:true claim");
});

test("a run with no updatedAt sorts oldest, not newest", () => {
  const workspace = workspaceWith();
  workspace.runs.push({ ...workspace.runs[0], id: "run-2", name: "No timestamp", updatedAt: undefined });
  const model = handbookModel(workspace, {});
  assert.equal(model.run.id, "run-1", "A missing timestamp must not be treated as the most recent");
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

test("setup exists on exactly the steps that need an environment, with non-empty commands and note", () => {
  const NEEDS_SETUP = new Set(["preflight", "capability"]);
  for (const id of receiptStepIds()) {
    if (NEEDS_SETUP.has(id)) {
      assert.ok(STEP_COPY[id]?.setup, `${id} should carry setup instructions`);
      assert.ok(STEP_COPY[id].setup.commands?.trim().length, `${id}'s setup.commands must be non-empty`);
      assert.ok(STEP_COPY[id].setup.note?.trim().length, `${id}'s setup.note must be non-empty`);
    } else {
      assert.ok(!STEP_COPY[id]?.setup, `${id} should not carry setup instructions`);
    }
  }
});

test("no setup command names a path that does not exist in this repository", () => {
  const checked = [];
  for (const [id, copy] of Object.entries(STEP_COPY)) {
    if (!copy.setup) continue;
    // Negative lookbehind excludes ".venv-training/bin", which is not a path
    // under the repository's training/ directory even though it contains
    // the substring "training/".
    const paths = [...copy.setup.commands.matchAll(/(?<![\w.-])training\/[\w.-]+/g)].map((match) => match[0]);
    assert.ok(paths.length, `${id}'s setup should reference at least one training/ path`);
    for (const path of paths) {
      assert.ok(existsSync(repoRoot + path), `${id}'s setup references a path that does not exist: ${path}`);
      checked.push(path);
    }
  }
  assert.ok(checked.includes("training/requirements.txt"));
  assert.ok(checked.includes("training/requirements-mlx.txt"));
});

test("HANDBOOK_BOUNDARY is exported, non-empty, and is what the empty state's curate step shows", () => {
  assert.equal(typeof HANDBOOK_BOUNDARY, "string");
  assert.ok(HANDBOOK_BOUNDARY.trim().length);
  assert.match(HANDBOOK_BOUNDARY, /permission/i);
  const model = handbookModel(createWorkspace(), {});
  const curate = model.steps.find((step) => step.id === "curate");
  assert.equal(curate.boundaries, HANDBOOK_BOUNDARY, "curate must not carry a second, divergent copy of this claim");
});
