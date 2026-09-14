import {
  STORAGE_KEY, METHODS, STATUSES, MAX_IMPORT_BYTES, MAX_WORKSPACE_BYTES, assert,
  createWorkspace, loadWorkspace, saveWorkspace, validateWorkspace, parseDataset,
  validateDataset, splitCounts, createRun, recordProgress, validateArtifact,
  validateEvaluation, exportRecipe, escapeHtml as esc, runsCsv, estimatedSteps,
} from "./workspace.js";
import { icon, button, link, field, select, badge, empty, table, formatDate, formatBytes, progress, sigil } from "./ui.js";

const app = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const toast = document.querySelector("#toast");
let workspace;
let savedSource;
let storageError = "";
try {
  savedSource = localStorage.getItem(STORAGE_KEY);
  workspace = loadWorkspace(localStorage);
} catch (error) {
  storageError = `Your workspace could not be opened: ${error.message}. Your stored data has not been changed.`;
}

const defaults = () => ({
  name: "", method: "lora", programId: workspace?.programs[0]?.id || "coven", datasetId: "",
  student: "Qwen/Qwen2.5-7B-Instruct", teacher: "", rank: "16", alpha: "32",
  learningRate: "0.0002", epochs: "3", batchSize: "1", accumulation: "4",
  maxSequence: "2048", outputPath: "./outputs/coven-adapter", objective: "",
});
const ui = { menu: false, collapsed: false, draft: defaults(), query: "", status: "all", program: "all", modelKind: "all" };
const nav = [
  ["home", "Overview", "home"], ["projects", "Programs", "projects"], ["datasets", "Datasets", "datasets"],
  ["sessions", "Training runs", "runs"], ["checkpoints", "Model library", "models"], ["playground", "Distillation lab", "lab"],
  ["evaluations", "Evaluations", "evaluations"],
];
const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const byId = (items, id) => {
  const item = items.find((record) => record.id === id);
  assert(item, "This record no longer exists. Reload the workspace.");
  return item;
};
const num = (value) => new Intl.NumberFormat().format(value);
const programOptions = () => workspace.programs.map((program) => [program.id, program.name]);
const datasetOptions = () => [["", "Select a dataset"], ...workspace.datasets.map((dataset) => [dataset.id, dataset.name])];
const runLink = (run) => `<a class="record-link" href="#/sessions/${run.id}">${esc(run.name)}</a>`;

