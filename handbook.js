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
    purpose: "Freeze the recipe, dataset split and declared familiar context into a bundle directory. Selected familiar context needs inspect-context review and --context-sha256.",
    boundaries: "Preparation does not train, download models, or authenticate coven membership.",
  },
  preflight: {
    title: "Preflight",
    purpose: "Check readiness without loading weights: sources, model inventory, dependencies, tokenizer and token budget.",
    boundaries: "Read-only. It is not a run report and not an out-of-memory guarantee.",
    // Commands and note wording follow README.md's "Run an identity-bound
    // experiment" section and app.js's terminal-commands disclosure ("Use the
    // PEFT environment from training/requirements.txt"); this is the first
    // step whose command invokes .venv/bin/python, so it is the honest home
    // for the one-time environment setup.
    setup: {
      commands: "python3 -m venv .venv\n.venv/bin/python -m pip install -r training/requirements.txt",
      note: "Requires Python 3.10+ for the separate PEFT environment. Installing the trainer downloads no model.",
    },
  },
  train: {
    title: "Train",
    purpose: "Run the identity-bound trainer yourself against the prepared bundle.",
    boundaries: "It needs your explicit go-ahead for this run, and finishing is not approval to deploy.",
  },
  evaluate: {
    title: "Evaluate",
    purpose: "Compare base and adapter responses on a versioned suite and import the report.",
    boundaries: "Rule checks are not semantic certification, and the report's independence is \"unverified\" unless both --history and --task-lineage were supplied when it was generated.",
  },
  "human-review": {
    title: "Human review",
    purpose: "A person reads the private outputs and records a decision.",
    boundaries: "An agent judgment is a recommendation, never a human opinion, and no decision here deploys or promotes anything.",
  },
  capability: {
    title: "Check the local runtime",
    purpose: "Confirm the local Mamase server can reach the MLX training runtime (enabled, available, not busy).",
    boundaries: "A capability probe is not proof the base model fits in memory or that training will finish.",
    // Verbatim from app.js's own "One-time setup" disclosure (app.js:462-464)
    // and README.md's "Managed local training on Apple Silicon" section,
    // which already agree word for word.
    setup: {
      commands: "python3.12 -m venv .venv-training\n.venv-training/bin/python -m pip install -r training/requirements-mlx.txt\nnpm run dev",
      note: "Requires Apple Silicon and Python 3.12. Installing the trainer does not download a model.",
    },
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

/**
 * The one claim that must render on every state of the page, not only the
 * empty one: importing a dataset never keeps the private examples, and consent
 * is required before training on them. An honesty claim that disappears once a
 * user has a run is worse than one stated plainly everywhere.
 */
export const HANDBOOK_BOUNDARY = "Importing a dataset saves a description and fingerprint, not the examples themselves. Do not train on private material without permission.";

// The "plan" entry is sourced from STEP_COPY, and "curate" reuses
// HANDBOOK_BOUNDARY, so neither copy can drift apart from its other home.
const FIRST_RUN = [
  {
    id: "curate", state: "next", title: "Curate the examples",
    purpose: "Import JSONL with messages or prompt/response records, and set a holdout aside before training.",
    boundaries: HANDBOOK_BOUNDARY,
  },
  { id: "plan", state: "pending", ...STEP_COPY.plan },
];

// A fresh array of fresh objects on every call: FIRST_RUN and its entries are
// module-level and must never be handed out by reference, or mutating one
// caller's copy would poison every later model.
const firstRun = () => FIRST_RUN.map((step) => ({ ...step }));

// Copy first, receipt last: a colliding key (e.g. a copy entry that happened to
// be named `note` or `requiresApproval`) can never shadow real receipt data.
const decorate = (step) => ({ ...(STEP_COPY[step.id] || { title: step.id, purpose: "", boundaries: "" }), ...step });

/**
 * The run the handbook adopts: an explicit choice when it still exists, else the
 * most recently updated. A stale or unknown runId (a deep link to a deleted run)
 * falls back to the most recent run rather than to the empty branch, which would
 * falsely claim the workspace has no runs while `choices` lists real ones.
 */
function subject(workspace, runId) {
  if (!workspace?.runs?.length) return null;
  const chosen = runId ? workspace.runs.find((run) => run.id === runId) : null;
  if (chosen) return chosen;
  // A missing updatedAt sorts as "" (oldest), never as the most recent.
  return [...workspace.runs].sort((left, right) => (left.updatedAt || "").localeCompare(right.updatedAt || "")).at(-1);
}

export function handbookModel(workspace, { runId, capability, job } = {}) {
  const run = subject(workspace, runId);
  const choices = (workspace?.runs || []).map(({ id, name }) => ({ id, name }));
  if (!run) {
    const steps = firstRun();
    return { empty: true, run: null, choices, lane: null, steps, next: steps[0], blockers: [], state: null };
  }
  // workflowReceipt calls this same pure detectLane on this same run, so the
  // local `lane` and receipt.lane cannot diverge; on success we still return
  // receipt.lane below so this module never reports a second, independently
  // computed value. `lane` itself decides the call shape just below, and is
  // also what the error branch reports, since no receipt exists there to ask.
  const { lane } = detectLane(run);
  let receipt;
  try {
    receipt = lane === "managed-mlx"
      ? workflowReceipt(workspace, run, { capability, job })
      : workflowReceipt(workspace, run);
  } catch (error) {
    // No receipt ran, so there is no state to report. `null` is the honest
    // value; inventing one (e.g. "blocked") would be exactly the
    // recomputation this module exists to avoid — read blockers.length instead.
    return { empty: false, run, choices, lane, steps: [], next: null, blockers: [{ code: "receipt-unavailable", message: error.message }], state: null };
  }
  const steps = receipt.steps.map(decorate);
  // Resolved from the already-decorated steps, so model.next is always the
  // same object reference as its entry in model.steps — identity is
  // consistent with the empty branch above, where next === steps[0].
  const next = receipt.nextAction ? steps.find((step) => step.id === receipt.nextAction.step) || null : null;
  return {
    empty: false, run, choices, lane: receipt.lane,
    steps,
    next,
    blockers: receipt.blockers,
    state: receipt.state,
  };
}
