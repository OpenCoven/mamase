import test from "node:test";
import assert from "node:assert/strict";
import { trainingWorkflow, runGuidance, formatLoss, lossReading, modelName } from "../training-guide.js";

const run = (patch = {}) => ({ id: "run", name: "Experiment", status: "planned", step: 0, totalSteps: 4, history: [], recipe: { adapter: "lora", workflow: "managed" }, ...patch });
const job = (status, step = 0) => ({ id: "job", status, run: run({ status: "running", step, localJobId: "job" }) });

test("new workflows are explicit without reclassifying old managed or external records", () => {
  assert.equal(trainingWorkflow(run()), "managed");
  assert.equal(trainingWorkflow(run({ recipe: { workflow: "cli" } })), "cli");
  assert.equal(trainingWorkflow(run({ recipe: {}, status: "running" })), "cli");
  assert.equal(trainingWorkflow(run({ recipe: {}, status: "running", localJobId: "job" })), "managed");
  assert.equal(trainingWorkflow(run({ recipe: { adapter: "dora" } })), "cli");
});

test("a saved recipe never implies that training is already running or its model is verified", () => {
  const guide = runGuidance(run(), { available: true });
  assert.equal(guide.phase, "ready");
  assert.equal(guide.action, "start");
  assert.match(guide.title, /has not started/);
  assert.match(guide.description, /checked/);
  assert.equal(runGuidance(run(), { loading: true }).phase, "checking");
  assert.equal(runGuidance(run(), { available: false }).phase, "setup");
  assert.equal(runGuidance(run(), { available: true, busy: true }).phase, "busy");
});

test("preparing, learning, finishing and stopping remain distinct states", () => {
  for (const [status, step, phase] of [["starting", 0, "preparing"], ["running", 1, "training"], ["running", 4, "finishing"], ["cancelling", 2, "stopping"]]) {
    const guide = runGuidance(run(), { job: job(status, step) });
    assert.equal(guide.phase, phase);
    assert.equal(guide.stage, 1);
    assert.notEqual(guide.action, "start");
  }
});

test("connection loss does not imply a stopped job or offer a duplicate launch", () => {
  const guide = runGuidance(run(), { job: job("running", 2), error: "Connection lost" });
  assert.equal(guide.phase, "connection");
  assert.equal(guide.action, "recheck");
  assert.match(guide.description, /last saved|last reported/);
  assert.equal(runGuidance(run({ localJobId: "job" }), { available: true }).phase, "connection");
});

test("saved adapter, pending workspace registration and missing output are different outcomes", () => {
  const completed = run({ localJobId: "job", status: "completed", step: 4 });
  const finished = { ...job("completed", 4), artifact: { id: "artifact-job" } };
  assert.equal(runGuidance(completed, { job: finished }).phase, "syncing");
  const guide = runGuidance(completed, { job: finished, artifact: finished.artifact });
  assert.equal(guide.phase, "complete");
  assert.equal(guide.action, "review");
  assert.equal(guide.stage, 2);
  assert.match(guide.description, /not.*standalone|needs.*base/i);
  assert.equal(runGuidance(run({ status: "completed", recipe: {} })).phase, "unregistered");
});

test("failure and cancellation explain recovery without pretending there is a completed adapter", () => {
  for (const status of ["failed", "cancelled"]) {
    const guide = runGuidance(run(), { job: job(status, 2) });
    assert.equal(guide.phase, status);
    assert.equal(guide.action, "duplicate");
    assert.match(guide.description, /No completed adapter/);
  }
});

test("terminal workflow reports its external execution boundary", () => {
  const recipe = { workflow: "cli", adapter: "lora" };
  assert.equal(runGuidance(run({ recipe })).action, "export");
  const guide = runGuidance(run({ recipe, status: "running", step: 2 }));
  assert.equal(guide.action, "report");
  assert.match(guide.description, /does not monitor/);
});

test("loss summaries are readable while preserving zero and small nonzero measurements", () => {
  assert.equal(formatLoss(null), "Not recorded");
  assert.equal(formatLoss(0), "0.0000");
  assert.equal(formatLoss(5.6047588757106235), "5.6048");
  assert.notEqual(formatLoss(0.0000001), "0.0000");
  assert.match(lossReading([]), /No holdout/);
  assert.match(lossReading([{ evalLoss: 2 }, { evalLoss: 1.5 }]), /0.5000 lower/);
  assert.match(lossReading([{ evalLoss: 1 }, { evalLoss: 2 }]), /higher/);
  assert.match(lossReading([{ evalLoss: 1 }, { evalLoss: 2 }]), /not.*grade|not.*approval/);
});

test("model headings show a name rather than an entire filesystem path", () => {
  assert.equal(modelName("/models/coven/adapter/"), "adapter");
  assert.equal(modelName("Qwen/Model"), "Model");
});
