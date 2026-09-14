import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspace, createRun, recordProgress, validateWorkspace } from "../workspace.js";
import { trainingIdentity, mergeTrainingJob } from "../training-state.js";

function fixture() {
  const workspace = createWorkspace();
  const createdAt = "2026-09-14T00:00:00.000Z";
  workspace.datasets.push({ id: "data", name: "Examples", filename: "data.jsonl", bytes: 100, records: 6, format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original", holdout: 20, sha256: "a".repeat(64), createdAt });
  workspace.runs.push(createRun({ id: "run", name: "Local adapter", createdAt, recipe: { method: "lora", programId: "coven", datasetId: "data", student: "./models/local", teacher: "", rank: 4, alpha: 8, learningRate: .001, epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 128, objective: "Learn examples.", outputPath: "./outputs/local" } }, workspace));
  const run = { ...workspace.runs[0], localJobId: "job-1" };
  const running = recordProgress(run, { status: "running", step: 0, totalSteps: run.totalSteps, loss: null, evalLoss: null, note: "Trainer process started.", recordedAt: createdAt });
  return { workspace, job: { id: "job-1", identity: trainingIdentity(run, workspace.datasets[0]), dataset: workspace.datasets[0], run: running, status: "running", artifact: null } };
}

test("managed observations merge idempotently and survive workspace backups", () => {
  const { workspace, job } = fixture();
  const next = mergeTrainingJob(workspace, job);
  assert.equal(workspace.runs[0].status, "planned");
  assert.equal(next.runs[0].localJobId, job.id);
  assert.equal(next.runs[0].history.length, 1);
  assert.deepEqual(mergeTrainingJob(next, job), next);
  assert.deepEqual(validateWorkspace(next), next);
});

test("managed completion registers an artifact once without losing unrelated data", () => {
  const { workspace, job } = fixture();
  job.run = recordProgress(job.run, { status: "completed", step: job.run.totalSteps, totalSteps: job.run.totalSteps, loss: .2, evalLoss: .4, note: "Adapter finalized.", recordedAt: "2026-09-14T00:01:00.000Z" });
  job.status = "completed";
  job.artifact = { id: "artifact-job-1", name: "Local adapter", runId: "run", kind: "adapter", path: "/local/jobs/job-1/adapter", notes: "MLX-LM output", createdAt: job.run.updatedAt };
  workspace.programs.push({ id: "other", name: "Other program", description: "" });
  const next = mergeTrainingJob(workspace, job);
  assert.equal(next.artifacts.length, 1);
  assert.equal(next.programs.length, 2);
  assert.equal(mergeTrainingJob(next, job).artifacts.length, 1);
});

test("managed sync rejects mismatched recipes, divergent history and false artifacts", () => {
  const { workspace, job } = fixture();
  const different = structuredClone(workspace);
  different.runs[0].recipe.rank = 8;
  assert.throws(() => mergeTrainingJob(different, job), /recipe|identity/i);
  const manual = structuredClone(workspace);
  manual.runs[0] = recordProgress(manual.runs[0], { ...job.run.history[0], note: "Different manual update" });
  assert.throws(() => mergeTrainingJob(manual, job), /history/i);
  assert.throws(() => mergeTrainingJob(workspace, { ...job, artifact: { id: "artifact-job-1" } }), /completed/i);
});