function route() {
  const [page = "home", id] = location.hash.replace(/^#\/?/, "").split("/");
  return { page: page || "home", id };
}

function sidebar(page) {
  const links = [...nav, ["resources", "Training handbook", "docs"], ["settings", "Workspace settings", "settings"]];
  return `<aside class="sidebar" id="navigation" aria-label="Workspace navigation">
    <div class="brand-row"><a class="brand" href="#/home" aria-label="Mamase overview">mamase<span class="brand-dot">.</span></a>
      <button class="icon-button" type="button" data-action="toggle-sidebar" aria-label="${ui.collapsed ? "Expand" : "Collapse"} navigation">${icon("panel")}</button></div>
    <div class="workspace-label"><span class="tiny-mark">${icon("spark")}</span><span>${esc(workspace?.name || "The Coven")}</span><span class="workspace-tag">LOCAL</span></div>
    <nav>${links.map(([id, label, glyph], index) => `${index === 7 ? '<div class="nav-section">Workspace</div>' : ""}<a href="#/${id}" class="nav-link ${page === id ? "active" : ""}" ${page === id ? 'aria-current="page"' : ""} aria-label="${label}" title="${label}">${icon(glyph)}<span>${label}</span>${id === "sessions" && workspace?.runs.length ? `<span class="nav-count">${workspace.runs.length}</span>` : ""}</a>`).join("")}</nav>
    <div class="sidebar-bottom"><div class="local-status"><span class="status-dot"></span><span>Local workspace</span></div>
      <p>Knowledge stays in the coven.</p>
      <a class="profile" href="#/settings"><span class="avatar">C</span><span><strong>${esc(workspace?.name || "The Coven")}</strong><small>On this browser</small></span>${icon("settings")}</a></div>
  </aside>`;
}

function header(title, actions = "", subtitle = "") {
  return `<header class="page-header"><div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div><div class="actions">${actions}</div></header>`;
}

function metric(label, value, note, glyph) {
  return `<article class="metric"><div class="metric-label">${label}${icon(glyph)}</div><strong>${value}</strong><p>${note}</p></article>`;
}

function homePage() {
  const active = workspace.runs.filter((run) => ["running", "paused"].includes(run.status)).length;
  const completed = workspace.runs.filter((run) => run.status === "completed").length;
  return `<div class="home-page">
    <div class="home-topline"><span>YOUR COVEN'S MODEL WORKSPACE</span><span>${icon("local")} Local-first. Yours to shape.</span></div>
    <section class="home-stage"><div class="home-copy"><p class="home-kicker">Less model. <strong>More of us.</strong></p>
      <h1>Distill knowledge.<br>Make it our own.</h1>
      <p class="home-intro">A home for the coven's next generation of local models. Distill from teachers, shape with LoRA, and follow every experiment from first example to final weights.</p>
      <div class="actions">${link("Open the lab", "#/playground", "lab", "primary")}${link("Explore the workflow", "#/resources", "arrow", "quiet")}</div>
      <div class="hero-caption"><span></span>Small models. Shared knowledge. Our own way.</div></div>
      <div class="hero-art">${sigil()}</div></section>
    <section class="metrics overview-metrics" aria-label="Workspace progress">
      ${metric("Training runs", num(workspace.runs.length), `${active} active · ${completed} completed`, "runs")}
      ${metric("Curated examples", num(workspace.datasets.reduce((sum, dataset) => sum + dataset.records, 0)), `Across ${workspace.datasets.length} datasets`, "datasets")}
      ${metric("Model artifacts", num(workspace.artifacts.length), "Registered local paths", "models")}
      ${metric("Evaluations", num(workspace.evaluations.length), "Recorded benchmark results", "evaluations")}
    </section>
    <section class="home-grid"><article class="home-panel"><div class="section-heading"><h2>${icon("runs")} Recent experiments</h2><a href="#/sessions" class="subtle-link">View all ${icon("arrow")}</a></div>
      ${workspace.runs.length ? `<div class="recent-list">${workspace.runs.slice(-3).reverse().map((run) => `<a class="recent-run" href="#/sessions/${run.id}"><span class="item-icon">${icon(run.recipe.method === "lora" ? "spark" : "lab")}</span><div><strong>${esc(run.name)}</strong><small>${METHODS[run.recipe.method]} · ${esc(run.recipe.student.split("/").at(-1))}</small></div>${badge(run.status)}</a>`).join("")}</div>` : empty("Every model starts with an experiment.", "Plan your first run. Your real progress will appear here.", link("Create a training recipe", "#/playground", "plus"), "runs", true)}
    </article><article class="home-panel"><div class="section-heading"><h2>${icon("lab")} From teacher to familiar</h2><span class="muted">The workflow</span></div>
      <ol class="workflow"><li><span>1</span><div><a href="#/datasets">Curate the knowledge</a><p>Bring your examples or a teacher's responses.</p></div></li>
      <li><span>2</span><div><a href="#/playground">Shape a smaller model</a><p>Set the student, LoRA adapter, and training recipe.</p></div></li>
      <li><span>3</span><div><a href="#/evaluations">Measure what matters</a><p>Record results, compare artifacts, and keep the best.</p></div></li></ol>
    </article></section>
    <div class="local-note">${icon("local")} This is a training workspace, not a hosted trainer. Run jobs with your local tools, then record or import their results.</div>
  </div>`;
}

function projectsPage() {
  const rows = workspace.programs.map((program) => {
    const runs = workspace.runs.filter((run) => run.recipe.programId === program.id);
    const artifacts = workspace.artifacts.filter((artifact) => runs.some((run) => run.id === artifact.runId));
    return [`<strong>${esc(program.name)}</strong><small>${esc(program.description)}</small>`, `<code>${esc(program.id.slice(0, 18))}</code>`, num(runs.length), num(runs.filter((run) => run.status === "completed").length), num(artifacts.length), button("Manage", "edit-program", "", "small", `data-id="${program.id}"`)];
  });
  return `${header("Programs", button("New program", "new-program", "plus"), "Keep related distillation and LoRA experiments together.")}
    ${table(["Program", "Program ID", "Runs", "Completed", "Artifacts", ""], rows, "Training programs")}`;
}

function datasetsPage() {
  return `${header("Datasets", button("Import JSONL", "import-dataset", "plus", "primary"), "Know what goes into the model. Keep training and holdout examples separate.")}
    <div class="notice">${icon("local")} Imports stay on this device. Only metadata and a SHA-256 fingerprint are saved; example contents are not retained.</div>
    ${workspace.datasets.length ? table(["Dataset", "Source", "Examples", "Train / holdout", "Size", ""], workspace.datasets.map((dataset) => [
      `<strong>${esc(dataset.name)}</strong><small>${esc(dataset.filename)}</small>`,
      dataset.kind === "teacher" ? `<span class="tag">Teacher responses</span><small>${esc(dataset.teacher)}</small>` : '<span class="tag">Supervised examples</span>',
      num(dataset.records), `${num(splitCounts(dataset).train)} / ${num(splitCounts(dataset).holdout)}`, formatBytes(dataset.bytes),
      button("Details", "dataset-details", "", "small", `data-id="${dataset.id}"`),
    ]), "Imported datasets") : empty("Give your model something worth learning.", "Import a JSONL dataset of conversations or prompt/response pairs. For distillation, use responses already generated by your teacher.", button("Import your first dataset", "import-dataset", "upload"), "datasets")}`;
}

function runsPage() {
  return `${header("Training runs", link("New recipe", "#/playground", "plus", "primary"), "A record of actual experiments. No simulated progress.")}
    <div class="filters">
      ${select("Program", "program-filter", ui.program, [["all", "All programs"], ...programOptions()])}
      ${select("Status", "status-filter", ui.status, [["all", "All statuses"], ...STATUSES.map((status) => [status, status[0].toUpperCase() + status.slice(1)])])}
      <div class="field search-field"><label for="run-search">Search runs</label><div>${icon("search")}<input id="run-search" type="search" placeholder="Search by name, model, or run ID..." value="${esc(ui.query)}"></div></div>
      ${button("Export CSV", "export-runs", "download", "quiet")}
    </div><div id="run-results">${runResults()}</div>`;
}

function runResults() {
  const filtered = workspace.runs.filter((run) =>
    (ui.program === "all" || run.recipe.programId === ui.program) &&
    (ui.status === "all" || run.status === ui.status) &&
    `${run.name} ${run.id} ${run.recipe.student}`.toLowerCase().includes(ui.query.toLowerCase()));
  if (!filtered.length) return empty(workspace.runs.length ? "No matching runs." : "Your next model begins here.", workspace.runs.length ? "Try another status, program, or search term." : "Save a recipe in the lab, execute it with your local trainer, and record the results here.", link("Open distillation lab", "#/playground", "arrow"), "runs");
  return table(["Experiment", "Method", "Status", "Progress", "Last recorded"], filtered.slice().reverse().map((run) => [
    `${runLink(run)}<small>${esc(run.recipe.student)}</small>`, METHODS[run.recipe.method], badge(run.status), progress(run), formatDate(run.updatedAt),
  ]), "Recorded training runs");
}

function lossChart(run) {
  const points = run.history.filter((event) => event.loss !== null);
  if (!points.length) return empty("Waiting for recorded loss.", "Add a progress update or import a report from your trainer.", "", "evaluations", true);
  const maxLoss = Math.max(...points.map((point) => point.loss), 0.01);
  const x = (point) => 46 + point.step / run.totalSteps * 690;
  const y = (point) => 190 - point.loss / maxLoss * 155;
  return `<svg class="loss-chart" viewBox="0 0 780 232" role="img" aria-label="Recorded training loss over optimizer steps">
    ${[0, 0.5, 1].map((tick) => `<line x1="46" y1="${190 - tick * 155}" x2="736" y2="${190 - tick * 155}" stroke="#e8e8e5"/><text x="4" y="${194 - tick * 155}">${(maxLoss * tick).toFixed(2)}</text>`).join("")}
    <polyline points="${points.map((point) => `${x(point)},${y(point)}`).join(" ")}" fill="none" stroke="#4658b8" stroke-width="2.5"/>
    ${points.map((point) => `<circle cx="${x(point)}" cy="${y(point)}" r="4" fill="#4658b8"><title>Step ${point.step}: ${point.loss}</title></circle>`).join("")}
    <text x="46" y="220">0</text><text x="640" y="220">${run.totalSteps} steps</text></svg>`;
}

function runDetail(id) {
  const run = byId(workspace.runs, id);
  const dataset = byId(workspace.datasets, run.recipe.datasetId);
  const latest = run.history.filter((event) => event.loss !== null).at(-1);
  const closed = ["completed", "failed", "cancelled"].includes(run.status);
  return `<a class="breadcrumb" href="#/sessions">Training runs / <span>${esc(run.name)}</span></a>
    ${header(esc(run.name), `${button("Export recipe", "export-recipe", "download", "", `data-id="${run.id}"`)}${closed ? "" : button("Record progress", "progress", "plus", "primary", `data-id="${run.id}"`)}`, `${esc(METHODS[run.recipe.method])} · ${esc(run.recipe.student)}`)}
    <div class="run-status-row">${badge(run.status)}<code>${run.id}</code><span class="muted">Last recorded ${formatDate(run.updatedAt)}</span></div>
    <div class="metrics three">${metric("Optimizer steps", `${num(run.step)} / ${num(run.totalSteps)}`, "Reported by you or an imported report", "runs")}${metric("Training loss", latest ? String(latest.loss) : "—", "Latest recorded value", "evaluations")}${metric("Dataset", num(dataset.records), `${esc(dataset.name)} · ${dataset.holdout}% holdout`, "datasets")}</div>
    <div class="detail-grid"><section class="card chart-card"><div class="section-heading"><h2>Training loss</h2><span class="muted">Recorded observations</span></div>${lossChart(run)}</section>
    <section class="card"><h2>Recipe</h2><dl class="facts"><dt>Method</dt><dd>${METHODS[run.recipe.method]}</dd>${run.recipe.teacher ? `<dt>Teacher</dt><dd>${esc(run.recipe.teacher)}</dd>` : ""}<dt>LoRA rank / alpha</dt><dd>${run.recipe.rank} / ${run.recipe.alpha}</dd><dt>Learning rate</dt><dd>${run.recipe.learningRate}</dd><dt>Epochs</dt><dd>${run.recipe.epochs}</dd><dt>Output</dt><dd><code>${esc(run.recipe.outputPath)}</code></dd></dl><p class="muted">${esc(run.recipe.objective)}</p></section></div>
    <section class="card"><div class="section-heading"><h2>Progress journal</h2><div class="actions">${button("Report template", "report-template", "code", "small", `data-id="${run.id}"`)}${closed ? "" : button("Import report", "import-report", "upload", "small", `data-id="${run.id}"`)}</div></div>
    ${run.history.length ? table(["Recorded", "Status", "Step", "Loss / validation", "Notes"], run.history.slice().reverse().map((event) => [formatDate(event.recordedAt), badge(event.status), `${event.step} / ${event.totalSteps}`, `${event.loss ?? "—"} / ${event.evalLoss ?? "—"}`, esc(event.note) || "—"]), "Run progress journal") : '<p class="muted">This recipe is planned, not running. Start your local trainer and record its first update here.</p>'}</section>
    <section class="card"><div class="section-heading"><h2>Local model artifacts</h2>${button("Register artifact", "new-artifact", "plus", "small", `data-id="${run.id}"`)}</div>
    ${workspace.artifacts.some((artifact) => artifact.runId === run.id) ? artifactTable(workspace.artifacts.filter((artifact) => artifact.runId === run.id)) : '<p class="muted">Record an adapter, checkpoint, merged model, or GGUF path when your trainer creates one.</p>'}</section>`;
}

function labPage() {
  const draft = ui.draft;
  const distill = draft.method === "distillation";
  const dataset = workspace.datasets.find((item) => item.id === draft.datasetId);
  return `${header("Distillation lab", button("View recipe", "preview-recipe", "code", "quiet"), "Design the experiment. Train locally. Keep the knowledge.")}
    <form id="recipe-form" data-form="recipe" class="lab-layout"><div class="lab-main">
      <div class="lab-intro"><span class="eyebrow">${icon("lab")} A NEW EXPERIMENT</span><h2>What will we teach<br>our next model?</h2><p>Build a focused LoRA adapter or pass a teacher's responses to a smaller student.</p></div>
      <div class="method-picker" role="group" aria-label="Training method">
        <button type="button" data-action="method" data-method="lora" aria-pressed="${!distill}" class="method-card ${!distill ? "selected" : ""}">${icon("spark")}<strong>LoRA fine-tuning</strong><span>Teach a base model with your own curated examples.</span></button>
        <button type="button" data-action="method" data-method="distillation" aria-pressed="${distill}" class="method-card ${distill ? "selected" : ""}">${icon("lab")}<strong>Response distillation</strong><span>Train a student on a teacher's recorded responses.</span></button></div>
      <section class="form-section"><div class="section-heading"><h3>The experiment</h3><span class="muted">1 / Identity</span></div>
        ${field("Run name", "name", draft.name, { attrs: 'maxlength="100" placeholder="e.g. Coven reasoning · v1"' })}
        ${select("Program", "programId", draft.programId, programOptions())}
        ${field("Training objective", "objective", draft.objective, { textarea: true, attrs: 'maxlength="2000" rows="3" placeholder="What should this model do better? How will you measure it?"' })}</section>
      <section class="form-section"><div class="section-heading"><h3>The knowledge</h3><a href="#/datasets" class="subtle-link">Manage datasets ${icon("arrow")}</a></div>
        ${select("Training dataset", "datasetId", draft.datasetId, datasetOptions(), "required")}
        <div id="dataset-summary" class="dataset-summary">${dataset ? datasetSummary(dataset) : "Import a JSONL dataset to begin. Examples stay on your machine."}</div>
        ${distill ? '<p class="notice inline">Response distillation uses pre-generated teacher examples with a supervised loss. This does not call a teacher API or perform logit matching.</p>' : ""}</section>
      <section class="form-section"><h3>The destination</h3>${field("Local output directory", "outputPath", draft.outputPath, { attrs: 'maxlength="500"', hint: "A path for your trainer, not a directory created by this browser." })}</section>
    </div><aside class="lab-settings" aria-label="Training configuration">
      <div class="inspector-title">${icon("settings")} Model &amp; adapter</div>
      <section>${field(distill ? "Student model" : "Base model", "student", draft.student, { attrs: 'maxlength="200" list="model-options"', hint: "Local path or model repository ID." })}
        <datalist id="model-options"><option value="Qwen/Qwen2.5-7B-Instruct"><option value="meta-llama/Llama-3.1-8B-Instruct"><option value="mistralai/Mistral-7B-Instruct-v0.3"></datalist>
        ${distill ? field("Teacher model", "teacher", draft.teacher, { attrs: 'maxlength="200"', hint: "Must match the dataset's recorded teacher." }) : ""}
      </section><section><div class="section-heading"><h3>LoRA parameters</h3><span class="tag">PEFT</span></div>
        <div class="form-grid">${select("Rank", "rank", draft.rank, [4, 8, 16, 32, 64, 128, 256].map((rank) => [rank, rank]))}${field("Alpha", "alpha", draft.alpha, { type: "number", attrs: 'min="1" max="1024" step="1"' })}</div>
        <p class="help">Higher rank adds adapter capacity and memory use. Target modules are configured in your trainer.</p></section>
      <section><h3>Training parameters</h3>${field("Learning rate", "learningRate", draft.learningRate, { type: "number", attrs: 'min="0.00000001" max="1" step="any"' })}
        <div class="form-grid">${field("Epochs", "epochs", draft.epochs, { type: "number", attrs: 'min="1" max="100" step="1"' })}${field("Micro batch", "batchSize", draft.batchSize, { type: "number", attrs: 'min="1" max="128" step="1"' })}</div>
        ${field("Gradient accumulation", "accumulation", draft.accumulation, { type: "number", attrs: 'min="1" max="1024" step="1"' })}
        ${field("Max sequence length", "maxSequence", draft.maxSequence, { type: "number", attrs: 'min="128" max="131072" step="1"' })}
        <div class="estimate">${icon("clock")}<span id="step-estimate">${stepEstimate()}</span></div></section>
      <section><h3>A note on local training</h3><p class="help">Check model licenses and hardware requirements before training. No weights, datasets, or credentials are sent to a service by this lab.</p></section>
    </aside><div class="lab-submit"><div class="lab-footer"><p>${icon("local")} Saves a plan. Does not launch training.</p><button type="submit" class="button primary">${icon("plus")} Save planned run</button></div>
      <p class="form-error" role="alert" hidden></p></div></form>`;
}

function datasetSummary(dataset) {
  return `${num(dataset.records)} examples · ${num(splitCounts(dataset).train)} train / ${num(splitCounts(dataset).holdout)} holdout · ${dataset.kind === "teacher" ? "Teacher-generated" : "Supervised"}`;
}

function stepEstimate() {
  const dataset = workspace.datasets.find((item) => item.id === ui.draft.datasetId);
  const recipe = numericRecipe(ui.draft);
  if (!dataset || recipe.batchSize < 1 || recipe.accumulation < 1 || recipe.epochs < 1) return "Select a dataset to estimate steps.";
  const steps = estimatedSteps(recipe, dataset);
  return Number.isFinite(steps) ? `~${num(steps)} optimizer steps · single device` : "Enter valid parameters to estimate steps.";
}

function numericRecipe(draft) {
  const recipe = { ...draft };
  for (const key of ["rank", "alpha", "learningRate", "epochs", "batchSize", "accumulation", "maxSequence"]) recipe[key] = Number(recipe[key]);
  return recipe;
}

function artifactTable(artifacts) {
  return table(["Model / artifact", "Format", "Source run", "Local path", ""], artifacts.map((artifact) => [
    `<strong>${esc(artifact.name)}</strong><small>Registered ${formatDate(artifact.createdAt)}</small>`,
    `<span class="tag">${esc(artifact.kind.toUpperCase())}</span>`, runLink(byId(workspace.runs, artifact.runId)),
    `<code class="path">${esc(artifact.path)}</code>`,
    button("Manifest", "artifact-manifest", "download", "small", `data-id="${artifact.id}"`),
  ]), "Local model artifacts");
}

function modelsPage() {
  const artifacts = workspace.artifacts.filter((artifact) => ui.modelKind === "all" || artifact.kind === ui.modelKind);
  return `${header("Model library", button("Register artifact", "new-artifact", "plus"), "The adapters, checkpoints, and local models we are making our own.")}
    <div class="notice">${icon("models")} This is an artifact registry. Paths are recorded references; files are not uploaded, converted, or verified by the browser.</div>
    <div class="filter-tabs" role="group" aria-label="Artifact format">${[["all", "All artifacts"], ["adapter", "LoRA adapters"], ["checkpoint", "Checkpoints"], ["merged", "Merged models"], ["gguf", "GGUF"]].map(([kind, label]) => `<button data-action="model-filter" data-kind="${kind}" class="${ui.modelKind === kind ? "active" : ""}" aria-pressed="${ui.modelKind === kind}">${label}</button>`).join("")}</div>
    ${artifacts.length ? artifactTable(artifacts) : empty("A place for our own models.", workspace.artifacts.length ? "No artifacts match this format." : "Register the local output of a training run, then attach benchmark results to compare candidates.", workspace.runs.length ? button("Register a local artifact", "new-artifact", "plus") : link("Plan the first experiment", "#/playground", "arrow"), "models")}`;
}

function evaluationsPage() {
  return `${header("Evaluations", button("Record evaluation", "new-evaluation", "plus", "primary"), "Small is only better when it still does the work.")}
    <div class="notice">${icon("evaluations")} Record results from your evaluation tools. Compare scores only on the same benchmark version, scoring protocol, and sample set.</div>
    ${workspace.evaluations.length ? table(["Model", "Benchmark / version", "Score", "Samples", "Recorded", "Notes"], workspace.evaluations.slice().reverse().map((evaluation) => {
      const artifact = byId(workspace.artifacts, evaluation.artifactId);
      return [esc(artifact.name), esc(evaluation.benchmark), `<strong>${evaluation.score} / ${evaluation.maximum}</strong><small>${(evaluation.score / evaluation.maximum * 100).toFixed(1)}%</small>`, num(evaluation.samples), formatDate(evaluation.createdAt), esc(evaluation.notes) || "—"];
    }), "Recorded benchmark evaluations") : empty("Better models need honest measurements.", "Register an artifact, run your benchmark locally, and record its score, sample count, and evaluation conditions.", workspace.artifacts.length ? button("Record the first evaluation", "new-evaluation", "plus") : link("Open model library", "#/checkpoints", "arrow"), "evaluations")}`;
}

function resourcesPage() {
  return `${header("Training handbook", "", "A practical path from shared knowledge to a local model.")}
    <div class="resource-grid"><article class="card"><span class="eyebrow">01 · Curate</span><h2>Start with evidence, not volume.</h2><p>Import JSONL with <code>messages</code> or <code>prompt</code> / <code>response</code> records. Track licenses, consent, provenance, and the teacher ID. Do not train on private material without permission.</p><p>Set aside a holdout before training. Mamase records the split plan; your local trainer must shuffle with the recorded seed and apply it.</p>${button("Download example JSONL", "example-dataset", "download")}</article>
    <article class="card"><span class="eyebrow">02 · Distill</span><h2>Pass the teacher's responses on.</h2><p>Generate responses with a teacher outside Mamase. Review and filter them, then import them as teacher-generated examples. Response distillation here means supervised LoRA fine-tuning on those responses.</p><p>It is not online inference, hidden chain-of-thought extraction, or logit/KL distillation. A teacher label alone does not generate data.</p>${link("Configure a recipe", "#/playground", "arrow")}</article>
    <article class="card"><span class="eyebrow">03 · Train</span><h2>Keep execution on your terms.</h2><p>Export the recipe as a planning manifest. Map the settings to a trainer such as Transformers + PEFT, TRL, or MLX-LM. Confirm the model license, target modules, precision, chat template, and hardware fit.</p><p>Record optimizer steps and loss, or import a JSON progress report from the run page. Status changes never start or stop a process.</p><a class="subtle-link" href="https://huggingface.co/docs/peft" target="_blank" rel="noreferrer">PEFT documentation ${icon("external")}</a></article>
    <article class="card"><span class="eyebrow">04 · Evaluate &amp; keep</span><h2>Make the final weights your own.</h2><p>Register the adapter or checkpoint path. Record benchmark versions, scores, sample counts, and conditions. Use your external tools to merge or quantize weights and register the resulting merged model or GGUF separately.</p><p>Model manifests carry the lineage, recipe, and recorded evaluations, not the model weights. Export a workspace backup before clearing browser data.</p>${link("Model library", "#/checkpoints", "arrow")}</article></div>`;
}

function settingsPage() {
  return `${header("Workspace settings", "", "A local home for the coven's experiments.")}
    <div class="settings-grid"><section class="card"><h2>Workspace identity</h2><form data-form="workspace">${field("Workspace name", "workspaceName", workspace.name, { attrs: 'maxlength="80"' })}<button class="button primary" type="submit">Save name</button><p class="form-error" role="alert" hidden></p></form></section>
    <section class="card"><h2>Backups &amp; portability</h2><p>Recipes, dataset fingerprints, recorded results, and artifact references are saved in this browser. No cloud sync or accounts are configured.</p><div class="actions">${button("Export workspace", "export-workspace", "download")}${button("Restore backup", "restore-workspace", "upload")}</div><p class="help">Restoring replaces this workspace after confirmation. Dataset contents and model weights are never included.</p></section>
    <section class="card"><h2>Execution boundary</h2><dl class="facts"><dt>Trainer</dt><dd>External / not connected</dd><dt>Inference</dt><dd>Not connected</dd><dt>Storage</dt><dd>Browser localStorage</dd><dt>Workspace size</dt><dd>${formatBytes(new TextEncoder().encode(JSON.stringify(workspace)).length)} / 4 MB</dd></dl><p>No pretend API keys, credits, running jobs, or benchmark scores.</p></section>
    <section class="card"><h2>Reset workspace</h2><p>Remove this browser's saved metadata and start fresh. Your datasets and local model files are not touched.</p>${button("Reset local workspace", "reset-workspace", "", "danger")}</section></div>`;
}

const pages = { home: homePage, projects: projectsPage, datasets: datasetsPage, sessions: runsPage, checkpoints: modelsPage, playground: labPage, evaluations: evaluationsPage, resources: resourcesPage, settings: settingsPage };

function render() {
  const { page, id } = route();
  let content;
  if (storageError) content = `${header("Workspace needs attention")}<div class="card"><p class="error-text">${esc(storageError)}</p><div class="actions">${button("Download stored data", "raw-backup", "download")}${button("Restore backup", "restore-workspace", "upload")}${button("Reset local workspace", "reset-workspace", "", "danger")}</div></div>`;
  else if (page === "sessions" && id) content = workspace.runs.some((run) => run.id === id) ? runDetail(id) : empty("Run not found.", "This run is not in the current workspace.", link("Back to training runs", "#/sessions"));
  else content = pages[page] ? pages[page]() : empty("Page not found.", "Choose a workspace view from the navigation.", link("Back to overview", "#/home"));
  const pageTitle = nav.find(([key]) => key === page)?.[1] || (page === "settings" ? "Workspace settings" : page === "resources" ? "Training handbook" : "Mamase");
  document.title = `${pageTitle} · Mamase`;
  app.innerHTML = `<div class="shell ${ui.menu ? "menu-open" : ""} ${ui.collapsed ? "collapsed" : ""}">
    <a class="skip-link" href="#main">Skip to content</a>${sidebar(page)}
    <button class="menu-scrim" type="button" data-action="close-menu" aria-label="Close navigation" ${ui.menu ? "" : "hidden"}></button>
    <div class="mobile-header"><button type="button" class="icon-button" data-action="toggle-menu" aria-controls="navigation" aria-expanded="${ui.menu}" aria-label="Open navigation">${icon("panel")}</button><a class="brand" href="#/home">mamase.</a><span class="workspace-tag">LOCAL LAB</span></div>
    <main class="main ${page === "home" ? "main-home" : ""}" id="main" tabindex="-1">${content}</main></div>`;
  updateSidebarAccess();
}

function updateSidebarAccess() {
  document.querySelector(".sidebar").inert = matchMedia("(max-width: 760px)").matches && !ui.menu;
}

function persist(next, expectedSource) {
  assert(localStorage.getItem(STORAGE_KEY) === expectedSource, "This workspace changed while you were editing. Reload before saving to avoid overwriting those changes.");
  workspace = saveWorkspace(localStorage, next);
  savedSource = localStorage.getItem(STORAGE_KEY);
  storageError = "";
}

function notify(message, error = false) {
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.hidden = true; }, error ? 10000 : 4500);
}

