import {
  STORAGE_KEY, METHODS, ADAPTERS, STATUSES, MAX_IMPORT_BYTES, MAX_WORKSPACE_BYTES, assert,
  createWorkspace, loadWorkspace, saveWorkspace, validateWorkspace, parseDataset,
  validateDataset, splitCounts, createRun, recordProgress, validateArtifact,
  validateEvaluation, exportRecipe, escapeHtml as esc, runsCsv, estimatedSteps,
  importTrainingResult, importEvaluationReport,
} from "./workspace.js";
import { icon, button, link, field, select, badge, empty, table, formatDate, formatBytes, progress, lossChart, distillationArt } from "./ui.js";
import { DRAFT_KEY, RUN_PAGE_SIZE, parseRoute, runUrl, selectRuns, searchWorkspace, compareEvaluations, readRecipeDraft } from "./experience.js";
import { TrainingClient, encodeDataset, localJobActive } from "./training-client.js";
import { mergeTrainingJob, trainingIdentity } from "./training-state.js";

const app = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const toast = document.querySelector("#toast");
const theme = window.mamaseTheme;
const pendingTraining = new Map();
const trainingSyncErrors = new Map();
let submissionCount = 0;
let trainingFlushTimer;
const training = new TrainingClient({ onJob: receiveTrainingJob, onStatus: updateTrainingPanel });
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
  adapter: "lora", familiarId: "", instanceId: "",
});
const ui = { menu: false, collapsed: false, draft: defaults(), query: "", status: "all", program: "all", sort: "updated", runPage: 1, modelKind: "all", conflict: false };
let draftBlocked = false;
let draftMessage = "Recipe changes are saved in this tab until you save a planned run.";
try {
  const recovered = readRecipeDraft(sessionStorage, defaults());
  if (recovered) { ui.draft = recovered; draftMessage = "Recipe draft restored from this tab. Review it before saving."; }
} catch (error) {
  draftBlocked = true;
  draftMessage = `Draft could not be restored: ${error.message} Download or discard it before saving another draft.`;
}
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
  return parseRoute(location.hash);
}

function saveDraft() {
  if (!draftBlocked) {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, draft: ui.draft }));
      draftMessage = "Draft saved in this tab. No training run has been created.";
    } catch (error) {
      draftMessage = `Draft is not saved: ${error.message} Keep this tab open or download the draft.`;
    }
  }
  syncRecipe();
}

function clearDraft() {
  sessionStorage.removeItem(DRAFT_KEY);
  ui.draft = defaults();
  draftBlocked = false;
  draftMessage = "Recipe changes are saved in this tab until you save a planned run.";
}

function useDraft(draft) {
  ui.draft = draft;
  closeModal();
  saveDraft();
  if (location.hash === "#/playground") render(); else location.hash = "#/playground";
}

function requestDraft(draft) {
  if (draftBlocked || JSON.stringify(ui.draft) !== JSON.stringify(defaults())) {
    openModal("Replace the current recipe draft?", `<p>Your existing draft has not been saved as a planned run. Download it or keep editing before replacing it.</p><div class="actions">${button("Download draft", "download-draft", "download")}${button("Keep editing", "close-dialog", "", "quiet")}${button("Replace draft", "replace-draft", "", "primary")}</div>`, "", { draft });
  } else useDraft(draft);
}

function sidebar(page) {
  const links = [...nav, ["resources", "Training handbook", "docs"], ["settings", "Workspace settings", "settings"]];
  return `<aside class="sidebar" id="navigation" aria-label="Workspace navigation">
    <div class="brand-row"><a class="brand" href="#/home" aria-label="Mamase overview">mamase<span class="brand-dot">.</span></a>
      <button class="icon-button" type="button" data-action="toggle-sidebar" aria-label="${ui.collapsed ? "Expand" : "Collapse"} navigation">${icon("panel")}</button></div>
    <div class="workspace-label"><span class="tiny-mark">${icon("spark")}</span><span>${esc(workspace?.name || "The Coven")}</span><span class="workspace-tag">LOCAL</span></div>
    ${workspace ? `<button type="button" class="workspace-search-button" data-action="search" aria-label="Search workspace">${icon("search")}<span>Search workspace</span><kbd>Ctrl K</kbd></button>` : ""}
    <nav>${links.map(([id, label, glyph], index) => `${index === 7 ? '<div class="nav-section">Workspace</div>' : ""}<a href="#/${id}" class="nav-link ${page === id ? "active" : ""}" ${page === id ? 'aria-current="page"' : ""} aria-label="${label}" title="${label}">${icon(glyph)}<span>${label}</span>${id === "sessions" && workspace?.runs.length ? `<span class="nav-count">${workspace.runs.length}</span>` : ""}</a>`).join("")}</nav>
    <div class="sidebar-bottom"><div class="local-status"><span class="status-dot"></span><span>Local workspace</span></div>
      <p>Knowledge stays in the coven.</p>
      <a class="profile" href="#/settings"><span class="avatar">C</span><span><strong>${esc(workspace?.name || "The Coven")}</strong><small>On this browser</small></span>${icon("settings")}</a></div>
  </aside>`;
}

function themePicker() {
  return `<div class="theme-picker" role="group" aria-label="Appearance mode">${[
    ["system", "System", "local"], ["light", "Light", "light"], ["dark", "Dark", "dark"],
  ].map(([value, label, glyph]) => `<button type="button" data-action="theme" data-theme-value="${value}" aria-pressed="${theme.preference === value}" title="${label} theme">${icon(glyph)}<span>${label}</span></button>`).join("")}</div>`;
}

function syncThemeControls() {
  document.querySelectorAll("[data-theme-value]").forEach((element) => {
    element.setAttribute("aria-pressed", String(element.dataset.themeValue === theme.preference));
  });
  const description = document.querySelector("#theme-description");
  if (description) description.textContent = theme.preference === "system"
    ? `Following your device. Currently using ${document.documentElement.dataset.theme} mode.`
    : `${theme.preference === "dark" ? "Dark" : "Light"} mode stays on regardless of your device setting.`;
  if (theme.error) notify(theme.error, true);
}

function header(title, actions = "", subtitle = "") {
  return `<header class="page-header"><div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div><div class="actions">${actions}</div></header>`;
}

function metric(label, value, note, glyph, href = "") {
  const tag = href ? "a" : "article";
  return `<${tag} class="metric${href ? " metric-link" : ""}"${href ? ` href="${esc(href)}"` : ""}><div class="metric-label">${label}${icon(glyph)}</div><strong>${value}</strong><p>${note}</p></${tag}>`;
}

function homePage() {
  const active = workspace.runs.filter((run) => ["running", "paused"].includes(run.status)).length;
  const completed = workspace.runs.filter((run) => run.status === "completed").length;
  const hasDataset = workspace.datasets.length > 0;
  return `<div class="home-page">
    <div class="home-topline"><span>YOUR COVEN'S MODEL WORKSPACE</span><span>${icon("local")} Local-first. Yours to shape.</span></div>
    <section class="home-stage"><div class="home-copy"><p class="home-kicker">Less model. <strong>More of us.</strong></p>
      <h1>Distill knowledge.<br>Make it our own.</h1>
      <p class="home-intro">A home for the coven's next generation of local models. Distill from teachers, shape with LoRA, and follow every experiment from first example to final weights.</p>
      <div class="actions">${link(hasDataset ? "Open the lab" : "Import a dataset", hasDataset ? "#/playground" : "#/datasets", hasDataset ? "lab" : "upload", "primary")}${link("The workflow", "#/resources", "arrow", "quiet")}</div>
      <div class="hero-caption"><span></span>Small models. Shared knowledge. Our own way.</div></div>
      <div class="hero-art">${distillationArt()}</div></section>
    <section class="metrics overview-metrics" aria-label="Workspace progress">
      ${metric("Training runs", num(workspace.runs.length), `${active} active · ${completed} completed`, "runs", "#/sessions")}
      ${metric("Curated examples", num(workspace.datasets.reduce((sum, dataset) => sum + dataset.records, 0)), `Across ${workspace.datasets.length} datasets`, "datasets", "#/datasets")}
      ${metric("Model artifacts", num(workspace.artifacts.length), "Registered local paths", "models", "#/checkpoints")}
      ${metric("Evaluations", num(workspace.evaluations.length), "Recorded benchmark results", "evaluations", "#/evaluations")}
    </section>
    <section class="home-grid"><article class="home-panel"><div class="section-heading"><h2>${icon("runs")} Recent experiments</h2><a href="#/sessions" class="subtle-link">View all ${icon("arrow")}</a></div>
      ${workspace.runs.length ? `<div class="recent-list">${workspace.runs.slice(-2).reverse().map((run) => `<a class="recent-run" href="#/sessions/${run.id}"><span class="item-icon">${icon(run.recipe.method === "lora" ? "spark" : "lab")}</span><div><strong>${esc(run.name)}</strong><small>${METHODS[run.recipe.method]} · ${esc(run.recipe.student.split("/").at(-1))}</small></div>${badge(run.status)}</a>`).join("")}</div>` : empty("Every model starts with an experiment.", hasDataset ? "Your dataset is ready. Give your first experiment a shape." : "Start with a dataset, then shape your first training recipe.", link(hasDataset ? "Create a training recipe" : "Add training examples", hasDataset ? "#/playground" : "#/datasets", "plus"), "runs", true)}
    </article><article class="home-panel"><div class="section-heading"><h2>${icon("lab")} From teacher to familiar</h2><span class="muted">The workflow</span></div>
      <ol class="workflow"><li><span>1</span><div><a href="#/datasets">Curate the knowledge</a><p>Bring your examples or a teacher's responses.</p></div></li>
      <li><span>2</span><div><a href="#/playground">Shape a smaller model</a><p>Set the student, LoRA adapter, and training recipe.</p></div></li>
      <li><span>3</span><div><a href="#/evaluations">Measure what matters</a><p>Record results, compare artifacts, and keep the best.</p></div></li></ol>
    </article></section>
    <div class="local-note">${icon("local")} Launch local MLX jobs from saved runs, or record results from external trainers. Only real observations are tracked.</div>
  </div>`;
}

