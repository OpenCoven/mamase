import { assert, validateArtifact, validateWorkspace } from "./workspace.js";

export function managedRecipeIssue(recipe) {
  if (recipe.workflow === "cli") return "This recipe uses terminal training. Duplicate it and choose Train on this Mac to use the managed trainer.";
  return (recipe.adapter ?? "lora") === "lora" ? "" : "Managed MLX supports LoRA only. Use the identity-bound CLI for rsLoRA, DoRA or QLoRA.";
}

export function trainingIdentity(run, dataset) {
  return JSON.stringify({ id: run.id, name: run.name, createdAt: run.createdAt, recipe: run.recipe, dataset });
}

export function mergeTrainingJob(workspace, job) {
  const current = workspace.runs.find((run) => run.id === job.run?.id);
  assert(current, "The managed job's run is not in this workspace.");
  const dataset = workspace.datasets.find((item) => item.id === current.recipe.datasetId);
  assert(dataset && trainingIdentity(current, dataset) === job.identity, "Managed job identity does not match this recipe and dataset.");
  assert(trainingIdentity(job.run, job.dataset) === job.identity, "Managed job recipe identity is inconsistent.");
  assert(job.run.localJobId === job.id && (!current.localJobId || current.localJobId === job.id), "This run belongs to another local job.");
  assert(Array.isArray(job.run.history) && current.history.length <= job.run.history.length &&
    JSON.stringify(current.history) === JSON.stringify(job.run.history.slice(0, current.history.length)),
  "Local and managed progress history diverged. Download the managed report before resolving this conflict.");
  const run = validateWorkspace({ ...workspace, runs: [job.run], artifacts: [], evaluations: [] }).runs[0];
  const next = structuredClone(workspace);
  next.runs[next.runs.findIndex((item) => item.id === run.id)] = run;
  if (job.artifact) {
    assert(job.status === "completed" && run.status === "completed", "Only a completed job may register its output.");
    const artifact = validateArtifact(job.artifact, next);
    assert(artifact.runId === run.id && artifact.id === `artifact-${job.id}` && artifact.kind === "adapter", "Invalid managed artifact lineage.");
    const existing = next.artifacts.find((item) => item.id === artifact.id);
    assert(!existing || JSON.stringify(existing) === JSON.stringify(artifact), "The managed artifact conflicts with an existing record.");
    if (!existing) next.artifacts.push(artifact);
  }
  return next;
}

// What a training run shows versus what it says. The visible count changes on every reported step,
// which is right to look at and wrong to listen to: as a live region it queued one announcement per
// flush -- up to five a second -- and a screen reader falls behind the run reading a backlog of step
// counts. `milestone` only changes each tenth of the way, or when the status does, so the announced
// region is written far less often than the visible one. The exact count stays available on demand
// through the progress bar's aria-valuetext.
export function trainingProgress(step, totalSteps, status) {
  const percent = totalSteps > 0 ? Math.floor(Math.min(step, totalSteps) / totalSteps * 100) : 0;
  const tenth = Math.floor(percent / 10) * 10;
  return {
    percent,
    text: `${step} of ${totalSteps} learning updates reported`,
    milestone: `${tenth}:${status}`,
    announcement: `${status}, ${percent}% \u2014 ${step} of ${totalSteps} learning updates reported`,
  };
}
