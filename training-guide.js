export function trainingWorkflow(run) {
  if (run.localJobId) return "managed";
  if (run.recipe.workflow) return run.recipe.workflow;
  if (run.recipe.familiarId && run.recipe.instanceId) return "cli";
  return (run.recipe.adapter && run.recipe.adapter !== "lora") || run.status !== "planned" ? "cli" : "managed";
}

export function modelName(path) {
  return path.split(/[/\\]/).filter(Boolean).at(-1) || path;
}

export function formatLoss(value) {
  if (value === null || value === undefined) return "Not recorded";
  if (!Number.isFinite(value)) throw new Error("Loss must be a finite recorded value.");
  return value > 0 && value < 0.0001 ? value.toExponential(2) : value.toFixed(4);
}

export function lossReading(history) {
  const values = history.filter((event) => Number.isFinite(event.evalLoss)).map((event) => event.evalLoss);
  if (!values.length) return "No holdout measurement yet. Holdout examples are kept out of training so you can check how the model handles unfamiliar examples.";
  if (values.length === 1) return "One holdout reading is not a trend. Wait for another reading, then test the finished adapter on fresh examples.";
  const difference = values.at(-1) - values[0];
  const direction = difference === 0 ? "unchanged" : `${formatLoss(Math.abs(difference))} ${difference < 0 ? "lower" : "higher"}`;
  return `Holdout loss is ${direction} than its first reading in this run. ${difference > 0 ? "Review the outputs carefully before choosing this adapter. " : ""}This is a fit measurement, not a grade or approval to use the model.`;
}

export function runGuidance(run, { job = null, artifact = null, available, loading = false, busy = false, error = "", hosted = false } = {}) {
  const workflow = job ? "managed" : trainingWorkflow(run);
  const status = job?.status || run.status;
  const managed = Boolean(job || run.localJobId);
  const result = (phase, title, description, action, stage = 1) => ({ phase, title, description, action, stage, workflow });
  if (status === "completed" && artifact) return artifact.kind && artifact.kind !== "adapter"
    ? result("complete", "Output registered. Review it next.", "This output has a saved reference. Registration is not a quality grade or approval to deploy; review its files and evaluation results.", "review", 2)
    : result("complete", "Adapter saved. Review it next.", "An adapter is a small set of learned changes, not a standalone model. It still needs the same base model. Training finished; quality and deployment have not been approved.", "review", 2);
  if (job?.status === "completed" && job.artifact) return result("syncing", "Adapter saved on disk. Registration is pending.", "The trainer finished, but this browser has not saved its Model library entry yet. Keep the files; do not start another job to recover them.", error ? "sync" : "", 2);
  if (status === "failed" || status === "cancelled") return result(status, status === "failed" ? "Training stopped with an error." : "Training was cancelled.", `No completed adapter was registered by this attempt. ${managed ? "The original data and partial files remain on this Mac. " : ""}Review the details, then duplicate the recipe to make changes and try again.`, "duplicate");
  if (status === "completed" && !managed) return result("unregistered", "Training is recorded as finished. Add its output.", "There is no registered output for this run yet. Import the trainer's result or record the actual output folder before evaluating it.", "register", 2);
  if (hosted && workflow === "managed") return result("hosted", "This hosted workspace cannot start training.", "Your recipe is saved in this browser. Start Mamase on your Mac, export this workspace, then import it into the local app. Model files and examples stay on your machine; Vercel does not run or monitor the job.", "backup");
  if (managed && error) return result("connection", "Live updates need attention.", "These are the last reported observations, not a confirmed live status. Keep the Mamase server running and reconnect before deciding whether to start another attempt.", "recheck");
  if (job?.status === "cancelling") return result("stopping", "Stopping the trainer…", "Cancellation has been requested. Wait for the process to stop; partial files will not be registered as a completed adapter.", "");
  if (job?.status === "starting") return result("preparing", "Preparing training on this Mac.", "The worker is opening the model and preparing the examples. The first learning update can take a little time. Keep the Mamase server running.", "cancel");
  if (job?.status === "running") {
    if (job.run.step === job.run.totalSteps) return result("finishing", "Learning updates finished. Final checks are pending.", "100% of the updates have been reported. Holdout measurements and output files must finish before an adapter is registered.", "cancel");
    return result("training", "Training on this Mac.", "The model is learning from the training examples. Progress counts learning updates, not elapsed time. You can leave this page; keep the Mamase server running.", "cancel");
  }
  if (managed) return result("connection", loading ? "Reconnecting to this run…" : "This server cannot find the linked job.", "The saved history is still here. Reconnect to the server and training folder that owned this job; do not mistake the last saved status for a live process.", "recheck");
  if (workflow === "cli") return status === "planned"
    ? result("external", "Recipe saved for terminal training.", "Mamase will not start this workflow from the browser. Export the recipe, run the commands below, then import the trainer's progress and result.", "export")
    : result("external", status === "paused" ? "External training is recorded as paused." : "External progress record.", "Mamase does not monitor this external process. The values below come from the reports you import or record.", "report");
  if (run.status !== "planned") return result("connection", "No local job is linked to this record.", "A saved progress record is not proof of a running process. Reconnect or duplicate the recipe to begin a managed attempt.", "recheck");
  if (loading || available === undefined) return result("checking", "Checking this Mac's trainer…", "Your recipe is saved. No training has started.", "");
  if (!available || error) return result("setup", "Set up training on this Mac.", "Your recipe is saved, but the local trainer is not ready. Follow the one-time setup below, then check again. No training has started.", "recheck");
  if (busy) return result("busy", "Another job is using the trainer.", "This recipe is saved, not queued or running. Wait for the other job to finish, then check again.", "recheck");
  return result("ready", "Recipe saved. Training has not started.", "Next, choose the original dataset file and confirm Start training. Its fingerprint and the local model folder are checked before the job begins.", "start");
}