function projectsPage() {
  const rows = workspace.programs.map((program) => {
    const runs = workspace.runs.filter((run) => run.recipe.programId === program.id);
    const artifacts = workspace.artifacts.filter((artifact) => runs.some((run) => run.id === artifact.runId));
    return [`<a class="record-link" href="${esc(runUrl({ ...parseRoute("#/sessions"), program: program.id }))}">${esc(program.name)}</a><small>${esc(program.description)}</small>`, `<code>${esc(program.id.slice(0, 18))}</code>`, num(runs.length), num(runs.filter((run) => run.status === "completed").length), num(artifacts.length), button("Manage", "edit-program", "", "small", `data-id="${program.id}"`)];
  });
  return `${header("Programs", button("New program", "new-program", "plus"), "Keep related distillation and LoRA experiments together.")}
    ${table(["Program", "Program ID", "Runs", "Completed", "Artifacts", ""], rows, "Training programs")}`;
}

function datasetsPage() {
  return `${header("Datasets", button("Import JSONL", "import-dataset", "plus", "primary"), "Know what goes into the model. Keep training and holdout examples separate.")}
    <div class="notice">${icon("local")} Imports stay on this device. Only metadata and a SHA-256 fingerprint are saved; example contents are not retained.</div>
    ${workspace.datasets.length ? table(["Dataset", "Source", "Examples", "Train / holdout", "Size", ""], workspace.datasets.map((dataset) => [
      `<a class="record-link" href="#/datasets/${dataset.id}">${esc(dataset.name)}</a><small>${esc(dataset.filename)}</small>`,
      dataset.kind === "teacher" ? `<span class="tag">Teacher responses</span><small>${esc(dataset.teacher)}</small>` : '<span class="tag">Supervised examples</span>',
      num(dataset.records), `${num(splitCounts(dataset).train)} / ${num(splitCounts(dataset).holdout)}`, formatBytes(dataset.bytes),
      button("Details", "dataset-details", "", "small", `data-id="${dataset.id}"`),
    ]), "Imported datasets") : empty("Give your model something worth learning.", "Import a JSONL dataset of conversations or prompt/response pairs. For distillation, use responses already generated by your teacher.", button("Import your first dataset", "import-dataset", "upload"), "datasets")}`;
}

function runsPage() {
  return `${header("Training runs", link("New recipe", "#/playground", "plus", "primary"), "A record of actual experiments. No simulated progress.")}
    <div class="filters">
      ${select("Program", "program-filter", ui.program, [["all", "All programs"], ...programOptions(), ...(ui.program !== "all" && !workspace.programs.some((program) => program.id === ui.program) ? [[ui.program, "Unavailable program"]] : [])])}
      ${select("Status", "status-filter", ui.status, [["all", "All statuses"], ...STATUSES.map((status) => [status, status[0].toUpperCase() + status.slice(1)])])}
      ${select("Sort runs", "run-sort", ui.sort, [["updated", "Recently updated"], ["created", "Newest recipes"], ["name", "Name A–Z"], ["progress", "Most progress"]])}
      <div class="field search-field"><label for="run-search">Search runs</label><div>${icon("search")}<input id="run-search" type="search" placeholder="Search by name, model, or run ID..." value="${esc(ui.query)}"></div></div>
      ${button("Clear filters", "clear-run-filters", "", "quiet")}${button("Export CSV", "export-runs", "download", "quiet")}
    </div><p class="help" id="run-count" role="status"></p><p class="help">CSV exports all matching runs, in the selected order, across every page.</p><div id="run-results">${runResults()}</div>`;
}

function runResults() {
  const filtered = selectRuns(workspace.runs, ui);
  if (!filtered.length) return empty(workspace.runs.length ? "No matching runs." : "Your next model begins here.", workspace.runs.length ? "Clear filters to see all your experiments." : "Save a recipe in the lab, execute it with your local trainer, and record the results here.", workspace.runs.length ? button("Show all runs", "clear-run-filters", "arrow") : link("Open distillation lab", "#/playground", "arrow"), "runs");
  const pages = Math.ceil(filtered.length / RUN_PAGE_SIZE);
  const page = Math.min(ui.runPage, pages);
  return `<h2 class="sr-only" id="run-results-heading" tabindex="-1">Matching training runs</h2>${table(["Experiment", "Method", "Status", "Progress", "Last recorded"], filtered.slice((page - 1) * RUN_PAGE_SIZE, page * RUN_PAGE_SIZE).map((run) => [
    `${runLink(run)}<small>${esc(run.recipe.student)}</small>`, METHODS[run.recipe.method], badge(run.status), progress(run), formatDate(run.updatedAt),
  ]), "Recorded training runs")}${pages > 1 ? `<nav class="pagination" aria-label="Training run pages">${button("Previous", "run-page", "", "small", `data-page="${page - 1}" ${page === 1 ? "disabled" : ""}`)}<span>Page ${page} of ${pages}</span>${button("Next", "run-page", "", "small", `data-page="${page + 1}" ${page === pages ? "disabled" : ""}`)}</nav>` : ""}`;
}

function updateRunResults(focus = false) {
  history.replaceState(null, "", runUrl(ui));
  document.querySelector("#run-results").innerHTML = runResults();
  syncRunCount();
  if (focus) document.querySelector("#run-results-heading")?.focus();
}

function syncRunCount() {
  const count = document.querySelector("#run-count");
  if (count) count.textContent = `${num(selectRuns(workspace.runs, ui).length)} of ${num(workspace.runs.length)} runs match.`;
}

function runDetail(id) {
  const run = byId(workspace.runs, id);
  const dataset = byId(workspace.datasets, run.recipe.datasetId);
  const latest = run.history.filter((event) => event.loss !== null).at(-1);
  const validation = run.history.filter((event) => event.evalLoss !== null).at(-1);
  const closed = ["completed", "failed", "cancelled"].includes(run.status);
  return `<a class="breadcrumb" href="#/sessions">Training runs / <span>${esc(run.name)}</span></a>
    ${header(esc(run.name), `${button("Duplicate recipe", "duplicate-run", "plus", "", `data-id="${run.id}"`)}${button("Export recipe", "export-recipe", "download", "", `data-id="${run.id}"`)}${closed ? "" : button("Record progress", "progress", "plus", "primary", `data-id="${run.id}"`)}`, `${esc(METHODS[run.recipe.method])} · ${esc(run.recipe.student)}`)}
    <div class="run-status-row" id="run-status-line">${badge(run.status)}<code>${run.id}</code><span class="muted">Last recorded ${formatDate(run.updatedAt)}</span></div>
    <section class="card local-training-panel" id="local-training-panel" data-run-id="${run.id}" aria-label="Local training"><h2>Local MLX-LM training</h2><p class="help">Checking the local trainer…</p></section>
    <div class="metrics three">${metric("Optimizer steps", `<span id="run-step-value">${num(run.step)} / ${num(run.totalSteps)}</span>`, "Recorded manually or by your local trainer", "runs")}${metric("Training loss", `<span id="run-loss-value">${latest ? String(latest.loss) : "—"}</span>`, `<span id="run-validation-value">${validation ? `Latest validation loss: ${validation.evalLoss}` : "No validation loss recorded"}</span>`, "evaluations")}${metric("Dataset", num(dataset.records), `${esc(dataset.name)} · ${dataset.holdout}% holdout`, "datasets", `#/datasets/${dataset.id}`)}</div>
    <div class="detail-grid"><section class="card chart-card"><div class="section-heading"><h2>Training &amp; validation loss</h2><span class="muted">Recorded observations</span></div><div id="run-loss-chart">${lossChart(run)}</div></section>
    <section class="card"><h2>Recipe</h2><dl class="facts"><dt>Method</dt><dd>${METHODS[run.recipe.method]}</dd>${run.recipe.teacher ? `<dt>Teacher</dt><dd>${esc(run.recipe.teacher)}</dd>` : ""}<dt>LoRA rank / alpha</dt><dd>${run.recipe.rank} / ${run.recipe.alpha}</dd><dt>Learning rate</dt><dd>${run.recipe.learningRate}</dd><dt>Epochs</dt><dd>${run.recipe.epochs}</dd><dt>Output</dt><dd><code>${esc(run.recipe.outputPath)}</code></dd></dl><p class="muted">${esc(run.recipe.objective)}</p></section></div>
    <section class="card"><h2>Run locally</h2><p>${esc(ADAPTERS[run.recipe.adapter])} · ${run.recipe.familiarId ? `${esc(run.recipe.instanceId)} / ${esc(run.recipe.familiarId)}` : "Unbound legacy recipe: create a new recipe with familiar and instance IDs to use the local trainer."}</p>
      <p>Export this recipe, then prepare an identity-bound bundle with your original dataset and that familiar's workspace. Preparation does not train or download a model.</p>
      <pre>mkdir -p .lab
npm run lab -- prepare --recipe /path/recipe.json --dataset /path/examples.jsonl --identity-dir /path/familiar --out .lab/experiment</pre>
      <p>After inspecting the bundle, use a compatible local safetensors model:</p>
      <pre>.venv/bin/python training/train.py --bundle .lab/experiment --model /path/local-model</pre>
      <p class="help">Once training exits, import <code>run-report.json</code> below, then import <code>result.json</code> to register the actual adapter path and holdout comparison. Run a separate versioned suite with <code>training/evaluate.py</code> and import its paired report from Evaluations. Nothing promotes the adapter.</p></section>
    <section class="card"><div class="section-heading"><h2>Progress journal</h2><div class="actions">${button("Report template", "report-template", "code", "small", `data-id="${run.id}"`)}${closed ? "" : button("Import report", "import-report", "upload", "small", `data-id="${run.id}"`)}</div></div>
    <div id="run-journal">${runJournal(run)}</div></section>
    <section class="card"><div class="section-heading"><h2>Local model artifacts</h2><div class="actions">${run.status === "completed" && !run.localJobId ? button("Import training result", "import-training-result", "upload", "small", `data-id="${run.id}"`) : ""}${button("Register artifact", "new-artifact", "plus", "small", `data-id="${run.id}"`)}</div></div>
    <div id="run-artifacts">${runArtifacts(run)}</div></section>`;
}

function runJournal(run) {
  return run.history.length ? table(["Recorded", "Status", "Step", "Loss / validation", "Notes"], run.history.slice().reverse().map((event) => [formatDate(event.recordedAt), badge(event.status), `${event.step} / ${event.totalSteps}`, `${event.loss ?? "—"} / ${event.evalLoss ?? "—"}`, esc(event.note) || "—"]), "Run progress journal") : '<p class="muted">This recipe is planned, not running. Launch a local job or record observations from an external trainer.</p>';
}

function runArtifacts(run) {
  const artifacts = workspace.artifacts.filter((artifact) => artifact.runId === run.id);
  return artifacts.length ? artifactTable(artifacts) : '<p class="muted">Local managed jobs register finalized adapters automatically. Other trainer outputs can be registered manually.</p>';
}

function receiveTrainingJob(job) {
  pendingTraining.set(job.run.id, job);
  if (!trainingFlushTimer) trainingFlushTimer = setTimeout(() => { trainingFlushTimer = null; flushTrainingUpdates(); }, localJobActive(job) ? 200 : 0);
}

function flushTrainingUpdates() {
  if (!workspace || storageError || submissionCount || dialog.open || ui.conflict) return;
  for (const [runId, job] of pendingTraining) {
    if (!workspace.runs.some((run) => run.id === runId)) { pendingTraining.delete(runId); continue; }
    try {
      const next = mergeTrainingJob(workspace, job);
      if (JSON.stringify(next) !== JSON.stringify(workspace)) {
        persist(next, savedSource);
        refreshManagedRun(runId);
      }
      trainingSyncErrors.delete(runId);
      pendingTraining.delete(runId);
    } catch (error) {
      trainingSyncErrors.set(runId, `Progress is retained by the local server, but workspace sync is blocked: ${error.message}`);
    }
    updateTrainingPanel(runId);
  }
}

function refreshManagedRun(runId) {
  const panel = document.querySelector("#local-training-panel");
  if (panel?.dataset.runId !== runId) {
    const current = route();
    if (current.page === "home") {
      const metrics = document.querySelectorAll(".overview-metrics .metric");
      if (metrics.length === 4) {
        metrics[0].querySelector("p").textContent = `${workspace.runs.filter((run) => ["running", "paused"].includes(run.status)).length} active · ${workspace.runs.filter((run) => run.status === "completed").length} completed`;
        metrics[2].querySelector("strong").textContent = num(workspace.artifacts.length);
        const run = byId(workspace.runs, runId);
        const status = document.querySelector(`.recent-run[href="#/sessions/${runId}"] .badge`);
        if (status) { status.className = `badge status-${run.status}`; status.innerHTML = `<span class="status-dot"></span>${esc(run.status)}`; }
      }
    } else if (current.page === "sessions" && !current.id) {
      const href = document.activeElement.closest("#run-results a")?.getAttribute("href");
      updateRunResults();
      if (href) document.querySelector(`#run-results a[href="${CSS.escape(href)}"]`)?.focus({ preventScroll: true });
    } else if (jobHasArtifact(runId) && ["projects", "checkpoints"].includes(current.page) && !current.id) {
      const focused = document.activeElement;
      const action = focused.dataset.action;
      const id = focused.dataset.id;
      const kind = focused.dataset.kind;
      render();
      if (action) document.querySelector(`[data-action="${CSS.escape(action)}"]${id ? `[data-id="${CSS.escape(id)}"]` : kind ? `[data-kind="${CSS.escape(kind)}"]` : ""}`)?.focus({ preventScroll: true });
    }
    const size = document.querySelector("#workspace-size");
    if (size) size.textContent = `${formatBytes(new TextEncoder().encode(JSON.stringify(workspace)).length)} / 4 MB`;
    return;
  }
  const run = byId(workspace.runs, runId);
  const latest = run.history.filter((event) => event.loss !== null).at(-1);
  const validation = run.history.filter((event) => event.evalLoss !== null).at(-1);
  document.querySelector("#run-status-line").innerHTML = `${badge(run.status)}<code>${run.id}</code><span class="muted">Last recorded ${formatDate(run.updatedAt)}</span>`;
  document.querySelector("#run-step-value").textContent = `${num(run.step)} / ${num(run.totalSteps)}`;
  document.querySelector("#run-loss-value").textContent = latest ? String(latest.loss) : "—";
  document.querySelector("#run-validation-value").textContent = validation ? `Latest validation loss: ${validation.evalLoss}` : "No validation loss recorded";
  const chart = document.querySelector("#run-loss-chart");
  const details = chart.querySelector("details");
  const expanded = details?.open;
  const summaryFocused = document.activeElement === details?.querySelector("summary");
  chart.innerHTML = lossChart(run);
  if (expanded) chart.querySelector("details").open = true;
  if (summaryFocused) chart.querySelector("summary")?.focus({ preventScroll: true });
  const journal = document.querySelector("#run-journal");
  const scroll = journal.querySelector(".table-scroll")?.scrollLeft || 0;
  const journalFocused = journal.contains(document.activeElement);
  journal.innerHTML = runJournal(run);
  const region = journal.querySelector(".table-scroll");
  if (region) { region.scrollLeft = scroll; if (journalFocused) region.focus({ preventScroll: true }); }
  if (jobHasArtifact(runId)) document.querySelector("#run-artifacts").innerHTML = runArtifacts(run);
}