let modalContext;
let previousFocus;
function openModal(title, body, form = "", context = {}) {
  previousFocus = document.activeElement;
  modalContext = context;
  dialog.innerHTML = `<div class="modal-header"><h2 id="dialog-title">${title}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon("close")}</button></div>
    ${form ? `<form data-form="${form}">` : "<div>"}${body}<p class="form-error" role="alert" hidden></p>${form ? "</form>" : "</div>"}`;
  if (!dialog.open) dialog.showModal();
}

function closeModal() {
  dialog.close();
  if (previousFocus?.isConnected) previousFocus.focus();
}

const formFooter = (label) => `<div class="modal-footer">${button("Cancel", "close-dialog", "", "quiet")}<button class="button primary" type="submit">${label}</button></div>`;
const optionalNumber = (value) => value === "" ? null : Number(value);

function download(filename, content, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const downloadJson = (name, content) => download(name, JSON.stringify(content, null, 2));

function importDialog(title, form, description, context = {}) {
  openModal(title, `<p class="muted">${description}</p>${field("JSON file", "file", "", { type: "file", attrs: 'accept=".json,application/json"' })}${formFooter("Import")}`, form, context);
}

const actions = {
  "toggle-sidebar": () => {
    const mobile = matchMedia("(max-width: 760px)").matches;
    if (mobile) ui.menu = false; else ui.collapsed = !ui.collapsed;
    render();
    document.querySelector(mobile ? '[data-action="toggle-menu"]' : '[data-action="toggle-sidebar"]').focus();
  },
  "toggle-menu": () => { ui.menu = !ui.menu; render(); if (ui.menu) document.querySelector(".sidebar .icon-button").focus(); },
  "close-menu": () => { ui.menu = false; render(); document.querySelector('[data-action="toggle-menu"]').focus(); },
  "close-dialog": closeModal,
  "new-program": () => programModal(),
  "edit-program": (element) => programModal(byId(workspace.programs, element.dataset.id)),
  "import-dataset": () => openModal("Import a dataset", `
    <p class="muted">JSONL, up to 20 MB. One conversation or prompt/response pair per line. Contents are validated in your browser and are not saved.</p>
    ${field("Dataset name", "name", "", { attrs: 'maxlength="100" placeholder="Coven reasoning examples"' })}
    ${field("JSONL file", "file", "", { type: "file", attrs: 'accept=".jsonl,.ndjson,application/x-ndjson"' })}
    ${select("Example source", "kind", "supervised", [["supervised", "Our supervised examples"], ["teacher", "Pre-generated teacher responses"]])}
    ${field("Teacher model ID (required for teacher responses)", "teacher", "", { required: false, attrs: 'maxlength="200"' })}
    ${field("Provenance & permission", "provenance", "", { textarea: true, attrs: 'rows="2" maxlength="1000" placeholder="Source, license or consent, generation process..."' })}
    ${field("Holdout percentage", "holdout", 10, { type: "number", attrs: 'min="1" max="50" step="1"', hint: "Split plan only. Apply it in your local trainer before training." })}
    ${formFooter("Import dataset")}`, "dataset"),
  "dataset-details": (element) => {
    const dataset = byId(workspace.datasets, element.dataset.id);
    openModal(esc(dataset.name), `<dl class="facts"><dt>File</dt><dd>${esc(dataset.filename)}</dd><dt>Format</dt><dd>${dataset.format}</dd><dt>Split</dt><dd>${datasetSummary(dataset)}</dd><dt>Teacher</dt><dd>${esc(dataset.teacher) || "Not applicable"}</dd><dt>Provenance</dt><dd>${esc(dataset.provenance)}</dd><dt>SHA-256</dt><dd><code>${dataset.sha256}</code></dd></dl><p class="help">The actual examples remain in your source file. The fingerprint identifies the exact imported content.</p>`);
  },
  method: (element) => { ui.draft.method = element.dataset.method; render(); },
  "preview-recipe": () => {
    const form = document.querySelector("#recipe-form");
    if (!form.reportValidity()) return;
    const run = createRun({ id: "preview", name: ui.draft.name, recipe: numericRecipe(ui.draft), createdAt: now() }, workspace);
    openModal("Training recipe", `<p class="muted">A planning manifest for your local trainer. Saving creates a planned run, not a process.</p><pre>${esc(JSON.stringify(exportRecipe(run, workspace), null, 2))}</pre>`);
  },
  progress: (element) => {
    const run = byId(workspace.runs, element.dataset.id);
    const allowed = run.status === "planned" ? ["running", "cancelled"] : ["running", "paused", "completed", "failed", "cancelled"];
    openModal("Record training progress", `<p class="muted">Record what your trainer actually reports. This does not control a training process.</p>
      ${select("Run status", "status", run.status === "planned" ? "running" : run.status, allowed.map((status) => [status, status]))}
      <div class="form-grid">${field("Completed optimizer steps", "step", run.step, { type: "number", attrs: `min="${run.step}" step="1"` })}${field("Total optimizer steps", "totalSteps", run.totalSteps, { type: "number", attrs: 'min="1" step="1"' })}</div>
      <div class="form-grid">${field("Training loss", "loss", "", { type: "number", required: false, attrs: 'min="0" step="any"' })}${field("Validation loss", "evalLoss", "", { type: "number", required: false, attrs: 'min="0" step="any"' })}</div>
      ${field("Progress notes", "note", "", { textarea: true, required: false, attrs: 'rows="2" maxlength="2000"' })}${formFooter("Save progress")}`, "progress", { runId: run.id });
  },
  "export-recipe": (element) => downloadJson(`${element.dataset.id}-recipe.json`, exportRecipe(byId(workspace.runs, element.dataset.id), workspace)),
  "report-template": (element) => {
    const run = byId(workspace.runs, element.dataset.id);
    downloadJson(`${run.id}-report-template.json`, { schema: "mamase.run-report.v1", runId: run.id, updates: [{ status: "running", step: run.step, totalSteps: run.totalSteps, loss: null, evalLoss: null, note: "Replace with actual trainer observations before importing.", recordedAt: now() }] });
  },
  "import-report": (element) => importDialog("Import progress report", "report", "Import a mamase.run-report.v1 JSON file. Updates must be chronological, use this run ID, and cannot move completed steps backwards.", { runId: element.dataset.id }),
  "new-artifact": (element) => {
    assert(workspace.runs.length, "Save a planned run in the distillation lab before registering its outputs.");
    const run = workspace.runs.find((item) => item.id === element.dataset.id) || workspace.runs.at(-1);
    openModal("Register local artifact", `<p class="muted">Record a file or directory your trainer has created. No file is uploaded or converted.</p>
      ${field("Artifact name", "name", "", { attrs: 'maxlength="100" placeholder="Coven reasoning · adapter v1"' })}
      ${select("Source run", "runId", run.id, workspace.runs.map((item) => [item.id, item.name]))}
      ${select("Artifact format", "kind", "adapter", [["adapter", "LoRA adapter"], ["checkpoint", "Training checkpoint"], ["merged", "Merged model"], ["gguf", "GGUF"]])}
      ${field("Local file or directory path", "path", run.recipe.outputPath, { attrs: 'maxlength="1000"' })}
      ${field("Notes (precision, quantization, checkpoint step)", "notes", "", { textarea: true, required: false, attrs: 'rows="2" maxlength="2000"' })}${formFooter("Register artifact")}`, "artifact");
  },
  "artifact-manifest": (element) => {
    const artifact = byId(workspace.artifacts, element.dataset.id);
    const run = byId(workspace.runs, artifact.runId);
    downloadJson(`${artifact.id}-manifest.json`, { schema: "mamase.model-manifest.v1", artifact, training: exportRecipe(run, workspace), evaluations: workspace.evaluations.filter((evaluation) => evaluation.artifactId === artifact.id), note: "Metadata only. Model weights remain at the recorded local path; file existence and compatibility are not verified by Mamase." });
  },
  "model-filter": (element) => { ui.modelKind = element.dataset.kind; render(); },
  "new-evaluation": () => {
    assert(workspace.artifacts.length, "Register a model artifact before recording its evaluation.");
    openModal("Record evaluation", `<p class="muted">Use results from your local benchmark tool. Include the benchmark version and evaluation conditions for meaningful comparisons.</p>
      ${select("Model artifact", "artifactId", workspace.artifacts.at(-1).id, workspace.artifacts.map((artifact) => [artifact.id, artifact.name]))}
      ${field("Benchmark & version", "benchmark", "", { attrs: 'maxlength="200" placeholder="e.g. coven-reasoning-v1 · accuracy"' })}
      <div class="form-grid">${field("Score", "score", "", { type: "number", attrs: 'min="0" step="any"' })}${field("Maximum score", "maximum", 100, { type: "number", attrs: 'min="0.000001" step="any"' })}</div>
      ${field("Number of evaluated samples", "samples", "", { type: "number", attrs: 'min="1" step="1"' })}
      ${field("Conditions & notes", "notes", "", { textarea: true, required: false, attrs: 'rows="2" maxlength="2000" placeholder="Split, seed, prompt, decoding settings, hardware..."' })}${formFooter("Save evaluation")}`, "evaluation");
  },
  "export-runs": () => download("coven-training-runs.csv", runsCsv(workspace.runs), "text/csv"),
  "export-workspace": () => downloadJson("coven-workspace.json", workspace),
  "restore-workspace": () => openModal("Restore a workspace backup", `<p class="warning">This replaces the current workspace. Export your current data first. Datasets and model files on disk are not affected.</p>${field("Workspace JSON backup", "file", "", { type: "file", attrs: 'accept=".json,application/json"' })}<label class="check-label"><input name="confirm" type="checkbox" required> I understand this replaces the browser's saved workspace.</label>${formFooter("Restore workspace")}`, "restore"),
  "reset-workspace": () => openModal("Reset local workspace", `<p class="warning">All recorded programs, dataset metadata, runs, artifacts, and evaluations in this browser will be removed. Export a backup first.</p>${field("Type RESET to confirm", "confirmation")}${formFooter("Reset workspace")}`, "reset"),
  "raw-backup": () => { const raw = localStorage.getItem(STORAGE_KEY); assert(raw !== null, "No stored data is available to download."); download("mamase-recovery.json", raw); },
  "example-dataset": () => download("coven-example.jsonl", [
    { prompt: "What should we record with a model checkpoint?", response: "Its source run, base model, training step, dataset fingerprint, configuration, and local path." },
    { prompt: "Why keep a holdout split?", response: "To measure generalization on examples excluded from training." },
    { prompt: "Does a LoRA adapter include all base model weights?", response: "No. It stores a small set of learned parameters and requires its compatible base model." },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n", "application/x-ndjson"),
};

function programModal(program) {
  openModal(program ? "Manage program" : "New training program", `${field("Program name", "name", program?.name || "", { attrs: 'maxlength="100"' })}${field("Purpose", "description", program?.description || "", { textarea: true, required: false, attrs: 'rows="3" maxlength="1000"' })}${formFooter(program ? "Save program" : "Create program")}`, "program", { id: program?.id });
}

async function readFile(form, maxBytes) {
  const file = new FormData(form).get("file");
  assert(file instanceof File && file.size > 0, "Choose a nonempty file.");
  assert(file.size <= maxBytes, `File exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`);
  return { file, source: await file.text() };
}

async function submitForm(form) {
  const input = Object.fromEntries(new FormData(form));
  const type = form.dataset.form;
  const context = { ...modalContext };
  const expectedSource = savedSource;
  let next = structuredClone(workspace);
  let message;
  let destination;
  if (type === "program") {
    const record = { id: context.id || newId("program"), name: input.name, description: input.description };
    const index = next.programs.findIndex((program) => program.id === record.id);
    if (index < 0) next.programs.push(record); else next.programs[index] = record;
    message = "Program saved.";
  } else if (type === "dataset") {
    const { file, source } = await readFile(form, MAX_IMPORT_BYTES);
    const parsed = parseDataset(source);
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    assert(!next.datasets.some((dataset) => dataset.sha256 === sha256), "This exact dataset is already registered.");
    const dataset = validateDataset({ ...input, ...parsed, id: newId("dataset"), filename: file.name, bytes: file.size, holdout: Number(input.holdout), sha256, createdAt: now() });
    next.datasets.push(dataset);
    message = `${num(dataset.records)} examples validated. Dataset metadata saved.`;
  } else if (type === "recipe") {
    const run = createRun({ id: newId("run"), name: input.name, recipe: numericRecipe({ ...ui.draft, ...input }), createdAt: now() }, next);
    next.runs.push(run);
    destination = `#/sessions/${run.id}`;
    message = "Planned run saved. No training process was started.";
  } else if (type === "progress") {
    const index = next.runs.findIndex((run) => run.id === context.runId);
    next.runs[index] = recordProgress(byId(next.runs, context.runId), { ...input, step: Number(input.step), totalSteps: Number(input.totalSteps), loss: optionalNumber(input.loss), evalLoss: optionalNumber(input.evalLoss), recordedAt: now() });
    message = "Training progress recorded.";
  } else if (type === "report") {
    const { source } = await readFile(form, MAX_WORKSPACE_BYTES);
    const report = JSON.parse(source);
    assert(report.schema === "mamase.run-report.v1" && report.runId === context.runId, "Expected a mamase.run-report.v1 report for this run.");
    assert(Array.isArray(report.updates) && report.updates.length > 0 && report.updates.length <= 10000, "Report needs 1–10,000 progress updates.");
    const index = next.runs.findIndex((run) => run.id === report.runId);
    for (const update of report.updates) next.runs[index] = recordProgress(next.runs[index], update);
    message = `${report.updates.length} progress observations imported.`;
  } else if (type === "artifact") {
    next.artifacts.push(validateArtifact({ ...input, id: newId("artifact"), createdAt: now() }, next));
    message = "Artifact reference registered. Local files were not changed.";
  } else if (type === "evaluation") {
    next.evaluations.push(validateEvaluation({ ...input, id: newId("evaluation"), score: Number(input.score), maximum: Number(input.maximum), samples: Number(input.samples), createdAt: now() }, next));
    message = "Evaluation result recorded.";
  } else if (type === "workspace") {
    next.name = input.workspaceName;
    message = "Workspace name saved.";
  } else if (type === "restore") {
    assert(input.confirm === "on", "Confirm that you want to replace the workspace.");
    const { source } = await readFile(form, MAX_WORKSPACE_BYTES);
    next = validateWorkspace(JSON.parse(source));
    message = "Workspace restored.";
    destination = "#/home";
  } else if (type === "reset") {
    assert(input.confirmation === "RESET", "Type RESET exactly to confirm.");
    next = createWorkspace();
    message = "Local workspace reset.";
    destination = "#/home";
  } else {
    throw new Error("Unknown form.");
  }
  assert(form.isConnected && (form.closest("dialog") === null || dialog.open), "The form was closed before saving. No changes were made.");
  persist(next, expectedSource);
  if (type === "recipe" || type === "reset" || type === "restore") ui.draft = defaults();
  if (type === "reset" || type === "restore") { ui.program = "all"; ui.status = "all"; ui.query = ""; }
  closeModal();
  if (destination && location.hash !== destination) location.hash = destination; else render();
  notify(message);
}

document.addEventListener("click", (event) => {
  const element = event.target.closest("[data-action]");
  if (!element) return;
  try {
    const action = actions[element.dataset.action];
    assert(action, "This action is unavailable.");
    action(element);
  } catch (error) {
    notify(error.message, true);
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-form]");
  if (!form) return;
  event.preventDefault();
  const errorBox = form.querySelector(".form-error");
  errorBox.hidden = true;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await submitForm(form);
  } catch (error) {
    errorBox.textContent = error.name === "QuotaExceededError" ? "Browser storage is full. Export a backup and free space before saving." : error.message;
    errorBox.hidden = false;
    if (form.isConnected && (form.closest("dialog") === null || dialog.open)) errorBox.scrollIntoView({ block: "nearest" });
    else notify(errorBox.textContent, true);
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener("input", (event) => {
  const element = event.target;
  if (element.closest("#recipe-form") && element.name) {
    ui.draft[element.name] = element.value;
    const dataset = workspace.datasets.find((item) => item.id === ui.draft.datasetId);
    document.querySelector("#dataset-summary").textContent = dataset ? datasetSummary(dataset) : "Import and select a JSONL dataset to begin.";
    document.querySelector("#step-estimate").textContent = stepEstimate();
  }
  if (element.id === "run-search") {
    ui.query = element.value;
    document.querySelector("#run-results").innerHTML = runResults();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.name === "program-filter") ui.program = event.target.value;
  else if (event.target.name === "status-filter") ui.status = event.target.value;
  else return;
  document.querySelector("#run-results").innerHTML = runResults();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && ui.menu && !dialog.open) actions["close-menu"]();
  if (ui.menu && !dialog.open && event.key === "Tab") {
    const targets = [...document.querySelectorAll(".sidebar a, .sidebar button")];
    if (event.shiftKey && document.activeElement === targets[0]) { event.preventDefault(); targets.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === targets.at(-1)) { event.preventDefault(); targets[0].focus(); }
  }
});

document.addEventListener("click", (event) => {
  if (event.target.closest(".skip-link")) { event.preventDefault(); document.querySelector("#main").focus(); }
});
window.addEventListener("hashchange", () => { ui.menu = false; closeModal(); render(); window.scrollTo(0, 0); document.querySelector("#main").focus({ preventScroll: true }); });
window.addEventListener("resize", updateSidebarAccess);
window.addEventListener("storage", (event) => { if (event.key === STORAGE_KEY) notify("This workspace changed in another tab. Reload before saving.", true); });
render();
