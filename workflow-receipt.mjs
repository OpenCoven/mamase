import { assert } from "./validation.js";
import { managedRecipeIssue } from "./training-state.js";

export const WORKFLOW_RECEIPT_SCHEMA = "mamase.workflow-receipt.v1";
export const LANES = ["peft", "managed-mlx", "unselected"];
export const STEP_STATES = ["done", "next", "pending", "blocked", "not-applicable"];
export const HANDOFF = "Completion means evidence is ready for human review. It is not deployment, identity replacement, promotion, or a tool grant.";
const SHA = /^[a-f0-9]{64}$/;
const ACTIVE_JOB = ["starting", "running", "cancelling"];

const step = (id, state, details = {}) => ({ id, state, ...details });
const blocker = (code, message) => ({ code, message });

// Capability responses are classified for agents; the command token is never copied into a receipt.
export function classifyCapability(capability) {
  if (capability === undefined) return { state: "unknown", enabled: null, available: null, busy: null, hosted: null, message: "The local runtime was not queried." };
  if (capability === null) return { state: "unreachable", enabled: null, available: null, busy: null, hosted: null, message: "The local Mamase server did not answer. Start it with npm run dev and query again." };
  assert(capability && typeof capability === "object" && !Array.isArray(capability), "Invalid capability response.");
  const { enabled, available, busy, hosted, message, backend } = capability;
  assert(typeof enabled === "boolean" && typeof available === "boolean", "Invalid capability response.");
  const text = typeof message === "string" ? message.slice(0, 500) : "";
  const base = { enabled, available, busy: typeof busy === "boolean" ? busy : null, hosted: hosted === true, backend: typeof backend === "string" ? backend.slice(0, 40) : null, message: text };
  if (hosted === true) return { ...base, state: "unsupported", message: "Hosted Mamase never trains or generates. Use the local app." };
  if (!enabled) return { ...base, state: "disabled" };
  if (!available) return { ...base, state: "unavailable" };
  if (busy === true) return { ...base, state: "busy" };
  return { ...base, state: "available", message: "Runtime probe passed. This is not proof that the base model fits in memory or that training will finish." };
}

export function detectLane(run) {
  if (run.localJobId || run.recipe.workflow === "managed") return { lane: "managed-mlx", reason: run.localJobId ? "The run already records a managed local job." : "The recipe selects Train on this Mac." };
  if (run.recipe.workflow === "cli") return { lane: "peft", reason: "The recipe selects terminal PEFT training." };
  if (run.recipe.familiarId && run.recipe.instanceId) return { lane: "peft", reason: "The recipe binds a familiar and Coven instance; only the identity-bound CLI honours that binding." };
  return { lane: "unselected", reason: "The recipe does not select a workflow and is unbound. Choose managed MLX (LoRA only) or bind a familiar for PEFT." };
}

function validateBundle(bundle, run, dataset) {
  assert(bundle && typeof bundle === "object" && !Array.isArray(bundle), "Invalid bundle.json.");
  assert(["mamase.local-bundle.v1", "mamase.local-bundle.v2"].includes(bundle.schema), "Unsupported bundle schema.");
  assert(SHA.test(bundle.sha256), "Bundle fingerprint is required.");
  const issues = [];
  if (bundle.runId !== run.id) issues.push(blocker("bundle-run-mismatch", "The prepared bundle belongs to another run. Prepare a bundle for this run or select the matching run."));
  if (bundle.dataset?.sha256 !== dataset.sha256) issues.push(blocker("source-changed", "The dataset fingerprint in the bundle differs from the workspace record. The source changed after planning; prepare again and review."));
  if (JSON.stringify(bundle.recipe) !== JSON.stringify(run.recipe)) issues.push(blocker("recipe-changed", "The recipe frozen in the bundle differs from the saved run. Export the recipe again and prepare a new bundle."));
  if (bundle.execution !== undefined && bundle.execution !== "not-started") issues.push(blocker("bundle-execution-state", "The bundle records an unexpected execution state."));
  if (bundle.promotion !== undefined && bundle.promotion !== "not-authorized") issues.push(blocker("bundle-promotion-state", "The bundle claims a promotion state it cannot hold."));
  const context = bundle.familiarContext ? { scope: "selected-sources", sha256: SHA.test(bundle.familiarContext.sha256) ? bundle.familiarContext.sha256 : null } : { scope: "identity-files-only", sha256: null };
  return { issues, context, split: bundle.split ? { train: bundle.split.train, holdout: bundle.split.holdout } : null };
}