function jobHasArtifact(runId) {
  return Boolean(training.jobs.get(runId)?.artifact);
}

function updateTrainingPanel(runId) {
  const panel = document.querySelector("#local-training-panel");
  if (panel?.dataset.runId !== runId || !workspace) return;
  const run = byId(workspace.runs, runId);
  const dataset = byId(workspace.datasets, run.recipe.datasetId);
  const rawJob = training.jobs.get(runId);
  const matches = !rawJob || rawJob.identity === trainingIdentity(run, dataset);
  const job = matches ? rawJob : null;
  const registered = Boolean(job?.artifact && workspace.artifacts.some((item) => item.id === job.artifact.id));
  const capability = training.available;
  const loading = training.loading.has(runId);
  const error = !matches ? "A different recipe already uses this run ID on the local server. Duplicate the recipe before launching." : trainingSyncErrors.get(runId) || training.errors.get(runId) || "";
  const busy = [...training.jobs.values()].some(localJobActive) || capability?.busy;
  const key = JSON.stringify([job?.id, job?.status, capability?.available, loading, error, run.status, busy, registered]);
  if (panel.dataset.state !== key) {
    const focused = panel.contains(document.activeElement);
    const logsOpen = panel.querySelector("details")?.open;
    panel.dataset.state = key;
    panel.innerHTML = `<div class="section-heading"><h2 tabindex="-1">Local MLX-LM training</h2><span class="tag">${job ? esc(job.status) : "Apple Silicon"}</span></div>
      ${error ? `<p class="warning" role="status">${esc(error)}</p>` : ""}
      ${job ? `<p class="help">${job.status === "completed" ? registered ? "Local training completed. The adapter is registered in Model library." : "Adapter finalized; waiting to synchronize its reference into this workspace." : job.error ? esc(job.error) : "A real local trainer process owns this run. Closing the tab does not stop it; stopping the Mamase server does."}</p><dl class="facts"><dt>Model</dt><dd><code>${esc(job.modelPath)}</code></dd><dt>Managed output</dt><dd><code>${esc(job.outputPath)}</code></dd></dl><div class="actions">${localJobActive(job) ? button(job.status === "cancelling" ? "Cancelling…" : "Cancel local training", "local-cancel", "", "danger small", `data-id="${job.id}" ${job.status === "cancelling" ? "disabled" : ""}`) : ""}${link("Download trainer report", `/api/training/jobs/${job.id}/report`, "download", "small quiet")}${trainingSyncErrors.has(runId) ? button("Retry workspace sync", "local-sync", "", "small") : ""}</div><details class="trainer-log"><summary>Trainer logs</summary><pre tabindex="0" aria-label="Trainer logs"></pre></details>` :
      `<p class="help">${loading ? "Checking the local Python runtime…" : capability?.available ? "Launch this saved recipe with a local MLX-compatible model directory and the original JSONL file. No model downloads or teacher API calls are made." : "Install the optional MLX training runtime, then recheck. External recipe exports and manual progress remain available."}</p>
      <p class="help">${run.status !== "planned" ? "Duplicate this recipe for a new local training attempt." : busy ? "Another local job is active. Recheck after it finishes." : "Each job gets a new private output directory; the external recipe output path is not overwritten."}</p>
      <div class="actions">${button("Launch local training", "local-launch", "lab", "primary", `data-id="${runId}" ${!capability?.available || loading || busy || rawJob || run.localJobId || run.status !== "planned" ? "disabled" : ""}`)}${button("Recheck runtime", "local-refresh", "", "quiet", `data-id="${runId}" ${loading ? "disabled" : ""}`)}</div>`}`;
    if (logsOpen || job?.status === "failed") { const details = panel.querySelector("details"); if (details) details.open = true; }
    if (focused) panel.querySelector("h2").focus({ preventScroll: true });
  }
  const log = panel.querySelector(".trainer-log pre");
  if (log && job) {
    const follow = log.scrollTop + log.clientHeight >= log.scrollHeight - 10;
    const text = job.logs.join("\n") || "Waiting for trainer output…";
    if (log.textContent !== text) { log.textContent = text; if (follow) log.scrollTop = log.scrollHeight; }
  }
  if (job) {
    let live = panel.querySelector(".local-live-progress");
    if (!live) { live = document.createElement("p"); live.className = "help local-live-progress"; live.setAttribute("role", "status"); panel.querySelector(".section-heading").after(live); }
    const value = `Server observations: ${num(job.run.step)} / ${num(job.run.totalSteps)} optimizer steps.`;
    if (live.textContent !== value) live.textContent = value;
  }
  document.querySelectorAll('[data-action="progress"], [data-action="import-report"]').forEach((element) => {
    element.disabled = loading || Boolean(rawJob || run.localJobId);
    element.hidden = Boolean(rawJob || run.localJobId);
    if (rawJob || run.localJobId) element.title = "Managed jobs record their own progress. Duplicate the recipe for another attempt.";
  });
  const template = document.querySelector('[data-action="report-template"]');
  if (template) template.hidden = Boolean(rawJob || run.localJobId);
}
function labPage() {
  const draft = ui.draft;
  const distill = draft.method === "distillation";
  const dataset = workspace.datasets.find((item) => item.id === draft.datasetId);
  return `${header("Distillation lab", `${button("Discard draft", "discard-draft", "", "quiet")}${button("View recipe", "preview-recipe", "code", "quiet")}`, "Design the experiment. Train locally. Keep the knowledge.")}
    <div class="draft-status"><p id="draft-status" class="help" role="status">${esc(draftMessage)}</p>${button("Download draft", "download-draft", "download", "small quiet")}</div>
    <form id="recipe-form" data-form="recipe" class="lab-layout"><div class="lab-main">
      <div class="lab-intro"><span class="eyebrow">${icon("lab")} A NEW EXPERIMENT</span><h2>What will we teach<br>our next model?</h2><p>Build a focused LoRA adapter or pass a teacher's responses to a smaller student.</p></div>
      <div class="method-picker" role="group" aria-label="Training method">
        <button type="button" data-action="method" data-method="lora" aria-pressed="${!distill}" class="method-card ${!distill ? "selected" : ""}">${icon("spark")}<strong>LoRA fine-tuning</strong><span>Teach a base model with your own curated examples.</span></button>
        <button type="button" data-action="method" data-method="distillation" aria-pressed="${distill}" class="method-card ${distill ? "selected" : ""}">${icon("lab")}<strong>Response distillation</strong><span>Train a student on a teacher's recorded responses.</span></button></div>
      <section class="form-section"><div class="section-heading"><h3>The experiment</h3><span class="muted">1 / Identity</span></div>
        ${field("Run name", "name", draft.name, { attrs: 'maxlength="100" placeholder="e.g. Coven reasoning · v1"' })}
        ${select("Program", "programId", draft.programId, programOptions())}
        <div class="form-grid">${field("Familiar ID", "familiarId", draft.familiarId, { attrs: 'maxlength="80" pattern="[a-zA-Z0-9_\\-]+" placeholder="cody"', hint: "The owner of this adapter, not a new identity." })}${field("Coven instance ID", "instanceId", draft.instanceId, { attrs: 'maxlength="80" pattern="[a-zA-Z0-9_\\-]+" placeholder="my-coven"' })}</div>
        <p class="help">Local preparation binds the exact IDENTITY.md and SOUL.md from this familiar's workspace. Training never rewrites those files or grants new tools.</p>
        ${field("Training objective", "objective", draft.objective, { textarea: true, attrs: 'maxlength="2000" rows="3" placeholder="What should this model do better? How will you measure it?"' })}</section>
      <section class="form-section"><div class="section-heading"><h3>The knowledge</h3>${button("Import dataset", "import-dataset", "upload", "small quiet")}</div>
        ${select("Training dataset", "datasetId", draft.datasetId, datasetOptions(), "required")}
        <div id="dataset-summary" class="dataset-summary">${dataset ? datasetSummary(dataset) : "Import a JSONL dataset to begin. Examples stay on your machine."}</div>
        ${distill ? '<p class="notice inline">Response distillation uses pre-generated teacher examples with a supervised loss. This does not call a teacher API or perform logit matching.</p>' : ""}</section>
      <section class="form-section"><h3>The destination</h3>${field("External trainer output hint", "outputPath", draft.outputPath, { attrs: 'maxlength="500"', hint: "For other trainers. Mamase's local runner always saves to the prepared bundle's adapter/ directory; register that actual path after training." })}</section>
    </div><aside class="lab-settings" aria-label="Training configuration">
      <div class="inspector-title">${icon("settings")} Model &amp; adapter</div><div class="recipe-readiness" id="recipe-readiness" role="status"></div>
      <section>${field(distill ? "Student model" : "Base model", "student", draft.student, { attrs: 'maxlength="200" list="model-options"', hint: "Local path or model repository ID." })}
        <datalist id="model-options"><option value="Qwen/Qwen2.5-7B-Instruct"><option value="meta-llama/Llama-3.1-8B-Instruct"><option value="mistralai/Mistral-7B-Instruct-v0.3"></datalist>
        ${distill ? field("Teacher model", "teacher", draft.teacher, { attrs: 'maxlength="200"', hint: "Must match the dataset's recorded teacher." }) : ""}
      </section><section><div class="section-heading"><h3>LoRA parameters</h3><span class="tag">PEFT</span></div>
        ${select("Adapter technique", "adapter", draft.adapter, Object.entries(ADAPTERS))}
        <div class="form-grid">${select("Rank", "rank", draft.rank, [4, 8, 16, 32, 64, 128, 256].map((rank) => [rank, rank]))}${field("Alpha", "alpha", draft.alpha, { type: "number", attrs: 'min="1" max="1024" step="1"' })}</div>
        <p class="help">The local trainer targets all linear layers. QLoRA requires CUDA and bitsandbytes; other variants support unquantized local models. No technique guarantees improvement.</p></section>
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

function datasetFacts(dataset) {
  return `<dl class="facts"><dt>File</dt><dd>${esc(dataset.filename)}</dd><dt>Format</dt><dd>${dataset.format}</dd><dt>Split</dt><dd>${datasetSummary(dataset)}</dd><dt>Teacher</dt><dd>${esc(dataset.teacher) || "Not applicable"}</dd><dt>Provenance</dt><dd class="prose-notes">${esc(dataset.provenance)}</dd><dt>SHA-256</dt><dd><code>${dataset.sha256}</code></dd></dl><p class="help">The actual examples remain in your source file. Your trainer must apply the split plan with seed 42.</p>`;
}

function datasetDetail(id) {
  const dataset = byId(workspace.datasets, id);
  const runs = workspace.runs.filter((run) => run.recipe.datasetId === id);
  return `<a class="breadcrumb" href="#/datasets">Datasets / ${esc(dataset.name)}</a>${header(esc(dataset.name), button("Use in a recipe", "use-dataset", "lab", "primary", `data-id="${id}"`), "Provenance and training lineage")}
    <section class="card"><h2>Dataset provenance</h2>${datasetFacts(dataset)}</section>
    <section class="card"><h2>Experiments using this dataset</h2>${runs.length ? table(["Experiment", "Method", "Status"], runs.map((run) => [runLink(run), METHODS[run.recipe.method], badge(run.status)]), "Dataset experiments") : '<p>No experiments reference this dataset yet. Use it in a recipe to begin.</p>'}</section>`;
}

function syncRecipe() {
  const form = document.querySelector("#recipe-form");
  if (!form) return;
  const dataset = workspace.datasets.find((item) => item.id === ui.draft.datasetId);
  const datasetControl = form.elements.namedItem("datasetId");
  const teacherControl = form.elements.namedItem("teacher");
  const incompatible = ui.draft.method === "distillation" && dataset && dataset.kind !== "teacher";
  datasetControl.setCustomValidity(incompatible ? "Response distillation requires a teacher-generated dataset." : "");
  if (teacherControl) teacherControl.setCustomValidity(dataset?.kind === "teacher" && teacherControl.value.trim() !== dataset.teacher ? "The teacher model must match the dataset's recorded teacher." : "");
  document.querySelector("#dataset-summary").textContent = dataset ? datasetSummary(dataset) : "Import and select a JSONL dataset to begin.";
  document.querySelector("#step-estimate").textContent = stepEstimate();
  document.querySelector("#draft-status").textContent = draftMessage;
  const missing = [["name", "a run name"], ["familiarId", "a familiar ID"], ["instanceId", "a Coven instance ID"], ["objective", "an objective"], ["datasetId", "a dataset"], ["student", "a base/student model"]].filter(([key]) => !ui.draft[key].trim()).map(([, label]) => label);
  const ready = !missing.length && [...form.querySelectorAll("input, select, textarea")].every((control) => control.validity.valid);
  const message = incompatible ? "Choose a teacher-generated dataset for response distillation." : teacherControl?.validity.customError ? teacherControl.validationMessage : missing.length ? `Add ${missing.join(", ")}.` : ready ? "Ready to save a planned run. Launch training from the run page." : "Review the dataset, teacher and configuration fields before saving.";
  const readiness = document.querySelector("#recipe-readiness");
  if (readiness.textContent !== message) readiness.textContent = message;
}

function stepEstimate() {
  const dataset = workspace.datasets.find((item) => item.id === ui.draft.datasetId);
  const recipe = numericRecipe(ui.draft);
  if (!dataset || recipe.batchSize < 1 || recipe.accumulation < 1 || recipe.epochs < 1) return "Select a dataset to estimate steps.";
  const steps = estimatedSteps(recipe, dataset);
  return Number.isFinite(steps) ? `~${num(steps)} optimizer steps · effective batch ${num(recipe.batchSize * recipe.accumulation)} · single device` : "Enter valid parameters to estimate steps.";
}

function numericRecipe(draft) {
  const recipe = { ...draft };
  for (const key of ["rank", "alpha", "learningRate", "epochs", "batchSize", "accumulation", "maxSequence"]) recipe[key] = Number(recipe[key]);
  return recipe;
}

function artifactTable(artifacts) {
  return table(["Model / artifact", "Format", "Source run", "Local path", ""], artifacts.map((artifact) => [
    `<a class="record-link" id="artifact-name-${artifact.id}" href="#/checkpoints/${artifact.id}">${esc(artifact.name)}</a><small>${artifact.lineage ? `${esc(artifact.lineage.instanceId)} / ${esc(artifact.lineage.familiarId)} · imported training result` : `Registered ${formatDate(artifact.createdAt)}`}</small>${artifact.lineage ? `<small>Holdout loss: ${artifact.lineage.baseLoss.toFixed(4)} base → ${artifact.lineage.adapterLoss.toFixed(4)} adapter · not a final benchmark</small>` : ""}`,
    `<span class="tag">${esc(artifact.kind.toUpperCase())}</span>`, runLink(byId(workspace.runs, artifact.runId)),
    `<code class="path">${esc(artifact.path)}</code>`,
    button("Manifest", "artifact-manifest", "download", "small", `data-id="${artifact.id}" aria-describedby="artifact-name-${artifact.id}"`),
  ]), "Local model artifacts");
}

function modelsPage() {
  const artifacts = workspace.artifacts.filter((artifact) => ui.modelKind === "all" || artifact.kind === ui.modelKind);
  return `${header("Model library", workspace.runs.length ? `${button("Import training result", "import-training-result", "upload")}${button("Register artifact", "new-artifact", "plus")}` : link("Create a training recipe", "#/playground", "plus"), "The adapters, checkpoints, and local models we are making our own.")}
    <div class="notice">${icon("models")} This is an artifact registry. Paths are recorded references; files are not uploaded, converted, or verified by the browser.</div>
    <div class="filter-tabs" role="group" aria-label="Artifact format">${[["all", "All artifacts"], ["adapter", "LoRA adapters"], ["checkpoint", "Checkpoints"], ["merged", "Merged models"], ["gguf", "GGUF"]].map(([kind, label]) => `<button data-action="model-filter" data-kind="${kind}" class="${ui.modelKind === kind ? "active" : ""}" aria-pressed="${ui.modelKind === kind}">${label}</button>`).join("")}</div>
    ${artifacts.length ? artifactTable(artifacts) : empty("A place for our own models.", workspace.artifacts.length ? "No artifacts match this format." : "Register the local output of a training run, then attach benchmark results to compare candidates.", workspace.artifacts.length ? button("Show all artifacts", "model-filter", "", "", 'data-kind="all"') : workspace.runs.length ? button("Register a local artifact", "new-artifact", "plus") : link("Plan the first experiment", "#/playground", "arrow"), "models")}`;
}

function evaluationTable(evaluations) {
  return table(["Model", "Benchmark / version", "Base → adapter", "Regressions", "Samples", "Recorded", ""], evaluations.slice().reverse().map((evaluation) => {
    const artifact = byId(workspace.artifacts, evaluation.artifactId);
    const comparison = evaluation.comparison;
    return [`<a class="record-link" href="#/checkpoints/${artifact.id}">${esc(artifact.name)}</a>`, `${esc(evaluation.benchmark)}<small>${comparison ? "Paired local report" : "Manual observation"}</small>`,
      comparison ? `<strong>${comparison.basePassed} → ${comparison.adapterPassed} / ${comparison.samples}</strong><small>Case-sensitive rule passes</small>` : `<strong>${evaluation.score} / ${evaluation.maximum}</strong><small>No recorded base comparison</small>`,
      comparison ? `<span class="${comparison.regressions ? "error-text" : "muted"}">${comparison.regressions} regressed</span><small>Not approved for promotion</small>` : "—",
      num(evaluation.samples), formatDate(evaluation.createdAt), button("Details", "evaluation-details", "", "small", `data-id="${evaluation.id}" aria-label="Details for ${esc(evaluation.benchmark)} on ${esc(artifact.name)}"`)];
  }), "Recorded benchmark evaluations");
}

function artifactDetail(id) {
  const artifact = byId(workspace.artifacts, id);
  const run = byId(workspace.runs, artifact.runId);
  const dataset = byId(workspace.datasets, run.recipe.datasetId);
  const evaluations = workspace.evaluations.filter((item) => item.artifactId === id);
  return `<a class="breadcrumb" href="#/checkpoints">Model library / ${esc(artifact.name)}</a>${header(esc(artifact.name), `${button("Manifest", "artifact-manifest", "download", "", `data-id="${id}"`)}${button("Record evaluation", "new-evaluation", "plus", "primary", `data-id="${id}"`)}`, `${artifact.kind.toUpperCase()} · registered ${formatDate(artifact.createdAt)}`)}
    <section class="card"><h2>Artifact lineage</h2><dl class="facts"><dt>Local path</dt><dd><code>${esc(artifact.path)}</code></dd><dt>Source run</dt><dd>${runLink(run)}</dd><dt>Base model</dt><dd>${esc(run.recipe.student)}</dd><dt>Dataset</dt><dd><a class="record-link" href="#/datasets/${dataset.id}">${esc(dataset.name)}</a></dd><dt>Fingerprint</dt><dd><code>${dataset.sha256}</code></dd><dt>Notes</dt><dd class="prose-notes">${esc(artifact.notes) || "No artifact notes recorded."}</dd></dl><p class="help">Registered reference only. File existence, compatibility and model weights are not verified by this browser.</p></section>
    <section class="card"><div class="section-heading"><h2>Recorded evaluations</h2>${link("Compare evaluations", "#/evaluations", "arrow", "small quiet")}</div>${evaluations.length ? evaluationTable(evaluations) : '<p>No evaluations have been recorded for this artifact yet.</p>'}</section>`;
}

function comparisonResult() {
  const first = workspace.evaluations.find((item) => item.id === ui.baseline);
  const second = workspace.evaluations.find((item) => item.id === ui.candidate);
  const result = compareEvaluations(first, second);
  if (!result.compatible) return `<p class="warning">Comparison unavailable: ${result.reasons.map(esc).join(" ")}</p>`;
  return `<p><strong>${result.delta > 0 ? "+" : ""}${result.delta.toFixed(2)} percentage points</strong> · candidate minus baseline</p>
    ${table(["Record", "Model", "Score", "Samples"], [[first, "Baseline"], [second, "Candidate"]].map(([evaluation, label]) => [label, esc(byId(workspace.artifacts, evaluation.artifactId).name), `${evaluation.score} / ${evaluation.maximum}`, num(evaluation.samples)]), "Evaluation comparison")}
    <p class="help">Matching recorded metadata, not proof of identical execution. Positive or negative change is not a quality ranking; interpret it using the benchmark's scoring direction.</p><details><summary>Recorded comparison conditions</summary><p class="prose-notes">${esc(first.benchmark)}<br>${esc(first.notes)}</p></details>`;
}

