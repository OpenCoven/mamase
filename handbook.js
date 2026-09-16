import { workflowReceipt, detectLane } from "./workflow-receipt.mjs";

/**
 * Presentation only. Every state comes from workflow-receipt.mjs; nothing here
 * recomputes or overrides one. `boundaries` is what the step does NOT do — the
 * claims that used to sit inline in the handbook prose.
 */
export const STEP_COPY = {
  plan: {
    title: "Plan a recipe",
    purpose: "Record the dataset, base model and configuration for one attempt.",
    boundaries: "Saving a recipe starts nothing and reserves no hardware.",
  },
  prepare: {
    title: "Prepare the bundle",
    purpose: "Freeze the recipe, dataset split and declared familiar context into a bundle directory.",
    boundaries: "Preparation does not train, download models, or authenticate coven membership. Selected familiar context needs inspect-context review and --context-sha256.",
  },
  preflight: {
    title: "Preflight",
    purpose: "Check readiness without loading weights: sources, model inventory, dependencies, tokenizer and token budget.",
    boundaries: "Read-only. It is not a run report and not an out-of-memory guarantee.",
  },
  train: {
    title: "Train",
    purpose: "Run the identity-bound trainer yourself against the prepared bundle.",
    boundaries: "This is the only step that trains, and it needs your explicit go-ahead for this run. Finishing is not approval to deploy.",
  },
  evaluate: {
    title: "Evaluate",
    purpose: "Compare base and adapter on an independent, versioned suite and import the report.",
    boundaries: "Rule checks are not semantic certification. Independence depends on declared suite lineage and history.",
  },
  "human-review": {
    title: "Human review",
    purpose: "A person reads the private outputs and records a decision.",
    boundaries: "Only a human records a decision. An agent judgment is a recommendation, never a human opinion, and no decision here deploys or promotes anything.",
  },
  capability: {
    title: "Check the local runtime",
    purpose: "Confirm the local Mamase server can reach the MLX training runtime (enabled, available, not busy).",
    boundaries: "A capability probe is not proof the base model fits in memory or that training will finish.",
  },
  launch: {
    title: "Launch on this Mac",
    purpose: "Start a managed MLX job from the saved run, choosing the original dataset file.",
    boundaries: "Launching is a browser action. It is never started by an agent or the CLI.",
  },
  job: {
    title: "Managed job",
    purpose: "Watch reported losses and learning updates until the trainer finishes.",
    boundaries: "Progress is reported learning updates, not time remaining. Cancellation requires explicit approval.",
  },
  register: {
    title: "Register the output",
    purpose: "Bind the finished adapter to this run in the model library.",
    boundaries: "A library entry is not approval to deploy, and an adapter still needs its base model.",
  },
  test: {
    title: "Try it in the playground",
    purpose: "Send the same prompts to the base model and the adapter and read the answers.",
    boundaries: "Replies are experiment evidence, not evaluation scores.",
  },
  "select-lane": {
    title: "Choose a lane",
    purpose: "Bind a familiar and instance for PEFT, or select Train on this Mac for managed MLX.",
    boundaries: "The two lanes produce different evidence and are never merged as one attempt.",
  },
};

const FIRST_RUN = [
  {
    id: "curate", state: "next", title: "Curate the examples",
    purpose: "Import JSONL with messages or prompt/response records, and set a holdout aside before training.",
    boundaries: "Import saves a description and fingerprint, not the examples themselves. Do not train on private material without permission.",
  },
  {
    id: "plan", state: "pending", title: "Plan a recipe",
    purpose: "Choose the dataset, base model and configuration for your first attempt.",
    boundaries: "Saving a recipe starts nothing.",
  },
];

const decorate = (step) => ({ ...step, ...(STEP_COPY[step.id] || { title: step.id, purpose: "", boundaries: "" }) });

/** The run the handbook adopts: an explicit choice, else the most recently updated. */
function subject(workspace, runId) {
  if (!workspace?.runs?.length) return null;
  if (runId) return workspace.runs.find((run) => run.id === runId) || null;
  return [...workspace.runs].sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt))).at(-1);
}

export function handbookModel(workspace, { runId, capability, job } = {}) {
  const run = subject(workspace, runId);
  const choices = (workspace?.runs || []).map(({ id, name }) => ({ id, name }));
  if (!run) return { empty: true, run: null, choices, lane: null, steps: FIRST_RUN, next: FIRST_RUN[0], blockers: [] };
  const { lane } = detectLane(run);
  let receipt;
  try {
    receipt = lane === "managed-mlx"
      ? workflowReceipt(workspace, run, { capability, job })
      : workflowReceipt(workspace, run);
  } catch (error) {
    return { empty: false, run, choices, lane, steps: [], next: null, blockers: [{ code: "receipt-unavailable", message: error.message }] };
  }
  const nextStep = receipt.nextAction ? receipt.steps.find((step) => step.id === receipt.nextAction.step) : null;
  return {
    empty: false, run, choices, lane,
    steps: receipt.steps.map(decorate),
    next: nextStep ? decorate(nextStep) : null,
    blockers: receipt.blockers,
    state: receipt.state,
  };
}