function peftSteps(run, dataset, evidence, bundle) {
  const steps = [step("plan", "done", { evidence: { runId: run.id } })];
  const blockers = [];
  const fingerprints = { dataset: dataset.sha256 };
  let context = null;
  const lineage = evidence.artifacts.filter((artifact) => artifact.lineage);
  if (bundle === undefined && lineage.length) {
    fingerprints.bundle = lineage.at(-1).lineage.bundleSha256;
    steps.push(step("prepare", "done", { evidence: { bundleSha256: fingerprints.bundle, source: "artifact-lineage" }, note: "Bundle fingerprint taken from the latest imported result; pass --bundle to verify the prepared files." }));
  } else if (bundle === undefined) {
    steps.push(step("prepare", "next", { command: "npm run lab -- prepare --recipe recipe.json --dataset <examples.jsonl> --identity-dir <familiar> --out <bundle>", requiresApproval: false, note: "Pass --bundle to this receipt after preparing. Selected familiar context needs inspect-context review and --context-sha256." }));
  } else if (bundle === null) {
    blockers.push(blocker("bundle-missing", "The named bundle directory has no readable bundle.json. Prepare the bundle or fix the path."));
    steps.push(step("prepare", "blocked"));
  } else {
    const checked = validateBundle(bundle, run, dataset);
    blockers.push(...checked.issues);
    fingerprints.bundle = bundle.sha256;
    context = checked.context;
    steps.push(step("prepare", checked.issues.length ? "blocked" : "done", { evidence: { bundleSha256: bundle.sha256, context: context.scope, split: checked.split } }));
  }
  const prepared = steps.at(-1).state === "done";
  const artifacts = lineage;
  const matching = artifacts.filter((artifact) => !fingerprints.bundle || artifact.lineage.bundleSha256 === fingerprints.bundle);
  if (fingerprints.bundle && artifacts.length && !matching.length) blockers.push(blocker("bundle-changed", "Imported training results were produced from a different bundle than the one named. Keep both; do not treat them as one attempt."));
  steps.push(step("preflight", matching.length ? "done" : prepared ? "next" : "pending", { command: ".venv/bin/python training/preflight.py --bundle <bundle> --model <local-model> --device cpu", requiresApproval: false, note: "Read-only readiness JSON; exit 1 means blocked. Not an OOM guarantee." }));
  steps.push(step("train", matching.length ? "done" : "pending", { command: ".venv/bin/python training/train.py --bundle <bundle> --model <local-model> --device cpu", requiresApproval: true, evidence: matching.map((artifact) => ({ artifactId: artifact.id, resultSha256: artifact.lineage.resultSha256, context: artifact.lineage.familiarContext ? "selected-sources" : "identity-files-only" })) }));
  const evaluations = evidence.evaluations.filter((evaluation) => matching.some((artifact) => artifact.id === evaluation.artifactId) && evaluation.comparison);
  steps.push(step("evaluate", evaluations.length ? "done" : matching.length ? "next" : "pending", { command: ".venv/bin/python training/evaluate.py --bundle <bundle> --suite <suite.json> --history <journal.json> --task-lineage <lineage.json> --out <bundle>-eval --device cpu", requiresApproval: false, note: "Omitting --history or --task-lineage is allowed but pins the report to independence: \"unverified\" with journalStatus: \"unavailable\"; a mamase.eval-suite.v2 suite reaches mechanically-eligible only when both are supplied and every declaration is complete.", evidence: evaluations.map((evaluation) => ({ evaluationId: evaluation.id, reportSha256: evaluation.comparison.reportSha256, suiteSha256: evaluation.comparison.suite.sha256, regressions: evaluation.comparison.regressions })) }));
  const reviewed = evaluations.filter((evaluation) => evaluation.reviews?.length);
  steps.push(step("human-review", reviewed.length ? "done" : evaluations.length ? "next" : "pending", { note: "A human records the decision in the Mamase UI. Agent judgments are recommendations, never human opinions.", requiresApproval: true, evidence: reviewed.map((evaluation) => ({ evaluationId: evaluation.id, decisions: evaluation.reviews.length })) }));
  if (matching.length) fingerprints.results = matching.map((artifact) => artifact.lineage.resultSha256);
  if (evaluations.length) fingerprints.reports = evaluations.map((evaluation) => evaluation.comparison.reportSha256);
  return { steps, blockers, fingerprints, context };
}