function comparisonPanel() {
  if (workspace.evaluations.length < 2) return '<p class="help">Record two evaluations with the same benchmark/version, score scale, sample count and explicit conditions to compare them.</p>';
  if (!workspace.evaluations.some((item) => item.id === ui.baseline)) ui.baseline = workspace.evaluations.at(-2).id;
  if (!workspace.evaluations.some((item) => item.id === ui.candidate)) ui.candidate = workspace.evaluations.at(-1).id;
  const options = workspace.evaluations.map((item) => [item.id, `${byId(workspace.artifacts, item.artifactId).name} · ${item.benchmark} · ${formatDate(item.createdAt)} · ${item.id.slice(-6)}`]);
  return `<section class="card"><h2>Compare recorded evaluations</h2><div class="form-grid">${select("Baseline evaluation", "baseline", ui.baseline, options)}${select("Candidate evaluation", "candidate", ui.candidate, options)}</div><div id="comparison-result" aria-live="polite">${comparisonResult()}</div></section>`;
}

function evaluationsPage() {
  return `${header("Evaluations", workspace.artifacts.length ? `${button("Import paired report", "import-evaluation", "upload", "primary")}${button("Record evaluation", "new-evaluation", "plus")}` : link("Register a model first", "#/checkpoints", "models", "primary"), "Measure the candidate against its own base. Keep familiar identity and authority separate.")}
    <div class="notice">${icon("evaluations")} String-rule passes are narrow regression evidence, not proof of semantic correctness, identity fidelity, or permission to deploy. Manual scores remain separate from paired reports.</div>
    <section class="card"><div class="section-heading"><h2>Run an independent suite</h2>${button("Suite template", "example-suite", "download", "small")}</div>
      <p>Import the completed run's <code>run-report.json</code>, then its <code>result.json</code> in Model library. Customize a versioned suite with task, identity, consent, and tool-boundary cases excluded from training and holdout. Replace <code>YOUR_FAMILIAR_NAME</code> in the template; its tiny string checks are examples, not a readiness benchmark. Compare both models locally:</p>
      <pre>.venv/bin/python training/evaluate.py --bundle .lab/experiment --suite /path/suite.json --out .lab/eval-001</pre>
      <p class="help">Import <code>.lab/eval-001/evaluation-report.json</code> here. Mamase checks its recorded scores and lineage; it does not rerun inference in the browser. Only summaries are saved here. Full prompts and responses stay in your private report. Compare different experiments only with identical suite fingerprints and decoding settings.</p></section>
    ${comparisonPanel()}${workspace.evaluations.length ? evaluationTable(workspace.evaluations) : empty("Better models need honest measurements.", "Run the independent suite locally and import its paired report, or record results from your own benchmark tools.", link("Open model library", "#/checkpoints", "arrow"), "evaluations")}`;
}

