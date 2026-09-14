export const STORAGE_KEY = "mamase.coven-lab.v1";
export const METHODS = { lora: "LoRA fine-tuning", distillation: "Response distillation" };
export const STATUSES = ["planned", "running", "paused", "completed", "failed", "cancelled"];
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_WORKSPACE_BYTES = 4 * 1024 * 1024;

const transitions = {
  planned: ["planned", "running", "cancelled"],
  running: ["running", "paused", "completed", "failed", "cancelled"],
  paused: ["paused", "running", "completed", "failed", "cancelled"],
  completed: ["completed"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value, label, max = 500, optional = false) {
  assert(typeof value === "string", `${label} must be text.`);
  const result = value.trim();
  assert((optional || result.length > 0) && result.length <= max, `${label} must contain ${optional ? "0" : "1"}–${max} characters.`);
  return result;
}

function number(value, label, min, max, integer = false) {
  assert(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number.`);
  assert(value >= min && value <= max && (!integer || Number.isSafeInteger(value)), `${label} must be ${integer ? "an integer " : ""}between ${min} and ${max}.`);
  return value;
}

function date(value) {
  assert(typeof value === "string" && Number.isFinite(Date.parse(value)), "A valid timestamp is required.");
  return value;
}

function id(value) {
  assert(typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value), "Invalid record ID.");
  return value;
}

export function createWorkspace() {
  return {
    version: 1,
    name: "The Coven",
    programs: [{ id: "coven", name: "Coven models", description: "Small models. Shared knowledge." }],
    datasets: [],
    runs: [],
    artifacts: [],
    evaluations: [],
  };
}

export function parseDataset(source) {
  assert(typeof source === "string" && new TextEncoder().encode(source).length <= MAX_IMPORT_BYTES, "Dataset exceeds the 20 MB import limit.");
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  let records = 0;
  let format;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error(`Line ${index + 1}: invalid JSON.`);
    }
    assert(row !== null && typeof row === "object" && !Array.isArray(row), `Line ${index + 1}: expected a JSON object.`);
    let rowFormat;
    if (Array.isArray(row.messages)) {
      assert(row.messages.length >= 2, `Line ${index + 1}: a conversation needs at least two messages.`);
      assert(row.messages.every((message) => message && ["system", "user", "assistant"].includes(message.role) && typeof message.content === "string" && message.content.trim()), `Line ${index + 1}: messages need a valid role and nonempty text content.`);
      assert(row.messages.some((message) => message.role === "user") && row.messages.at(-1).role === "assistant", `Line ${index + 1}: a conversation needs a user prompt and must end with an assistant response.`);
      rowFormat = "messages";
    } else {
      assert(typeof row.prompt === "string" && row.prompt.trim() && typeof row.response === "string" && row.response.trim(), `Line ${index + 1}: expected prompt/response strings or a messages array.`);
      rowFormat = "prompt-response";
    }
    assert(!format || format === rowFormat, `Line ${index + 1}: do not mix dataset formats.`);
    format = rowFormat;
    records++;
  }
  assert(records >= 2, "Import at least two examples so training and holdout sets can be separated.");
  return { records, format };
}

export function validateDataset(input) {
  const records = number(input.records, "Example count", 2, 1_000_000, true);
  const holdout = number(input.holdout, "Holdout percentage", 1, 50, true);
  assert(["supervised", "teacher"].includes(input.kind), "Choose supervised or teacher-generated examples.");
  assert(["messages", "prompt-response"].includes(input.format), "Unsupported dataset format.");
  assert(/^[a-f0-9]{64}$/.test(input.sha256), "A dataset SHA-256 fingerprint is required.");
  return {
    id: id(input.id),
    name: text(input.name, "Dataset name", 100),
    filename: text(input.filename, "Filename", 255),
    records,
    bytes: number(input.bytes, "File size", 1, MAX_IMPORT_BYTES, true),
    format: input.format,
    kind: input.kind,
    teacher: text(input.teacher, "Teacher model", 200, input.kind !== "teacher"),
    provenance: text(input.provenance, "Data provenance", 1000),
    holdout,
    sha256: input.sha256,
    createdAt: date(input.createdAt),
  };
}

export function splitCounts(dataset) {
  const holdout = Math.max(1, Math.floor(dataset.records * dataset.holdout / 100));
  return { train: dataset.records - holdout, holdout };
}

export function validateRecipe(input, workspace) {
  assert(Object.hasOwn(METHODS, input.method), "Choose LoRA or response distillation.");
  assert(workspace.programs.some((program) => program.id === input.programId), "Choose an existing program.");
  const dataset = workspace.datasets.find((item) => item.id === input.datasetId);
  assert(dataset, "Import and select a dataset first.");
  const teacher = text(input.teacher, "Teacher model", 200, input.method === "lora");
  if (input.method === "distillation") {
    assert(dataset.kind === "teacher", "Response distillation requires a teacher-generated dataset.");
    assert(dataset.teacher === teacher, "The teacher model must match the dataset's recorded teacher.");
  }
  const rank = number(input.rank, "LoRA rank", 4, 256, true);
  assert([4, 8, 16, 32, 64, 128, 256].includes(rank), "LoRA rank must be a power of two from 4 to 256.");
  return {
    method: input.method,
    programId: input.programId,
    datasetId: dataset.id,
    student: text(input.student, "Student/base model", 200),
    teacher: input.method === "distillation" ? teacher : "",
    rank,
    alpha: number(input.alpha, "LoRA alpha", 1, 1024, true),
    learningRate: number(input.learningRate, "Learning rate", 0.00000001, 1),
    epochs: number(input.epochs, "Epochs", 1, 100, true),
    batchSize: number(input.batchSize, "Micro batch size", 1, 128, true),
    accumulation: number(input.accumulation, "Gradient accumulation", 1, 1024, true),
    maxSequence: number(input.maxSequence, "Sequence length", 128, 131072, true),
    outputPath: text(input.outputPath, "Local output path", 500),
    objective: text(input.objective, "Training objective", 2000),
  };
}

export function estimatedSteps(recipe, dataset) {
  return Math.ceil(Math.ceil(splitCounts(dataset).train / recipe.batchSize) / recipe.accumulation) * recipe.epochs;
}

export function createRun(input, workspace) {
  const recipe = validateRecipe(input.recipe, workspace);
  return {
    id: id(input.id),
    name: text(input.name, "Run name", 100),
    recipe,
    status: "planned",
    step: 0,
    totalSteps: estimatedSteps(recipe, workspace.datasets.find((item) => item.id === recipe.datasetId)),
    createdAt: date(input.createdAt),
    updatedAt: input.createdAt,
    history: [],
  };
}

function validateProgress(input) {
  assert(STATUSES.includes(input.status), "Choose a valid run status.");
  const totalSteps = number(input.totalSteps, "Total steps", 1, 1_000_000_000, true);
  const step = number(input.step, "Completed steps", 0, totalSteps, true);
  assert(input.status !== "completed" || step === totalSteps, "Completed runs must have all steps recorded.");
  assert(input.status !== "planned" || step === 0, "A planned run cannot have completed steps.");
  return {
    status: input.status,
    step,
    totalSteps,
    loss: input.loss === null ? null : number(input.loss, "Training loss", 0, 1_000_000),
    evalLoss: input.evalLoss === null ? null : number(input.evalLoss, "Validation loss", 0, 1_000_000),
    note: text(input.note, "Progress note", 2000, true),
    recordedAt: date(input.recordedAt),
  };
}

export function recordProgress(run, input) {
  const update = validateProgress(input);
  assert(transitions[run.status].includes(update.status), `Cannot change a ${run.status} run to ${update.status}.`);
  assert(!["completed", "failed", "cancelled"].includes(run.status), "This run is closed. Create a new recipe for another attempt.");
  assert(update.step >= run.step, "Completed steps cannot go backwards.");
  assert(Date.parse(update.recordedAt) >= Date.parse(run.updatedAt), "Progress timestamps must be chronological.");
  return { ...run, status: update.status, step: update.step, totalSteps: update.totalSteps, updatedAt: update.recordedAt, history: [...run.history, update] };
}

export function validateArtifact(input, workspace) {
  assert(workspace.runs.some((run) => run.id === input.runId), "Choose an existing run.");
  assert(["adapter", "checkpoint", "merged", "gguf"].includes(input.kind), "Choose a supported artifact type.");
  return {
    id: id(input.id),
    runId: input.runId,
    name: text(input.name, "Model/artifact name", 100),
    kind: input.kind,
    path: text(input.path, "Local artifact path", 1000),
    notes: text(input.notes, "Artifact notes", 2000, true),
    createdAt: date(input.createdAt),
  };
}

export function validateEvaluation(input, workspace) {
  assert(workspace.artifacts.some((artifact) => artifact.id === input.artifactId), "Register a model artifact first.");
  const maximum = number(input.maximum, "Score maximum", 0.000001, 1_000_000);
  return {
    id: id(input.id),
    artifactId: input.artifactId,
    benchmark: text(input.benchmark, "Benchmark and version", 200),
    score: number(input.score, "Score", 0, maximum),
    maximum,
    samples: number(input.samples, "Evaluation samples", 1, 1_000_000_000, true),
    notes: text(input.notes, "Evaluation notes", 2000, true),
    createdAt: date(input.createdAt),
  };
}

export function validateWorkspace(input) {
  assert(input && input.version === 1, "Unsupported workspace format. Expected version 1.");
  const workspace = { version: 1, name: text(input.name, "Workspace name", 80) };
  for (const collection of ["programs", "datasets", "runs", "artifacts", "evaluations"]) {
    assert(Array.isArray(input[collection]) && input[collection].length <= 10000, `Invalid ${collection} collection.`);
    const ids = input[collection].map((item) => id(item?.id));
    assert(new Set(ids).size === ids.length, `Duplicate IDs in ${collection}.`);
  }
  workspace.programs = input.programs.map((program) => ({
    id: id(program.id), name: text(program.name, "Program name", 100),
    description: text(program.description, "Program description", 1000, true),
  }));
  assert(workspace.programs.length > 0, "Keep at least one program in the workspace.");
  workspace.datasets = input.datasets.map(validateDataset);
  workspace.runs = input.runs.map((run) => {
    let restored = createRun(run, workspace);
    assert(Array.isArray(run.history) && run.history.length <= 10000, "Invalid run history.");
    for (const event of run.history) restored = recordProgress(restored, event);
    assert(restored.status === run.status && restored.step === run.step && restored.totalSteps === run.totalSteps && restored.updatedAt === run.updatedAt, "Run summary does not match its progress history.");
    return restored;
  });
  workspace.artifacts = input.artifacts.map((artifact) => validateArtifact(artifact, workspace));
  workspace.evaluations = input.evaluations.map((evaluation) => validateEvaluation(evaluation, workspace));
  return workspace;
}

export function loadWorkspace(storage) {
  const source = storage.getItem(STORAGE_KEY);
  return source === null ? createWorkspace() : validateWorkspace(JSON.parse(source));
}

export function saveWorkspace(storage, workspace) {
  const valid = validateWorkspace(workspace);
  const source = JSON.stringify(valid);
  assert(new TextEncoder().encode(source).length <= MAX_WORKSPACE_BYTES, "Workspace exceeds 4 MB. Export a backup before archiving older data.");
  storage.setItem(STORAGE_KEY, source);
  return valid;
}

export function exportRecipe(run, workspace) {
  const dataset = workspace.datasets.find((item) => item.id === run.recipe.datasetId);
  return {
    schema: "mamase.training-recipe.v1",
    runId: run.id,
    name: run.name,
    execution: "external",
    description: "Planning manifest, not an executable trainer configuration. Map these fields to your local trainer.",
    recipe: run.recipe,
    dataset: { ...dataset, split: splitCounts(dataset), splitSeed: 42 },
    splitPolicy: "Shuffle with seed 42, reserve the recorded holdout count, and exclude holdout examples from training. Mamase records metadata; your trainer must perform the split.",
    distillation: run.recipe.method === "distillation" ? "Supervised LoRA training on pre-generated teacher responses; no online generation or logit/KL matching." : null,
    estimatedOptimizerSteps: estimatedSteps(run.recipe, dataset),
  };
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export function runsCsv(runs) {
  const cell = (value) => {
    const source = String(value);
    return `"${(/^[=+\-@\t\r\n]/.test(source) ? "'" : "") + source.replace(/"/g, '""')}"`;
  };
  return [
    ["Run ID", "Name", "Method", "Status", "Step", "Total steps", "Base model", "Teacher", "Updated"],
    ...runs.map((run) => [run.id, run.name, run.recipe.method, run.status, run.step, run.totalSteps, run.recipe.student, run.recipe.teacher, run.updatedAt]),
  ].map((row) => row.map(cell).join(",")).join("\r\n");
}