function managedSteps(run, dataset, evidence, capability, job) {
  const steps = [step("plan", "done", { evidence: { runId: run.id } })];
  const blockers = [];
  const fingerprints = { dataset: dataset.sha256 };
  const issue = managedRecipeIssue(run.recipe);
  if (issue) blockers.push(blocker("managed-unsupported-recipe", issue));
  const runtime = classifyCapability(capability);
  if (runtime.state === "unsupported") blockers.push(blocker("hosted-disabled", runtime.message));
  else if (runtime.state === "disabled") blockers.push(blocker("runtime-disabled", "Local training is disabled for this server. Start Mamase with npm run dev."));
  else if (runtime.state === "unavailable") blockers.push(blocker("runtime-unavailable", "The local MLX runtime probe failed. Install the training requirements and query again."));
  const launchedBefore = Boolean(run.localJobId) || Boolean(job);
  const capabilityState = ["available", "busy"].includes(runtime.state) ? "done" : ["unsupported", "disabled", "unavailable"].includes(runtime.state) ? "blocked" : launchedBefore ? "not-applicable" : "next";
  steps.push(step("capability", capabilityState, { evidence: runtime, requiresApproval: false, note: "Query GET /api/training/capabilities on the loopback server. Capabilities never prove model or memory readiness." }));
  if (job !== undefined && job !== null) {
    assert(job && typeof job === "object" && typeof job.id === "string" && /^job-[a-f0-9-]{36}$/.test(job.id) && job.run?.id === run.id, "The job lookup does not belong to this run.");
    if (run.localJobId && run.localJobId !== job.id) blockers.push(blocker("job-mismatch", "The server reports a different job for this run than the workspace recorded. Do not relaunch; reconcile by hand."));
  }
  const recordedJob = run.localJobId || job?.id || null;
  if (recordedJob) fingerprints.job = recordedJob;
  const launched = Boolean(recordedJob);
  steps.push(step("launch", launched ? "done" : blockers.length ? "blocked" : runtime.state === "available" ? "next" : "pending", {
    requiresApproval: true, note: runtime.state === "busy" ? "The runtime is busy. Wait or cancel the active operation before launching." : "POST /api/training/jobs from the local Mamase UI with the browser-held command token. Approval is explicit; tokens never enter receipts or logs.",
    evidence: launched ? { jobId: recordedJob, recordedInWorkspace: Boolean(run.localJobId), reportedByServer: Boolean(job) } : undefined,
  }));
  let jobState = "pending";
  let jobEvidence;
  if (launched) {
    if (job === null) {
      if (runtime.state === "unreachable" || runtime.state === "unknown") { jobState = "next"; jobEvidence = { lookup: `GET /api/training/runs/${run.id}`, note: "The response was lost or the server was not queried. Look the job up by run ID; never relaunch." }; }
      else { blockers.push(blocker("job-missing", "The workspace records a managed job that this server does not know. Check the outputRoot or a different server; do not relaunch.")); jobState = "blocked"; }
    } else if (job) {
      jobEvidence = { jobId: job.id, status: job.status, runStatus: job.run.status, step: job.run.step, totalSteps: job.run.totalSteps };
      if (ACTIVE_JOB.includes(job.status)) { jobState = "next"; jobEvidence.note = "Training is active. Wait for completion; cancellation requires explicit approval via POST /api/training/jobs/<id>/cancel."; }
      else if (job.status === "completed") jobState = "done";
      else if (job.status === "cancelled") { jobState = "blocked"; blockers.push(blocker("job-cancelled", "The managed job was cancelled. Partial outputs are not an adapter; plan a new run for another attempt.")); }
      else { jobState = "blocked"; blockers.push(blocker("job-failed", "The managed job failed or was interrupted. MLX does not resume optimizer state; the run stays failed and a new run is required.")); }
    } else {
      jobState = ["completed", "failed", "cancelled"].includes(run.status) ? (run.status === "completed" ? "done" : "blocked") : "next";
      jobEvidence = { runStatus: run.status, lookup: `GET /api/training/runs/${run.id}` };
      if (run.status === "failed") blockers.push(blocker("job-failed", "The recorded run failed. Interrupted managed jobs remain failed; plan a new run."));
      if (run.status === "cancelled") blockers.push(blocker("job-cancelled", "The recorded run was cancelled. Plan a new run for another attempt."));
    }
  }
  steps.push(step("job", jobState, { evidence: jobEvidence }));
  const artifact = recordedJob ? evidence.artifacts.find((item) => item.id === `artifact-${recordedJob}`) : null;
  if (artifact) fingerprints.artifact = artifact.id;
  const reconciled = Boolean(artifact) || (job && ["completed", "failed", "cancelled"].includes(job.status) && run.status === job.status && run.localJobId === job.id);
  steps.push(step("register", artifact ? "done" : jobState === "done" || (job && !ACTIVE_JOB.includes(job.status) && !reconciled) ? "next" : "pending", {
    note: "Reconcile the finished job into the workspace with the import-job operation using the server's job record. Registration reuses the job ID; duplicates are unchanged.",
    evidence: artifact ? { artifactId: artifact.id, kind: artifact.kind } : undefined,
  }));
  steps.push(step("test", artifact ? "next" : "pending", { note: "Optional: try prompts against the adapter and its base model in the local Model playground (#/testing). Replies are experiment evidence, not evaluation scores.", requiresApproval: false }));
  steps.push(step("human-review", "pending", { note: "Managed MLX runs have no paired PEFT evaluation. A human reviews playground evidence and decides whether to plan an identity-bound PEFT experiment.", requiresApproval: true }));
  return { steps, blockers, fingerprints, context: null, runtime };
}