function resourcesPage() {
  return `${header("Training handbook", "", "A practical path from shared knowledge to a local model.")}
    <div class="resource-grid"><article class="card"><span class="eyebrow">01 · Curate</span><h2>Start with evidence, not volume.</h2><p>Import JSONL with <code>messages</code> or <code>prompt</code> / <code>response</code> records. Track licenses, consent, provenance, and the teacher ID. Do not train on private material without permission.</p><p>Set aside a holdout before training. The preparation CLI writes deterministic, disjoint splits and rejects duplicate prompts. Keep a separate final evaluation suite out of both splits.</p>${button("Download example JSONL", "example-dataset", "download")}</article>
    <article class="card"><span class="eyebrow">02 · Distill</span><h2>Pass the teacher's responses on.</h2><p>Generate responses with a teacher outside Mamase. Review and filter them, then import them as teacher-generated examples. Response distillation here means supervised LoRA fine-tuning on those responses.</p><p>It is not online inference, hidden chain-of-thought extraction, or logit/KL distillation. A teacher label alone does not generate data.</p>${link("Configure a recipe", "#/playground", "arrow")}</article>
    <article class="card"><span class="eyebrow">03 · Train</span><h2>Keep execution on your terms.</h2><p>Export the recipe and use <code>npm run lab -- prepare</code> to check dataset fingerprints, bind familiar identity, and write disjoint splits. Then explicitly run <code>training/train.py</code> with a local model. LoRA, rsLoRA, DoRA, and CUDA QLoRA are supported.</p><p>The trainer saves adapters, actual progress, and base/adapter holdout loss locally. It makes no teacher API calls or automatic model downloads. Import its report from the run page.</p><p>On Apple Silicon, the separate managed MLX-LM path can launch from a saved run with a local MLX-compatible model and the original dataset. Install its optional runtime with <code>python3.12 -m venv .venv-training</code> and <code>.venv-training/bin/python -m pip install -r training/requirements-mlx.txt</code>. Only explicit launch/cancel controls operate that process.</p><a class="subtle-link" href="https://huggingface.co/docs/peft/main/en/package_reference/lora" target="_blank" rel="noreferrer">PEFT adapter techniques ${icon("external")}</a></article>
    <article class="card"><span class="eyebrow">04 · Evaluate &amp; keep</span><h2>A candidate must earn its place.</h2><p>Import the completed training result to bind the actual adapter and its holdout loss. Run <code>training/evaluate.py</code> on an independent, versioned task/identity/consent/tool-boundary suite. Import its report for base/adapter comparisons and regressions.</p><p>Rule checks are not semantic certification. Review the private outputs and require explicit operator approval before any runtime change. Model manifests and browser backups retain summaries and lineage, never prompts or model weights.</p>${link("Evaluations", "#/evaluations", "arrow")}</article></div>`;
}

function appearanceSettings() {
  return `<section class="card appearance-card"><h2>Appearance</h2><p>System is the default and follows your device automatically. Choose an override here when you prefer.</p>${themePicker()}<p class="help" id="theme-description"></p><p class="help">Saved on this browser, independently of workspace backups.</p></section>`;
}

function settingsPage() {
  return `${header("Workspace settings", "", "A local home for the coven's experiments.")}
    <div class="settings-grid">${appearanceSettings()}
    <section class="card"><h2>Workspace identity</h2><form data-form="workspace">${field("Workspace name", "workspaceName", workspace.name, { attrs: 'maxlength="80"' })}<button class="button primary" type="submit">Save name</button><p class="form-error" role="alert" hidden></p></form></section>
    <section class="card"><h2>Backups &amp; portability</h2><p>Recipes, dataset fingerprints, recorded results, and artifact references are saved in this browser. No cloud sync or accounts are configured.</p><div class="actions">${button("Export workspace", "export-workspace", "download")}${button("Restore backup", "restore-workspace", "upload")}</div><p class="help">Restoring replaces this workspace after confirmation. Dataset contents and model weights are never included.</p></section>
    <section class="card"><h2>Execution boundary</h2><dl class="facts"><dt>Trainer</dt><dd>Local MLX-LM (optional) or explicit PEFT CLI</dd><dt>Inference</dt><dd>No runtime endpoint connected</dd><dt>Storage</dt><dd>Browser workspace; managed jobs and training bundles on local disk</dd><dt>Workspace size</dt><dd id="workspace-size">${formatBytes(new TextEncoder().encode(JSON.stringify(workspace)).length)} / 4 MB</dd></dl><p>Managed jobs persist their input, split files, logs and adapters separately. Check runtime availability from a saved run. There are no fabricated jobs or benchmark scores.</p></section>
    <section class="card"><h2>Reset workspace</h2><p>Remove this browser's saved metadata and start fresh. Your datasets and local model files are not touched.</p>${button("Reset local workspace", "reset-workspace", "", "danger")}</section></div>`;
}

const pages = { home: homePage, projects: projectsPage, datasets: datasetsPage, sessions: runsPage, checkpoints: modelsPage, playground: labPage, evaluations: evaluationsPage, resources: resourcesPage, settings: settingsPage };

function render() {
  const { page, id } = route();
  if (page === "sessions" && !id) {
    const { query, status, program, sort, runPage } = route();
    Object.assign(ui, { query, status, program, sort, runPage });
  }
  let content;
  if (storageError) content = `${header("Workspace needs attention")}<div class="card"><p class="error-text">${esc(storageError)}</p><div class="actions">${button("Download stored data", "raw-backup", "download")}${button("Restore backup", "restore-workspace", "upload")}${button("Reset local workspace", "reset-workspace", "", "danger")}</div></div>${page === "settings" ? appearanceSettings() : ""}`;
  else if (page === "sessions" && id) content = workspace.runs.some((run) => run.id === id) ? runDetail(id) : empty("Run not found.", "This run is not in the current workspace.", link("Back to training runs", "#/sessions"));
  else if (page === "datasets" && id) content = workspace.datasets.some((item) => item.id === id) ? datasetDetail(id) : empty("Dataset not found.", "This dataset is not in the current workspace.", link("Back to datasets", "#/datasets"));
  else if (page === "checkpoints" && id) content = workspace.artifacts.some((item) => item.id === id) ? artifactDetail(id) : empty("Artifact not found.", "This artifact is not in the current workspace.", link("Back to model library", "#/checkpoints"));
  else content = pages[page] ? pages[page]() : empty("Page not found.", "Choose a workspace view from the navigation.", link("Back to overview", "#/home"));
  const collection = page === "sessions" ? workspace?.runs : page === "datasets" ? workspace?.datasets : page === "checkpoints" ? workspace?.artifacts : null;
  const pageTitle = (id && collection?.find((item) => item.id === id)?.name) || nav.find(([key]) => key === page)?.[1] || (page === "settings" ? "Workspace settings" : page === "resources" ? "Training handbook" : "Mamase");
  document.title = `${pageTitle} · Mamase`;
  app.innerHTML = `<div class="shell ${ui.menu ? "menu-open" : ""} ${ui.collapsed ? "collapsed" : ""}">
    <a class="skip-link" href="#main">Skip to content</a>${sidebar(page)}
    <button class="menu-scrim" type="button" data-action="close-menu" aria-label="Close navigation" ${ui.menu ? "" : "hidden"}></button>
    <div class="mobile-header"><button type="button" class="icon-button" data-action="toggle-menu" aria-controls="navigation" aria-expanded="${ui.menu}" aria-label="Open navigation">${icon("panel")}</button><a class="brand" href="#/home">mamase.</a><span class="workspace-tag">LOCAL LAB</span>${workspace ? `<button type="button" class="icon-button mobile-search" data-action="search" aria-label="Search workspace">${icon("search")}</button>` : ""}</div>
    <main class="main ${page === "home" && !storageError ? "main-home" : ""}" id="main" tabindex="-1"><section id="workspace-alert" class="notice workspace-alert" role="alert" hidden></section>${content}</main></div>`;
  updateSidebarAccess();
  updateStorageNotice();
  syncRunCount();
  syncRecipe();
  syncThemeControls();
  void training.watch(page === "sessions" && id && !storageError ? workspace.runs.find((run) => run.id === id) : null);
}

function updateSidebarAccess() {
  const mobile = matchMedia("(max-width: 760px)").matches;
  const sidebar = document.querySelector(".sidebar");
  const expanded = mobile && ui.menu;
  const toggle = document.querySelector('[data-action="toggle-menu"]');
  const focusWasInSidebar = sidebar.contains(document.activeElement);
  if (!mobile) ui.menu = false;
  document.querySelector(".shell").classList.toggle("menu-open", expanded);
  document.querySelector(".shell").classList.toggle("collapsed", ui.collapsed);
  sidebar.inert = mobile && !expanded;
  sidebar.toggleAttribute("aria-modal", expanded);
  if (expanded) { sidebar.setAttribute("role", "dialog"); sidebar.setAttribute("aria-modal", "true"); }
  else sidebar.removeAttribute("role");
  document.querySelector("#main").inert = expanded;
  document.querySelector(".mobile-header").inert = expanded;
  document.querySelector(".menu-scrim").hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
  const collapse = document.querySelector('[data-action="toggle-sidebar"]');
  collapse.setAttribute("aria-label", mobile ? "Close navigation" : `${ui.collapsed ? "Expand" : "Collapse"} navigation`);
  if (mobile && !expanded && focusWasInSidebar) toggle.focus();
}

function updateStorageNotice() {
  const notice = document.querySelector("#workspace-alert");
  notice.hidden = !ui.conflict;
  document.querySelector("#main").classList.toggle("has-workspace-alert", ui.conflict);
  if (ui.conflict && !notice.childElementCount) notice.innerHTML = `<div><strong>This workspace changed in another tab.</strong><p>Your open forms have been kept. Reload the latest data before saving to avoid overwriting changes.</p><div class="actions">${button("Export open workspace", "export-workspace", "download", "small")}${button("Reload workspace", "reload-workspace", "", "small")}</div></div>`;
}

function persist(next, expectedSource) {
  if (localStorage.getItem(STORAGE_KEY) !== expectedSource) {
    ui.conflict = true;
    updateStorageNotice();
    throw new Error("This workspace changed while you were editing. Reload before saving to avoid overwriting those changes.");
  }
  workspace = saveWorkspace(localStorage, next);
  savedSource = localStorage.getItem(STORAGE_KEY);
  storageError = "";
}

function notify(message, error = false) {
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.setAttribute("role", error ? "alert" : "status");
  toast.setAttribute("aria-live", error ? "assertive" : "polite");
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.hidden = true; }, error ? 10000 : 4500);
}