function overallState(run, steps, blockers) {
  if (blockers.length) return run.status === "failed" ? "failed" : run.status === "cancelled" ? "cancelled" : "blocked";
  if (steps.every((item) => ["done", "not-applicable"].includes(item.state))) return "evidence-ready";
  if (steps.find((item) => item.id === "human-review")?.state === "next") return "awaiting-human-review";
  if (steps.some((item) => ["train", "job"].includes(item.id) && item.state === "done")) return "trained";
  if (steps.some((item) => ["train", "job"].includes(item.id) && item.state === "next")) return "training";
  if (steps.find((item) => item.id === "prepare")?.state === "done") return "prepared";
  return "planned";
}

/**
 * Derive a durable, machine-readable receipt for one run from workspace state plus optional
 * PEFT bundle metadata or a managed-lane capability/job lookup. Pure: nothing is launched or written.
 */
export function workflowReceipt(workspace, run, { revision = null, bundle, capability, job, generatedAt = new Date().toISOString() } = {}) {
  assert(run && workspace.runs.some((item) => item.id === run.id), "The run is not in this workspace.");
  const dataset = workspace.datasets.find((item) => item.id === run.recipe.datasetId);
  assert(dataset, "The run's dataset is missing from the workspace.");
  const { lane, reason } = detectLane(run);
  const evidence = { artifacts: workspace.artifacts.filter((item) => item.runId === run.id), evaluations: [] };
  evidence.evaluations = workspace.evaluations.filter((item) => evidence.artifacts.some((artifact) => artifact.id === item.artifactId));
  let derived;
  if (lane === "peft") {
    assert(capability === undefined && job === undefined, "Capability and job lookups apply to the managed MLX lane only.");
    derived = peftSteps(run, dataset, evidence, bundle);
  } else if (lane === "managed-mlx") {
    assert(bundle === undefined, "Prepared bundles apply to the PEFT lane only. Managed MLX never claims canonical familiar context.");
    derived = managedSteps(run, dataset, evidence, capability, job);
  } else {
    derived = { steps: [step("plan", "done", { evidence: { runId: run.id } }), step("select-lane", "blocked")], blockers: [blocker("lane-unselected", reason)], fingerprints: { dataset: dataset.sha256 }, context: null };
  }
  const next = derived.blockers.length ? null : derived.steps.find((item) => item.state === "next") || null;
  return {
    schema: WORKFLOW_RECEIPT_SCHEMA,
    generatedAt,
    workspace: { name: workspace.name, revision },
    run: { id: run.id, name: run.name, status: run.status, step: run.step, totalSteps: run.totalSteps, updatedAt: run.updatedAt, ...(run.localJobId ? { localJobId: run.localJobId } : {}) },
    lane, laneReason: reason,
    attempt: { observations: run.history.length, artifacts: evidence.artifacts.length, evaluations: evidence.evaluations.length },
    state: overallState(run, derived.steps, derived.blockers),
    fingerprints: derived.fingerprints,
    familiarContext: lane === "peft" ? derived.context ?? { scope: "unprepared", sha256: null } : { scope: "not-applicable", sha256: null, note: "Managed MLX is unbound and never claims canonical familiar context." },
    ...(derived.runtime ? { runtime: derived.runtime } : {}),
    steps: derived.steps,
    blockers: derived.blockers,
    nextAction: next ? { step: next.id, requiresApproval: Boolean(next.requiresApproval), ...(next.command ? { command: next.command } : {}), ...(next.note ? { note: next.note } : {}) } : null,
    handoff: HANDOFF,
  };
}