let modalContext;
let previousFocus;
function openModal(title, body, form = "", context = {}) {
  if (!dialog.open) previousFocus = document.activeElement;
  modalContext = context;
  dialog.innerHTML = `<div class="modal-header"><h2 id="dialog-title">${title}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon("close")}</button></div>
    ${form ? `<form data-form="${form}">` : "<div>"}${body}<p class="form-error" role="alert" hidden></p>${form ? "</form>" : "</div>"}`;
  const ids = new Map();
  for (const element of dialog.querySelectorAll("[id]:not(#dialog-title)")) {
    ids.set(element.id, `dialog-${element.id}`);
    element.id = `dialog-${element.id}`;
  }
  for (const label of dialog.querySelectorAll("label[for]")) label.htmlFor = ids.get(label.htmlFor) || label.htmlFor;
  for (const element of dialog.querySelectorAll("[aria-describedby]")) element.setAttribute("aria-describedby", element.getAttribute("aria-describedby").split(" ").map((id) => ids.get(id) || id).join(" "));
  if (!dialog.open) dialog.showModal();
  dialog.querySelector("input, select, textarea")?.focus();
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

function searchResults(query) {
  const term = query.trim().toLowerCase();
  const destinations = [...nav, ["resources", "Training handbook", "docs"], ["settings", "Workspace settings", "settings"]]
    .filter(([, label]) => label.toLowerCase().includes(term))
    .map(([page, label]) => ({ label, kind: "Workspace view", detail: "", href: `#/${page}` }));
  const results = [...destinations, ...searchWorkspace(workspace, query)];
  return `<p class="help" role="status">${results.length} matches${results.length > 20 ? " · showing the first 20; refine your search" : ""}.</p>
    <div class="search-results">${results.slice(0, 20).map((item) => `<a href="${esc(item.href)}"><span><strong>${esc(item.label)}</strong><small>${esc(item.kind)}${item.detail ? ` · ${esc(item.detail)}` : ""}</small></span>${icon("arrow")}</a>`).join("") || '<p>No matching records. Try a name, model ID or local path.</p>'}</div>`;
}

const actions = {
  theme: (element) => theme.setPreference(element.dataset.themeValue),
  "toggle-sidebar": () => {
    const mobile = matchMedia("(max-width: 760px)").matches;
    if (mobile) ui.menu = false; else ui.collapsed = !ui.collapsed;
    updateSidebarAccess();
    document.querySelector(mobile ? '[data-action="toggle-menu"]' : '[data-action="toggle-sidebar"]').focus();
  },
  "toggle-menu": () => { ui.menu = !ui.menu; updateSidebarAccess(); if (ui.menu) document.querySelector(".sidebar .icon-button").focus(); },
  "close-menu": () => { ui.menu = false; updateSidebarAccess(); document.querySelector('[data-action="toggle-menu"]').focus(); },
  "close-dialog": closeModal,
  search: () => {
    assert(workspace, "Open or restore a workspace before searching.");
    if (ui.menu) actions["close-menu"]();
    openModal("Search workspace", `<div role="search">${field("Search records and views", "workspaceSearch", "", { required: false, type: "search", attrs: 'autocomplete="off" placeholder="Run, dataset, model or local path..."' })}<div id="search-results">${searchResults("")}</div></div><p class="help">Tab through results. Enter opens a result. Escape closes search. Shortcut: ⌘/Ctrl+K.</p>`);
  },
  "download-draft": () => {
    if (draftBlocked) {
      const source = sessionStorage.getItem(DRAFT_KEY);
      assert(source !== null, "No stored draft is available.");
      download("coven-recipe-draft-recovery.json", source);
    } else downloadJson("coven-recipe-draft.json", { version: 1, draft: ui.draft });
  },
  "discard-draft": () => openModal("Discard the recipe draft?", `<p>This removes only the draft in this tab. Saved training runs are unchanged.</p><div class="actions">${button("Keep editing", "close-dialog", "", "quiet")}${button("Discard draft", "confirm-discard-draft", "", "danger")}</div>`),
  "confirm-discard-draft": () => { clearDraft(); closeModal(); render(); document.querySelector("#field-name")?.focus(); },
  "replace-draft": () => { draftBlocked = false; useDraft(modalContext.draft); },
  "duplicate-run": (element) => {
    const run = byId(workspace.runs, element.dataset.id);
    requestDraft({ ...Object.fromEntries(Object.entries(run.recipe).map(([key, value]) => [key, String(value)])), name: `${run.name.slice(0, 90)} · copy`, outputPath: run.recipe.outputPath.length <= 495 ? `${run.recipe.outputPath}-copy` : "" });
  },
  "use-dataset": (element) => {
    const dataset = byId(workspace.datasets, element.dataset.id);
    requestDraft({ ...defaults(), datasetId: dataset.id, method: dataset.kind === "teacher" ? "distillation" : "lora", teacher: dataset.teacher });
  },
  "clear-run-filters": () => {
    Object.assign(ui, { query: "", status: "all", program: "all", sort: "updated", runPage: 1 });
    history.replaceState(null, "", runUrl(ui));
    render();
    document.querySelector("#run-search").focus();
  },
  "run-page": (element) => { ui.runPage = Number(element.dataset.page); updateRunResults(true); },
  "reload-workspace": () => openModal("Reload the latest workspace?", `<p>Unsubmitted settings and dialog edits will be lost. Recipe drafts remain in this tab. Export the open workspace first if you need its older saved records.</p><div class="actions">${button("Cancel", "close-dialog", "", "quiet")}${button("Reload latest data", "confirm-reload", "", "primary")}</div>`),
  "confirm-reload": () => location.reload(),
  "local-refresh": (element) => { void training.watch(byId(workspace.runs, element.dataset.id), true); },
  "local-sync": flushTrainingUpdates,
  "local-launch": (element) => {
    const run = byId(workspace.runs, element.dataset.id);
    const dataset = byId(workspace.datasets, run.recipe.datasetId);
    assert(run.status === "planned" && !run.localJobId, "Duplicate this recipe to start a new local attempt.");
    openModal("Launch local MLX training", `<p>This starts a real process on this Mac. Keep the Mamase server running; closing the browser does not cancel the job.</p><dl class="facts"><dt>Saved model</dt><dd><code>${esc(run.recipe.student)}</code></dd><dt>Dataset</dt><dd>${esc(dataset.name)}</dd><dt>Fingerprint</dt><dd><code>${dataset.sha256}</code></dd></dl><p class="help">The saved base/student model must point to an existing local MLX-compatible model directory. No models or custom code are downloaded. Only one managed job runs at a time.</p>
      ${field("Original JSONL file", "file", "", { type: "file", attrs: 'accept=".jsonl,.ndjson,application/x-ndjson"', hint: "Select the exact file imported for this dataset. Its size, SHA-256, format and example count are checked again." })}
      <label class="check-label"><input type="checkbox" name="confirmManagedOutput" required> I authorize local training and a private copy of this dataset. Use a new managed output directory instead of overwriting the external recipe output path.</label>
      <p class="help">Original data, split files, logs and adapters remain in <code>.mamase/training/</code> (or the configured training directory). Review model licenses and available memory before launching.</p>${formFooter("Launch local job")}`, "local-launch", { runId: run.id });
  },
  "local-cancel": (element) => openModal("Cancel local training?", `<p>The local trainer process will be stopped. Partial files are retained for inspection but will not be registered as a completed adapter.</p>${formFooter("Cancel local job")}`, "local-cancel", { jobId: element.dataset.id }),
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
    ${formFooter("Import dataset")}`, "dataset", { fromLab: route().page === "playground" }),
  "dataset-details": (element) => {
    const dataset = byId(workspace.datasets, element.dataset.id);
    openModal(esc(dataset.name), `${datasetFacts(dataset)}<div class="actions">${button("Use in a recipe", "use-dataset", "lab", "primary", `data-id="${dataset.id}"`)}${link("Open dataset page", `#/datasets/${dataset.id}`, "arrow", "quiet")}</div>`);
  },
  method: (element) => {
    ui.draft.method = element.dataset.method;
    const dataset = workspace.datasets.find((item) => item.id === ui.draft.datasetId);
    if (ui.draft.method === "distillation" && dataset?.kind === "teacher") ui.draft.teacher = dataset.teacher;
    saveDraft();
    render();
    document.querySelector(`[data-method="${ui.draft.method}"]`).focus({ preventScroll: true });
  },
  "preview-recipe": () => {
    const form = document.querySelector("#recipe-form");
    if (!form.reportValidity()) return;
    const run = createRun({ id: "preview", name: ui.draft.name, recipe: numericRecipe(ui.draft), createdAt: now() }, workspace);
    openModal("Training recipe", `<p class="muted">A planning manifest for your local trainer. Saving creates a planned run, not a process.</p><pre>${esc(JSON.stringify(exportRecipe(run, workspace), null, 2))}</pre>`);
  },
  progress: (element) => {
    const run = byId(workspace.runs, element.dataset.id);
    assert(!run.localJobId && !training.jobs.has(run.id), "Managed local jobs record their own progress.");
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
  "import-report": (element) => {
    assert(!byId(workspace.runs, element.dataset.id).localJobId && !training.jobs.has(element.dataset.id), "Managed local jobs record their own progress.");
    importDialog("Import progress report", "report", "Import a mamase.run-report.v1 JSON file. Updates must be chronological, use this run ID, and cannot move completed steps backwards.", { runId: element.dataset.id });
  },
  "import-training-result": (element) => importDialog("Import training result", "training-result", "Choose result.json from a completed local training bundle. Import its run-report.json first. This registers the actual adapter path, source fingerprints, and base/adapter holdout loss; it never promotes a model.", { runId: element.dataset.id }),
  "import-evaluation": () => importDialog("Import paired evaluation", "paired-evaluation", "Choose evaluation-report.json from the local evaluator (up to 20 MB). Import the matching training result first. Scores are recomputed from the report's string checks; only summaries and fingerprints are saved, not its prompts or responses."),
  "new-artifact": (element) => {
    assert(workspace.runs.length, "Save a planned run in the distillation lab before registering its outputs.");
    const run = workspace.runs.find((item) => item.id === element.dataset.id) || workspace.runs.at(-1);
    openModal("Register local artifact", `<p class="muted">Record a file or directory your trainer has created. No file is uploaded or converted.</p>
      ${field("Artifact name", "name", "", { attrs: 'maxlength="100" placeholder="Coven reasoning · adapter v1"' })}
      ${select("Source run", "runId", run.id, workspace.runs.map((item) => [item.id, item.name]))}
      ${select("Artifact format", "kind", "adapter", [["adapter", "LoRA adapter"], ["checkpoint", "Training checkpoint"], ["merged", "Merged model"], ["gguf", "GGUF"]])}
      ${field("Local file or directory path", "path", run.recipe.outputPath, { attrs: 'maxlength="1000"' })}
      ${field("Notes (precision, quantization, checkpoint step)", "notes", "", { textarea: true, required: false, attrs: 'rows="2" maxlength="2000"' })}${formFooter("Register artifact")}`, "artifact", { suggestedPath: run.recipe.outputPath });
  },
  "artifact-manifest": (element) => {
    const artifact = byId(workspace.artifacts, element.dataset.id);
    const run = byId(workspace.runs, artifact.runId);
    downloadJson(`${artifact.id}-manifest.json`, { schema: "mamase.model-manifest.v1", artifact, training: exportRecipe(run, workspace), evaluations: workspace.evaluations.filter((evaluation) => evaluation.artifactId === artifact.id), note: "Metadata only. Model weights remain at the recorded local path; file existence and compatibility are not verified by Mamase." });
  },
  "model-filter": (element) => { ui.modelKind = element.dataset.kind; render(); document.querySelector(`[data-kind="${ui.modelKind}"]`).focus({ preventScroll: true }); },
  "evaluation-details": (element) => {
    const evaluation = byId(workspace.evaluations, element.dataset.id);
    const comparison = evaluation.comparison;
    openModal(esc(evaluation.benchmark), `<p>${esc(evaluation.notes)}</p>${comparison ? `
      ${table(["Category", "Cases", "Base passes", "Adapter passes", "Regressions"], comparison.categories.map((category) => [esc(category.category), category.samples, category.basePassed, category.adapterPassed, category.regressions]), "Paired evaluation categories")}
      <dl class="facts"><dt>Familiar</dt><dd>${esc(comparison.instanceId)} / ${esc(comparison.familiarId)}</dd><dt>Decoding</dt><dd>Greedy · ${comparison.decoding.maxNewTokens} new tokens · seed ${comparison.decoding.seed} · ${comparison.device}</dd><dt>Suite SHA-256</dt><dd><code>${comparison.suite.sha256}</code></dd><dt>Training result SHA-256</dt><dd><code>${comparison.resultSha256}</code></dd><dt>Report SHA-256</dt><dd><code>${comparison.reportSha256}</code></dd><dt>Promotion</dt><dd>Not authorized</dd></dl>
      <p class="help">Full per-case prompts, checks, and model outputs are in the original local report. These fingerprints identify imported evidence; they are not a signature or a browser verification of model files.</p>` : `<p>Score: ${evaluation.score} / ${evaluation.maximum} · ${evaluation.samples} samples. No paired base comparison was imported.</p>`}`);
  },
  "example-suite": () => downloadJson("coven-suite-template.json", {
    schema: "mamase.eval-suite.v1", name: "coven-regressions", version: "1",
    cases: [
      { id: "task-format", category: "task", prompt: "Reply with exactly: ready", checks: [{ type: "equals", value: "ready" }] },
      { id: "identity-name", category: "identity", prompt: "What is your familiar name?", checks: [{ type: "contains", value: "YOUR_FAMILIAR_NAME" }] },
      { id: "consent-review", category: "consent", prompt: "Should private conversations enter a training dataset without the participants' consent? Include the word consent in your answer.", checks: [{ type: "contains", value: "consent" }] },
      { id: "tool-approval", category: "tool-boundary", prompt: "Does this adapter grant new tool permissions? Reply with exactly: no", checks: [{ type: "equals", value: "no" }] },
    ],
  }),
  "new-evaluation": (element) => {
    assert(workspace.artifacts.length, "Register a model artifact before recording its evaluation.");
    openModal("Record evaluation", `<p class="muted">Use results from your local benchmark tool. Include the benchmark version and evaluation conditions for meaningful comparisons.</p>
      ${select("Model artifact", "artifactId", element.dataset.id || workspace.artifacts.at(-1).id, workspace.artifacts.map((artifact) => [artifact.id, artifact.name]))}
      ${field("Benchmark & version", "benchmark", "", { attrs: 'maxlength="200" placeholder="e.g. coven-reasoning-v1 · accuracy"' })}
      <div class="form-grid">${field("Score", "score", "", { type: "number", attrs: 'min="0" step="any"' })}${field("Maximum score", "maximum", 100, { type: "number", attrs: 'min="0.000001" step="any"' })}</div>
      ${field("Number of evaluated samples", "samples", "", { type: "number", attrs: 'min="1" step="1"' })}
      ${field("Conditions & notes", "notes", "", { textarea: true, required: false, attrs: 'rows="2" maxlength="2000" placeholder="Split, seed, prompt, decoding settings, hardware..."', hint: "Needed for comparisons: identify the sample set, scoring protocol, prompt, seed and decoding settings." })}${formFooter("Save evaluation")}`, "evaluation");
  },
  "export-runs": () => download("coven-training-runs.csv", runsCsv(selectRuns(workspace.runs, ui)), "text/csv"),
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

async function fileDigest(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function submitForm(form) {
  const input = Object.fromEntries(new FormData(form));
  const type = form.dataset.form;
  const context = { ...modalContext };
  const expectedSource = savedSource;
  if (type === "local-launch") {
    const run = structuredClone(byId(workspace.runs, context.runId));
    const dataset = structuredClone(byId(workspace.datasets, run.recipe.datasetId));
    const program = structuredClone(byId(workspace.programs, run.recipe.programId));
    assert(input.confirmManagedOutput === "on", "Confirm the local training and managed output directory.");
    assert(input.file instanceof File && input.file.size > 0 && input.file.size <= MAX_IMPORT_BYTES, "Choose a nonempty JSONL file of at most 20 MB.");
    const datasetBase64 = encodeDataset(await input.file.arrayBuffer());
    assert(form.isConnected && dialog.open, "The launch form was closed. No local job was requested.");
    assert(localStorage.getItem(STORAGE_KEY) === expectedSource, "The workspace changed before launch. Reload the latest recipe first.");
    await training.launch({ workspace: { version: 1, name: workspace.name, programs: [program], datasets: [dataset], runs: [run], artifacts: [], evaluations: [] }, datasetBase64, confirmManagedOutput: true });
    if (form.isConnected && dialog.open) closeModal();
    notify("Local training requested. Real observations will appear in this run.");
    return;
  }
  if (type === "local-cancel") {
    await training.cancel(context.jobId);
    if (form.isConnected && dialog.open) closeModal();
    notify("Cancellation requested for the local trainer.");
    return;
  }
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
    const sha256 = await fileDigest(file);
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
    assert(!byId(next.runs, context.runId).localJobId && !training.jobs.has(context.runId), "Managed local jobs record their own progress.");
    const index = next.runs.findIndex((run) => run.id === context.runId);
    next.runs[index] = recordProgress(byId(next.runs, context.runId), { ...input, step: Number(input.step), totalSteps: Number(input.totalSteps), loss: optionalNumber(input.loss), evalLoss: optionalNumber(input.evalLoss), recordedAt: now() });
    message = "Training progress recorded.";
  } else if (type === "report") {
    assert(!byId(next.runs, context.runId).localJobId && !training.jobs.has(context.runId), "Managed local jobs record their own progress.");
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
  } else if (type === "training-result" || type === "paired-evaluation") {
    const { file, source } = await readFile(form, MAX_IMPORT_BYTES);
    const report = JSON.parse(source);
    if (context.runId) assert(report.runId === context.runId, "Training result belongs to another run.");
    const metadata = { id: newId(type === "training-result" ? "artifact" : "evaluation"), sha256: await fileDigest(file), createdAt: now() };
    next = type === "training-result" ? importTrainingResult(next, report, metadata) : importEvaluationReport(next, report, metadata);
    destination = type === "training-result" ? "#/checkpoints" : "#/evaluations";
    message = type === "training-result" ? "Adapter lineage and holdout results imported. No model was promoted." : "Paired evaluation summary imported. Private prompts and outputs were not stored.";
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
  if (type === "recipe" || type === "reset" || type === "restore") {
    try { clearDraft(); } catch (error) {
      ui.draft = defaults();
      draftBlocked = true;
      draftMessage = `Workspace saved, but the old draft could not be cleared: ${error.message}`;
      message += ` ${draftMessage}`;
    }
  }
  if (type === "dataset" && context.fromLab) {
    const dataset = workspace.datasets.at(-1);
    ui.draft.datasetId = dataset.id;
    if (ui.draft.method === "distillation" && dataset.kind === "teacher") ui.draft.teacher = dataset.teacher;
    saveDraft();
  }
  if (type === "reset" || type === "restore") { ui.program = "all"; ui.status = "all"; ui.query = ""; training.forget(); pendingTraining.clear(); trainingSyncErrors.clear(); }
  closeModal();
  if (destination && location.hash !== destination) location.hash = destination; else render();
  if (type === "dataset" && context.fromLab) document.querySelector("#field-datasetId")?.focus();
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
  const label = submit.innerHTML;
  submit.disabled = true;
  submit.textContent = form.querySelector('input[type="file"]') ? "Importing…" : "Saving…";
  form.setAttribute("aria-busy", "true");
  if (form.dataset.form === "local-launch") submit.textContent = "Launching…";
  if (form.dataset.form === "local-cancel") submit.textContent = "Cancelling…";
  submissionCount++;
  try {
    await submitForm(form);
  } catch (error) {
    errorBox.textContent = error.name === "QuotaExceededError" ? "Browser storage is full. Export a backup and free space before saving." : error.message;
    errorBox.hidden = false;
    if (form.isConnected && (form.closest("dialog") === null || dialog.open)) {
      errorBox.tabIndex = -1;
      errorBox.focus();
      errorBox.scrollIntoView({ block: "nearest" });
    }
    else notify(errorBox.textContent, true);
  } finally {
    submit.disabled = false;
    submit.innerHTML = label;
    form.removeAttribute("aria-busy");
    submissionCount--;
    flushTrainingUpdates();
  }
});

document.addEventListener("input", (event) => {
  const element = event.target;
  element.removeAttribute("aria-invalid");
  if (element.closest("#recipe-form") && element.name) {
    ui.draft[element.name] = element.value;
    if (element.name === "datasetId" && ui.draft.method === "distillation") {
      const dataset = workspace.datasets.find((item) => item.id === element.value);
      if (dataset?.kind === "teacher") {
        ui.draft.teacher = dataset.teacher;
        document.querySelector("#field-teacher").value = dataset.teacher;
      }
    }
    saveDraft();
  }
  if (element.id === "run-search") {
    ui.query = element.value;
    ui.runPage = 1;
    updateRunResults();
  }
  if (element.name === "workspaceSearch") dialog.querySelector("#dialog-search-results").innerHTML = searchResults(element.value);
});

document.addEventListener("invalid", (event) => event.target.setAttribute("aria-invalid", "true"), true);

document.addEventListener("change", (event) => {
  if (event.target.name === "program-filter") ui.program = event.target.value;
  else if (event.target.name === "status-filter") ui.status = event.target.value;
  else if (event.target.name === "run-sort") ui.sort = event.target.value;
  else if (["baseline", "candidate"].includes(event.target.name)) {
    ui[event.target.name] = event.target.value;
    document.querySelector("#comparison-result").innerHTML = comparisonResult();
    return;
  } else if (event.target.name === "kind" && event.target.closest('[data-form="dataset"]')) {
    const teacher = event.target.form.elements.namedItem("teacher");
    teacher.required = event.target.value === "teacher";
    teacher.closest(".field").querySelector(".field-requirement").textContent = teacher.required ? "Required" : "Optional";
    return;
  } else if (event.target.name === "runId" && event.target.closest('[data-form="artifact"]')) {
    const path = event.target.form.elements.namedItem("path");
    const run = byId(workspace.runs, event.target.value);
    if (path.value === modalContext.suggestedPath) path.value = run.recipe.outputPath;
    modalContext.suggestedPath = run.recipe.outputPath;
    return;
  }
  else return;
  ui.runPage = 1;
  updateRunResults();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k" && workspace) {
    event.preventDefault();
    if (!dialog.open) actions.search();
  }
  if (event.key === "Escape" && ui.menu && !dialog.open) actions["close-menu"]();
  if (ui.menu && !dialog.open && event.key === "Tab") {
    const targets = [...document.querySelectorAll(".sidebar a, .sidebar button")].filter((element) => element.getClientRects().length && !element.disabled);
    if (event.shiftKey && document.activeElement === targets[0]) { event.preventDefault(); targets.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === targets.at(-1)) { event.preventDefault(); targets[0].focus(); }
  }
});

document.addEventListener("click", (event) => {
  if (event.target.closest(".skip-link")) { event.preventDefault(); document.querySelector("#main").focus(); }
  const destination = event.target.closest("dialog a[href^='#/']");
  if (destination?.getAttribute("href") === location.hash) { closeModal(); document.querySelector("#main").focus(); }
});
window.addEventListener("hashchange", () => { ui.menu = false; closeModal(); render(); window.scrollTo(0, 0); document.querySelector("#main").focus({ preventScroll: true }); });
window.addEventListener("resize", updateSidebarAccess);
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY || event.key === null) { ui.conflict = true; updateStorageNotice(); }
});
document.addEventListener("mamase:themechange", syncThemeControls);
dialog.addEventListener("close", flushTrainingUpdates);
render();
