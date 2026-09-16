import {
  STORAGE_KEY, METHODS, ADAPTERS, STATUSES, MAX_IMPORT_BYTES, MAX_WORKSPACE_BYTES, assert,
  createWorkspace, loadWorkspace, saveWorkspace, parseDataset,
  validateDataset, splitCounts, createRun, recordProgress, validateArtifact,
  validateEvaluation, exportRecipe, escapeHtml as esc, runsCsv, estimatedSteps,
  importTrainingResult, importEvaluationReport, previewProgressReport, importProgressReport,
} from "./workspace.js";
import { icon, button, link, field, select, badge, empty, table, formatDate, formatBytes, progress, lossChart } from "./ui.js";
import { DRAFT_KEY, RUN_PAGE_SIZE, parseRoute, runUrl, selectRuns, searchWorkspace, compareEvaluations, readRecipeDraft } from "./experience.js";
import { TrainingClient, encodeDataset, localJobActive } from "./training-client.js";
import { mergeTrainingJob, trainingIdentity, managedRecipeIssue } from "./training-state.js";
import { trainingWorkflow, runGuidance, formatLoss, lossReading, modelName } from "./training-guide.js";
import { MAX_BACKUP_BYTES, exportWorkspaceBackup, parseWorkspaceBackup } from "./backups.js";
import { AuthClient } from "./auth-client.js";
import { accessPhase, accessGateView, GATE_TITLES } from "./access-gate.js";
import { syntheticSuiteTemplate, suiteAssessment } from "./evaluation-suites.js";
import { readReviewFile, prepareReview, recordHumanDecision } from "./human-review.js";
import { suiteFacts, decisionHistory, reviewBody, reviewAnnotations } from "./review-view.js";
import { familiarContextLabel } from "./context-summary.js";
import { ModelPlayground } from "./playground.js";
import { handbookModel, HANDBOOK_BOUNDARY } from "./handbook.js";
import { agentPrompt, handoffFilename } from "./agent-handoff.js";

const app = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const toast = document.querySelector("#toast");
const theme = window.mamaseTheme;
const hosted = document.querySelector('meta[name="mamase-runtime"]')?.content === "hosted";
const account = new AuthClient({ onChange: accountChanged });
const pendingTraining = new Map();
const trainingSyncErrors = new Map();
let submissionCount = 0;
let trainingFlushTimer;
const training = new TrainingClient({ onJob: receiveTrainingJob, onStatus: updateTrainingPanel });
const modelPlayground = new ModelPlayground({ hosted, notify: (...args) => notify(...args), download: (...args) => downloadJson(...args) });
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
  student: "", teacher: "", rank: "16", alpha: "32",
  learningRate: "0.0002", epochs: "3", batchSize: "1", accumulation: "4",
  maxSequence: "2048", outputPath: "./outputs/coven-adapter", objective: "",
  adapter: "lora", familiarId: "", instanceId: "", workflow: "managed",
});
const ui = { menu: false, collapsed: false, draft: defaults(), query: "", status: "all", program: "all", sort: "updated", runPage: 1, modelKind: "all", conflict: false, handbookRun: "" };
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
  ["sessions", "Training runs", "runs"], ["checkpoints", "Model library", "models"], ["testing", "Playground", "chat"], ["playground", "Distillation lab", "lab"],
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
    <div class="brand-row"><a class="brand" href="#/home" aria-label="Mamasé overview">mamasé<span class="brand-dot">.</span></a>
      <button class="icon-button" type="button" data-action="toggle-sidebar" aria-label="${ui.collapsed ? "Expand" : "Collapse"} navigation">${icon("panel")}</button></div>
    <div class="workspace-label"><span class="tiny-mark">${icon("spark")}</span><span class="workspace-identity"><small class="workspace-tag">${hosted ? "HOSTED" : "LOCAL"}</small><span class="workspace-name" title="${esc(workspace?.name || "The Coven")}">${esc(workspace?.name || "The Coven")}</span></span>
      ${workspace ? `<button type="button" class="icon-button workspace-search-button" data-action="search" aria-label="Search workspace" title="Search workspace (Ctrl K)">${icon("search")}</button>` : ""}</div>
    <nav>${links.map(([id, label, glyph], index) => `${[0, 2, nav.length].includes(index) ? `<div class="nav-section">${index === 0 ? "Workspace" : index === 2 ? "Model development" : "Resources"}</div>` : ""}<a href="#/${id}" class="nav-link ${page === id ? "active" : ""}" ${page === id ? 'aria-current="page"' : ""} aria-label="${label}" title="${label}">${icon(glyph)}<span>${label}</span>${id === "sessions" && workspace?.runs.length ? `<span class="nav-count">${workspace.runs.length}</span>` : ""}</a>`).join("")}</nav>
    <div class="sidebar-bottom"><div class="local-status"><span class="status-dot"></span><span>${hosted ? "Saved in this browser" : "Local workspace"}</span></div>
      <p>Knowledge stays in the coven.</p>
      <a class="profile" id="account-profile" href="#/settings" aria-label="Account settings">${accountProfile()}</a></div>
  </aside>`;
}

function accountName() {
  return account.state.user ? [account.state.user.firstName, account.state.user.lastName].filter(Boolean).join(" ") || account.state.user.email : "Account settings";
}

function accountProfile() {
  const name = accountName();
  return `<span class="avatar">${esc(account.state.user ? name.slice(0, 1).toUpperCase() : "C")}</span><span><strong>${esc(name)}</strong><small>${account.state.phase === "signed-in" ? "Signed in with WorkOS" : account.state.phase === "signed-out" ? "Sign in to your account" : account.state.phase === "loading" ? "Checking sign-in" : "Offline workspace available"}</small></span>${icon("settings")}`;
}

function accountContent() {
  const { phase, user, message } = account.state;
  let content = '<p class="help">Checking sign-in...</p>';
  if (phase === "signed-in") content = `<div class="account-identity"><span class="avatar">${esc(accountName().slice(0, 1).toUpperCase())}</span><div><strong>${esc(accountName())}</strong><p>${esc(user.email)}</p></div></div><div class="actions">${button(account.busy ? "Signing out..." : "Sign out", "sign-out", "", "quiet", account.busy ? "disabled" : "")}</div>`;
  else if (phase === "signed-out") content = `<p>Continue to WorkOS AuthKit to choose GitHub, Google, or another sign-in method enabled for the coven.</p><div class="actions">${button("Sign in", "sign-in", "arrow", "primary")}</div>`;
  else if (phase === "unconfigured") content = `<p>${esc(message || "Sign-in is not configured for this deployment.")}</p><p class="help">The deployment owner needs to connect a WorkOS project. You can keep using this workspace offline.</p>`;
  else if (phase === "error") content = `<p class="error-text" role="status">${esc(message)}</p><div class="actions">${button("Retry account connection", "auth-refresh", "arrow", "quiet")}</div>`;
  return `<h2>Account</h2>${content}<p class="help account-boundary">Sign-in identifies you; it does not sync or isolate this browser's workspace by account. Signing out does not erase records or stop local training. Use a separate browser profile on a shared device.</p>`;
}

function accountSettings() {
  return `<section class="card account-card" id="account-panel" data-phase="${account.state.phase}" aria-live="polite">${accountContent()}</section>`;
}

function renderAccessGate(phase) {
  modelPlayground.deactivate();
  training.forget();
  delete app.dataset.viewKey;
  document.title = `${GATE_TITLES[phase] || "Access"} · Mamasé`;
  app.innerHTML = accessGateView(phase, account.state, { busy: account.busy });
}

const GATE_ACTIONS = new Set(["sign-in", "sign-out", "auth-refresh"]);
const gated = () => accessPhase(account.state) !== "open";

function accountChanged() {
  const gate = accessPhase(account.state);
  if (gate !== "open" || app.querySelector(".gate-shell")) { render(); return; }
  syncAccountControls();
}

function syncAccountControls() {
  const panel = document.querySelector("#account-panel");
  const focusedAction = panel?.contains(document.activeElement) ? document.activeElement.dataset.action : null;
  if (panel) { panel.dataset.phase = account.state.phase; panel.innerHTML = accountContent(); }
  const profile = document.querySelector("#account-profile");
  if (profile) profile.innerHTML = accountProfile();
  if (focusedAction) panel.querySelector(`[data-action="${CSS.escape(focusedAction)}"]`)?.focus({ preventScroll: true });
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
    <section class="home-stage"><span class="frame-corners" aria-hidden="true"></span><div class="home-copy"><p class="home-kicker" title="${esc(workspace.name)}">${esc(workspace.name)} / Distillation lab</p>
      <h1>What will we train next?</h1>
      <p class="home-intro">Recipes, real observations, and models shaped for the coven.</p>
      <div class="actions">${link(hasDataset ? "Open the lab" : "Import a dataset", hasDataset ? "#/playground" : "#/datasets", hasDataset ? "lab" : "upload", "primary")}${link("The workflow", "#/resources", "arrow", "quiet")}</div>
      </div></section>
    <section class="card home-workflow"><div class="section-heading"><h2>${icon("lab")} Training workflow</h2><span class="eyebrow">${hosted ? "Hosted planning workspace" : "Local training workspace"}</span></div>
      <ol class="workflow"><li><span>1</span><div><a href="#/datasets">Curate the knowledge</a><p>Bring your examples or a teacher's responses.</p></div></li>
      <li><span>2</span><div><a href="#/playground">Save a recipe, then train</a><p>Choose a workflow. Saving alone starts nothing.</p></div></li>
      <li><span>3</span><div><a href="#/checkpoints">Review the saved output</a><p>Test fresh examples before choosing an adapter.</p></div></li></ol>
    </section>
    <section class="metrics overview-metrics" aria-label="Workspace progress">
      ${metric("Training runs", num(workspace.runs.length), `${active} active · ${completed} completed`, "runs", "#/sessions")}
      ${metric("Curated examples", num(workspace.datasets.reduce((sum, dataset) => sum + dataset.records, 0)), `Across ${workspace.datasets.length} datasets`, "datasets", "#/datasets")}
      ${metric("Model artifacts", num(workspace.artifacts.length), "Registered local paths", "models", "#/checkpoints")}
      ${metric("Evaluations", num(workspace.evaluations.length), "Recorded benchmark results", "evaluations", "#/evaluations")}
    </section>
    <section class="home-grid"><article class="home-panel activity-panel"><div class="section-heading"><h2>${icon("runs")} Recent experiments</h2><a href="#/sessions" class="subtle-link">View all ${icon("arrow")}</a></div>
      ${workspace.runs.length ? `<div class="recent-list">${workspace.runs.slice(-6).reverse().map((run) => `<a class="recent-run" data-status="${esc(run.status)}" href="#/sessions/${run.id}"><span class="item-icon">${icon(run.recipe.method === "lora" ? "spark" : "lab")}</span><div><strong>${esc(run.name)}</strong><small>${METHODS[run.recipe.method]} · ${esc(run.recipe.student.split("/").at(-1))}</small></div>${badge(run.status)}</a>`).join("")}</div>` : empty("No training runs yet", hasDataset ? "Your dataset is ready. Save a recipe to plan your first run." : "Import a dataset, then save your first training recipe.", link(hasDataset ? "Create a training recipe" : "Add training examples", hasDataset ? "#/playground" : "#/datasets", "plus"), "runs", true)}
    </article></section>
    <div class="local-note">${icon("local")} ${hosted ? "Hosted workspace: planning and records only. Export recipes to your local Mamase app to train. Browser storage is separate on each address." : "Launch local MLX jobs from saved runs, or record results from external trainers. Only real observations are tracked."}</div>
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
    <div class="notice">${icon("local")} Keep the original JSONL file. This import saves its description and fingerprint, not the examples. You will choose the file again before managed training makes a private local copy.</div>
    <p class="help">“Holdout” means examples kept out of training, used to check how the model handles unseen data.</p>
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
  const workflow = trainingWorkflow(run);
  const manual = workflow === "cli" && !run.localJobId;
  return `<a class="breadcrumb" href="#/sessions">Training runs / <span>${esc(run.name)}</span></a>
    ${header(esc(run.name), button("Duplicate recipe", "duplicate-run", "plus", "quiet", `data-id="${run.id}"`), `${workflow === "managed" ? "Local Mac training" : "Terminal workflow"} · ${esc(modelName(run.recipe.student))}`)}
    <div id="run-journey"></div>
    <section class="card local-training-panel run-control" id="local-training-panel" data-run-id="${run.id}" aria-label="Training status"><h2>Loading this run…</h2></section>
    <section class="card run-output" id="run-output-section" ${workspace.artifacts.some((item) => item.runId === id) ? "" : "hidden"}><h2>Saved output</h2><div id="run-artifacts">${runArtifacts(run)}</div></section>
    <section id="run-measurements" aria-label="Training measurements" ${latest || validation ? "" : "hidden"}>
      <div class="metrics three run-metrics">${metric("Learning updates", `<span id="run-step-value">${num(run.step)} / ${num(run.totalSteps)}</span>`, "One update adjusts the adapter's weights.", "runs")}${metric("Training loss", `<span id="run-loss-value">${formatLoss(latest?.loss)}</span>`, "Fit to the examples the model learns from.", "evaluations")}${metric("Holdout loss", `<span id="run-validation-value">${formatLoss(validation?.evalLoss)}</span>`, "Fit to examples kept out of training.", "datasets")}</div>
      <div class="detail-grid run-insight-grid"><section class="card chart-card"><h2>How the measurements are changing</h2><div id="run-loss-chart">${lossChart(run)}</div></section>
      <aside class="card loss-explainer"><span class="eyebrow">HOW TO READ THIS</span><h2>Loss is a fit measurement, not a score.</h2><p>Lower loss means the model more closely matches the recorded answers. It does not mean “percent correct.”</p><p id="run-loss-reading">${lossReading(run.history)}</p><p class="help">Compare holdout readings within this run. Different datasets and training workflows are not directly comparable.</p></aside></div>
    </section>
    <section class="card" id="external-training-guide" ${manual ? "" : "hidden"}><h2>Run this recipe in your terminal</h2>
      <ol class="next-steps"><li><strong>Export the recipe.</strong> Keep the original dataset and the familiar's workspace available.</li><li><strong>Prepare, preflight, then train.</strong> Preparation binds the familiar's identity and writes the split. Preflight checks readiness without loading weights; neither step starts training.</li><li><strong>Bring back the results.</strong> Import <code>run-report.json</code> for progress, then <code>result.json</code> for the adapter and holdout comparison.</li></ol>
      ${run.status === "planned" || closed ? `<div class="actions">${button("Import report", "import-report", "upload", "small", `data-id="${run.id}"`)}<span class="help">${closed ? "Recheck a report without rewriting closed history." : "Already ran the trainer? Import its progress here."}</span></div>` : ""}
      <details class="disclosure"><summary>Terminal commands <span>Requires the separate Python / PEFT environment</span></summary><p class="help">${run.recipe.familiarId ? `${esc(run.recipe.instanceId)} / ${esc(run.recipe.familiarId)}` : "This older recipe has no familiar binding. Duplicate it and choose the terminal workflow to add both IDs."}</p><pre>mkdir -p .lab
npm run lab -- prepare --recipe /path/recipe.json --dataset /path/examples.jsonl --identity-dir /path/familiar --out .lab/experiment</pre>
      <p>Use the PEFT environment from <code>training/requirements.txt</code>, separate from managed MLX. Check the prepared bundle and local safetensors model without loading weights:</p>
      <pre>.venv/bin/python training/preflight.py --bundle .lab/experiment --model /path/local-model --device cpu</pre>
      <p class="help">Stdout is <code>mamase.preflight.v1</code> JSON: <code>ready</code>, blocking <code>errors</code>, <code>warnings</code>, verified <code>facts</code> and <code>skipped</code> checks. Exit 1 means blocked. It checks bound identity/splits, model headers, dependencies/device, tokenizer/template and token budgets; it creates no report or outputs and never starts training. Tensor values and memory fit remain unverified. Do not import it as progress or promotion evidence. This browser does not inspect your hardware; this command does not preflight managed MLX jobs.</p>
      <p>After reviewing readiness and warnings, explicitly train with the same model and device:</p>
      <pre>.venv/bin/python training/train.py --bundle .lab/experiment --model /path/local-model --device cpu</pre>
      <p class="help">Replace the example paths with your own. Preview cumulative progress reports before confirming new observations; identical evidence is skipped and conflicts never overwrite history. Setup and the independent evaluator are in the Training handbook. Nothing promotes the adapter.</p>${link("Open training handbook", "#/resources", "docs", "small quiet")}</details></section>
    <details class="card disclosure run-technical" id="run-technical"><summary>Technical details <span>Files, recipe, trainer logs and exact history</span></summary>
      <dl class="facts"><dt>Run ID</dt><dd><code>${run.id}</code></dd><dt>Base model folder</dt><dd><code>${esc(run.recipe.student)}</code></dd><dt>Dataset</dt><dd><a href="#/datasets/${dataset.id}">${esc(dataset.name)}</a> · ${datasetSummary(dataset)}</dd><dt>Dataset fingerprint</dt><dd><code>${dataset.sha256}</code></dd><dt>External output hint</dt><dd><code>${esc(run.recipe.outputPath)}</code> · not used for managed output</dd><dt>Objective</dt><dd>${esc(run.recipe.objective)}</dd></dl>
      <div id="run-job-files"></div><div class="actions">${button("Export recipe", "export-recipe", "download", "small", `data-id="${run.id}"`)}${button("Register artifact", "new-artifact", "plus", "small quiet", `data-id="${run.id}"`)}</div>
      <details class="disclosure"><summary>Full recipe parameters</summary><pre>${esc(JSON.stringify(run.recipe, null, 2))}</pre></details>
      <details class="trainer-log disclosure"><summary>Trainer logs</summary><pre tabindex="0" aria-label="Trainer logs">No managed trainer is linked to this record.</pre></details>
      <div class="section-heading"><h2>Progress journal</h2><div class="actions">${manual ? button("Report template", "report-template", "code", "small", `data-id="${run.id}"`) : ""}${closed || !manual ? "" : button("Record progress", "progress", "plus", "small", `data-id="${run.id}"`)}</div></div>
      <div id="run-journal">${runJournal(run)}</div>
    </details>`;
}

function runJournal(run) {
  return run.history.length ? table(["Recorded", "Status", "Step", "Loss / validation", "Notes"], run.history.slice().reverse().map((event) => [formatDate(event.recordedAt), badge(event.status), `${event.step} / ${event.totalSteps}`, `${event.loss ?? "—"} / ${event.evalLoss ?? "—"}`, esc(event.note) || "—"]), "Run progress journal") : '<p class="muted">This recipe is planned, not running. Launch a local job or record observations from an external trainer.</p>';
}

function runArtifacts(run) {
  const artifacts = workspace.artifacts.filter((artifact) => artifact.runId === run.id);
  return artifacts.length ? `<ul class="output-list">${artifacts.map((artifact) => `<li><span class="item-icon">${icon("models")}</span><div><a class="record-link" href="#/checkpoints/${artifact.id}">${esc(artifact.name)}</a><p>${artifact.kind === "adapter" ? "Adapter · use alongside the same base model" : esc(artifact.kind)} · ${workspace.evaluations.some((item) => item.artifactId === artifact.id) ? "evaluation records available" : "not evaluated yet"}</p></div></li>`).join("")}</ul>` : '<p class="help">No output has been registered for this run.</p>';
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
    } else if (current.page === "resources") {
      // A live managed job keeps mutating and persisting `workspace` under an SSE
      // stream that survives training.watch(null), so the handbook's adopted run
      // (subject() picks the most-recently-updated one when no run is explicitly
      // chosen) can silently drift out from under the user. Re-render so the
      // screen always matches the run the hand-off button would actually export.
      const focused = document.activeElement;
      const isPicker = focused.name === "handbook-run";
      const action = focused.dataset.action;
      const id = focused.dataset.id;
      render();
      if (isPicker) document.querySelector('select[name="handbook-run"]')?.focus({ preventScroll: true });
      else if (action) document.querySelector(`[data-action="${CSS.escape(action)}"]${id ? `[data-id="${CSS.escape(id)}"]` : ""}`)?.focus({ preventScroll: true });
    }
    const size = document.querySelector("#workspace-size");
    if (size) size.textContent = `${formatBytes(new TextEncoder().encode(JSON.stringify(workspace)).length)} / 4 MB`;
    return;
  }
  const run = byId(workspace.runs, runId);
  const latest = run.history.filter((event) => event.loss !== null).at(-1);
  const validation = run.history.filter((event) => event.evalLoss !== null).at(-1);
  document.querySelector("#run-status-line").textContent = `Last recorded ${formatDate(run.updatedAt)}`;
  document.querySelector("#run-step-value").textContent = `${num(run.step)} / ${num(run.totalSteps)}`;
  document.querySelector("#run-loss-value").textContent = formatLoss(latest?.loss);
  document.querySelector("#run-validation-value").textContent = formatLoss(validation?.evalLoss);
  document.querySelector("#run-measurements").hidden = !latest && !validation;
  document.querySelector("#run-loss-reading").textContent = lossReading(run.history);
  const chart = document.querySelector("#run-loss-chart");
  const details = chart.querySelector("details");
  const expanded = details?.open;
  const summaryFocused = document.activeElement === details?.querySelector("summary");
  chart.innerHTML = lossChart(run);
  if (expanded) chart.querySelector("details").open = true;
  if (summaryFocused) chart.querySelector("summary")?.focus({ preventScroll: true });
  const journal = document.querySelector("#run-journal");
  const scroll = journal.querySelector(".table-scroll")?.scrollLeft || 0;
  const scrollTop = journal.querySelector(".table-scroll")?.scrollTop || 0;
  const journalFocused = journal.contains(document.activeElement);
  journal.innerHTML = runJournal(run);
  const region = journal.querySelector(".table-scroll");
  if (region) { region.scrollLeft = scroll; region.scrollTop = scrollTop; if (journalFocused) region.focus({ preventScroll: true }); }
  document.querySelector("#run-artifacts").innerHTML = runArtifacts(run);
  document.querySelector("#run-output-section").hidden = !workspace.artifacts.some((item) => item.runId === runId);
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
  const artifact = workspace.artifacts.find((item) => job?.artifact ? item.id === job.artifact.id : item.runId === runId);
  const capability = training.available;
  const loading = training.loading.has(runId);
  const recipeIssue = managedRecipeIssue(run.recipe);
  const error = !matches ? "A different recipe already uses this run ID on the local server. Duplicate the recipe before launching." : trainingSyncErrors.get(runId) || training.errors.get(runId) || (trainingWorkflow(run) === "managed" ? recipeIssue : "") || "";
  const busy = [...training.jobs.values()].some(localJobActive) || capability?.busy;
  const guide = runGuidance(!matches ? { ...run, localJobId: rawJob.id } : run, { job, artifact, available: capability?.available, loading, busy, error, hosted: hosted || capability?.hosted });
  if (!matches) guide.action = "duplicate";
  const diagnostic = guide.workflow === "managed" && !hosted && !capability?.hosted ? error || job?.error || "" : "";
  const key = JSON.stringify([guide, diagnostic, artifact?.id, loading, busy]);
  const labels = ["Recipe saved", "Train model", "Review output"];
  const trainingStage = guide.phase === "hosted" ? "Continue locally" : ["ready", "external"].includes(guide.phase) ? "Not started here" : "Current stage";
  document.querySelector("#run-journey").innerHTML = `<ol class="run-journey" aria-label="Experiment stages">${labels.map((label, index) => `<li class="${index < guide.stage ? "is-done" : index === guide.stage ? "is-current" : ""}" ${index === guide.stage ? 'aria-current="step"' : ""}><span>${index < guide.stage ? icon("check") : index + 1}</span><div><strong>${label}</strong><small>${index < guide.stage ? "Done" : index === guide.stage ? index === 2 ? "Next: assess quality" : trainingStage : "After training"}</small></div></li>`).join("")}</ol>`;
  if (panel.dataset.state !== key) {
    const focused = panel.contains(document.activeElement);
    const setupOpen = panel.querySelector("#runtime-setup")?.open;
    panel.dataset.state = key;
    panel.dataset.phase = guide.phase;
    let action = "";
    if (guide.action === "start") action = button("Review & start training", "local-launch", "arrow", "primary", `data-id="${runId}"`);
    else if (guide.action === "recheck") action = button("Check trainer connection", "local-refresh", "local", "primary", `data-id="${runId}" ${loading ? "disabled" : ""}`);
    else if (guide.action === "cancel") action = button("Cancel local training", "local-cancel", "", "quiet", `data-id="${job.id}"`);
    else if (guide.action === "review") action = link(artifact.kind === "adapter" ? "Review adapter" : "Review output", `#/checkpoints/${artifact.id}`, "arrow", "primary");
    else if (guide.action === "sync") action = button("Retry workspace sync", "local-sync", "", "primary");
    else if (guide.action === "duplicate") action = button("Edit a copy & retry", "duplicate-run", "plus", "primary", `data-id="${runId}"`);
    else if (guide.action === "export") action = button("Export recipe", "export-recipe", "download", "primary", `data-id="${runId}"`);
    else if (guide.action === "report") action = button("Import report", "import-report", "upload", "primary", `data-id="${runId}"`);
    else if (guide.action === "register") action = button("Import training result", "import-training-result", "upload", "primary", `data-id="${runId}"`);
    else if (guide.action === "backup") action = `${button("Export workspace", "export-workspace", "download", "primary")}${link("Local setup guide", "#/resources", "docs", "quiet")}`;
    panel.innerHTML = `<span class="eyebrow">${hosted ? "HOSTED WORKSPACE · NO LOCAL TRAINER" : guide.workflow === "managed" ? "LOCAL TRAINING · MLX / APPLE SILICON" : "TERMINAL TRAINING · EXTERNAL PROCESS"}</span>
      <h2 tabindex="-1">${esc(guide.title)}</h2><p class="run-state-description">${esc(guide.description)}</p>
      ${["ready", "checking", "setup", "busy"].includes(guide.phase) ? `<ul class="launch-checklist"><li><span>${icon("check")}</span><div><strong>Recipe saved</strong><small>${esc(modelName(run.recipe.student))} · ${num(splitCounts(dataset).train)} training examples</small></div></li><li><span>${capability?.available ? icon("check") : icon("local")}</span><div><strong>${loading ? "Checking trainer" : capability?.available ? "Local trainer available" : "Local trainer needs setup"}</strong><small>Model compatibility is checked when the worker opens it.</small></div></li><li><span>${icon("upload")}</span><div><strong>Choose the original file next</strong><small>${esc(dataset.filename)} · ${formatBytes(dataset.bytes)} · no model download</small></div></li></ul>` : ""}
      ${localJobActive(job) ? `<div class="live-progress"><div><strong id="live-percent"></strong><span id="live-progress-text" role="status"></span></div><progress id="live-progress-bar" aria-label="Reported learning updates"></progress><p class="help">Percentage of learning updates, not time remaining.</p></div>` : ""}
      ${diagnostic ? `<div class="run-warning" role="status"><strong>${trainingSyncErrors.has(runId) ? "Browser save needs attention" : "Details to resolve"}</strong><p>${esc(diagnostic)}</p></div>` : ""}
      ${guide.phase === "setup" ? `<details id="runtime-setup" class="disclosure" open><summary>One-time setup <span>Run in a terminal inside the Mamase folder</span></summary><pre>python3.12 -m venv .venv-training
.venv-training/bin/python -m pip install -r training/requirements-mlx.txt
npm run dev</pre><p class="help">Requires Apple Silicon and Python 3.12. Bring an existing MLX-compatible model folder; installing the trainer does not download a model.</p></details>` : ""}
      <div class="run-control-footer"><div class="actions">${action}${job || run.localJobId ? button("Show technical details", "run-details", "code", "quiet") : ""}</div><p class="help" id="run-status-line">Last recorded ${formatDate(run.updatedAt)}</p></div>`;
    if (setupOpen && panel.querySelector("#runtime-setup")) panel.querySelector("#runtime-setup").open = true;
    if (focused) panel.querySelector("h2").focus({ preventScroll: true });
  }
  const log = document.querySelector(".run-technical .trainer-log pre");
  if (log && job) {
    const follow = log.scrollTop + log.clientHeight >= log.scrollHeight - 10;
    const text = job.logs.join("\n") || "Waiting for trainer output…";
    if (log.textContent !== text) { log.textContent = text; if (follow) log.scrollTop = log.scrollHeight; }
  }
  if (localJobActive(job)) {
    const value = `${num(job.run.step)} of ${num(job.run.totalSteps)} learning updates reported`;
    const live = panel.querySelector("#live-progress-text");
    if (live.textContent !== value) live.textContent = value;
    panel.querySelector("#live-percent").textContent = `${Math.floor(job.run.step / job.run.totalSteps * 100)}%`;
    const progress = panel.querySelector("#live-progress-bar");
    progress.max = job.run.totalSteps;
    progress.value = job.run.step;
    progress.setAttribute("aria-valuetext", value);
  }
  const files = document.querySelector("#run-job-files");
  if (job && files.dataset.job !== job.id) {
    files.dataset.job = job.id;
    files.innerHTML = `<dl class="facts"><dt>Job ID</dt><dd><code>${job.id}</code></dd><dt>Managed output folder</dt><dd><code>${esc(job.outputPath)}</code></dd></dl>${link("Download trainer report", `/api/training/jobs/${job.id}/report`, "download", "small quiet")}`;
  }
  document.querySelectorAll('[data-action="progress"], [data-action="import-report"]').forEach((element) => {
    element.disabled = Boolean(rawJob || run.localJobId);
    element.hidden = Boolean(rawJob || run.localJobId);
    if (rawJob || run.localJobId) element.title = "Managed jobs record their own progress. Duplicate the recipe for another attempt.";
  });
  const template = document.querySelector('[data-action="report-template"]');
  if (template) template.hidden = Boolean(rawJob || run.localJobId);
  const externalGuide = document.querySelector("#external-training-guide");
  if (externalGuide) externalGuide.hidden = guide.workflow !== "cli" || Boolean(rawJob || run.localJobId);
}
function labPage() {
  const draft = ui.draft;
  const distill = draft.method === "distillation";
  const managed = draft.workflow === "managed";
  const dataset = workspace.datasets.find((item) => item.id === draft.datasetId);
  const identityFields = (required) => `<div class="form-grid">${field("Familiar ID", "familiarId", draft.familiarId, { required, attrs: 'maxlength="80" pattern="[a-zA-Z0-9_\\-]+" placeholder="cody"' })}${field("Coven instance ID", "instanceId", draft.instanceId, { required, attrs: 'maxlength="80" pattern="[a-zA-Z0-9_\\-]+" placeholder="my-coven"' })}</div>`;
  return `${header("Distillation lab", `${button("Discard draft", "discard-draft", "", "quiet")}${button("View recipe", "preview-recipe", "code", "quiet")}`, "Make a recipe first. Review it before starting any training.")}
    <div class="draft-status"><p id="draft-status" class="help" role="status">${esc(draftMessage)}</p>${button("Download draft", "download-draft", "download", "small quiet")}</div>
    <form id="recipe-form" data-form="recipe" class="lab-layout"><div class="lab-main">
      <section class="form-section"><h2>Where will you train?</h2><div class="method-picker workflow-picker" role="group" aria-label="Training workflow">
        <button type="button" data-action="workflow" data-workflow="managed" aria-pressed="${managed}" class="method-card ${managed ? "selected" : ""}">${icon("local")}<strong>${hosted ? "Train on a Mac" : "Train on this Mac"}</strong><span>${hosted ? "Plan here, then move your recipe to local Mamase to train." : "Guided LoRA training. Progress and output are saved automatically."}</span><small>Apple Silicon · existing MLX model required</small></button>
        <button type="button" data-action="workflow" data-workflow="cli" aria-pressed="${!managed}" class="method-card ${!managed ? "selected" : ""}">${icon("code")}<strong>Train in a terminal</strong><span>Advanced identity-bound workflow. Run commands and import the results.</span><small>LoRA, rsLoRA, DoRA or CUDA QLoRA</small></button></div><input type="hidden" name="workflow" value="${draft.workflow}"></section>
      <h3>What examples will the model learn from?</h3>
      <div class="method-picker" role="group" aria-label="Training method">
        <button type="button" data-action="method" data-method="lora" aria-pressed="${!distill}" class="method-card ${!distill ? "selected" : ""}">${icon("spark")}<strong>LoRA fine-tuning</strong><span>Teach a base model with your own curated examples.</span></button>
        <button type="button" data-action="method" data-method="distillation" aria-pressed="${distill}" class="method-card ${distill ? "selected" : ""}">${icon("lab")}<strong>Response distillation</strong><span>Train a student on a teacher's recorded responses.</span></button></div>
      <section class="form-section"><h3>Name the experiment</h3>
        <div class="form-grid recipe-identity">${field("Run name", "name", draft.name, { attrs: 'maxlength="100" placeholder="e.g. Coven reasoning · v1"' })}
        ${select("Program", "programId", draft.programId, programOptions())}</div>
        ${managed ? "" : `${identityFields(true)}<p class="help">The terminal preparation command loads IDENTITY.md and SOUL.md from the familiar folder you supply. These IDs must match that identity; training does not grant new tools.</p>`}
        ${field("Training objective", "objective", draft.objective, { textarea: true, attrs: 'maxlength="2000" rows="3" placeholder="What should this model do better? How will you measure it?"' })}</section>
      <section class="form-section"><div class="section-heading"><h3>The knowledge</h3>${button("Import dataset", "import-dataset", "upload", "small quiet")}</div>
        ${select("Training dataset", "datasetId", draft.datasetId, datasetOptions(), "required")}
        <div id="dataset-summary" class="dataset-summary">${dataset ? datasetSummary(dataset) : "Import and select your examples."}</div><p class="help">Keep the original JSONL file. ${managed ? "You will select it again before training; its contents must match this import." : "The preparation command needs that file, not just its name."}</p>
        ${distill ? '<p class="notice inline">The teacher answers must already be in your dataset. This workflow does not call a teacher or generate answers for you.</p>' : ""}</section>
      <section class="form-section"><h3>Choose the model to customize</h3>${field(distill ? "Student model" : "Base model", "student", draft.student, { attrs: `maxlength="200" placeholder="${managed ? "/Users/you/Models/your-model" : "Model name or local path"}"`, hint: managed ? "Use the path to an existing MLX-compatible model folder on the training Mac. A name such as Qwen/model does not download a model. Compatibility is checked at launch." : "Record the base model here. The terminal command also requires the path to its compatible local model files." })}
        ${distill ? field("Teacher model", "teacher", draft.teacher, { attrs: 'maxlength="200"', hint: "Must match the dataset's recorded teacher." }) : ""}
      </section>
      <details class="form-section disclosure" id="recipe-advanced"><summary>Advanced settings <span>Learning parameters${managed ? " and optional ownership labels" : ", adapter technique and export hint"}</span></summary>
        <p class="help">Starting values are provided, not a guarantee of fit or memory usage. Change them when you understand your model's requirements.</p>
        ${managed ? '<input type="hidden" name="adapter" value="lora"><p class="help">This Mac workflow uses LoRA: a small set of trainable changes to the base model.</p>' : select("Adapter technique", "adapter", draft.adapter, Object.entries(ADAPTERS))}
        <div class="form-grid">${select("Rank", "rank", draft.rank, [4, 8, 16, 32, 64, 128, 256].map((rank) => [rank, rank]))}${field("Alpha", "alpha", draft.alpha, { type: "number", attrs: 'min="1" max="1024" step="1"' })}</div>
        <p class="help">Rank controls adapter capacity; alpha scales its contribution. More capacity does not guarantee a better model.</p>
        ${field("Learning rate", "learningRate", draft.learningRate, { type: "number", attrs: 'min="0.00000001" max="1" step="any"', hint: "How large each learning adjustment is." })}
        <div class="form-grid">${field("Epochs", "epochs", draft.epochs, { type: "number", attrs: 'min="1" max="100" step="1"', hint: "Passes through the training examples. Too many can overfit." })}${field("Micro batch", "batchSize", draft.batchSize, { type: "number", attrs: 'min="1" max="128" step="1"', hint: "Examples processed together. Larger batches need more memory." })}</div>
        ${field("Gradient accumulation", "accumulation", draft.accumulation, { type: "number", attrs: 'min="1" max="1024" step="1"', hint: "Combine this many micro-batches before one learning update." })}
        ${field("Max sequence length", "maxSequence", draft.maxSequence, { type: "number", attrs: 'min="128" max="131072" step="1"', hint: "Maximum tokens per example. Long examples may be truncated; examples with no remaining answer are rejected." })}
        ${managed ? `<h3>Optional ownership labels</h3>${identityFields(false)}<p class="help">Supply both IDs or neither. These are labels only; this workflow does not load a canonical familiar identity.</p>` : ""}
        ${field("External trainer output hint", "outputPath", draft.outputPath, { attrs: 'maxlength="500"', hint: "For exporting to other tools. Managed training uses a new private job folder; the terminal workflow uses its bundle's adapter/ folder." })}
      </details>
    </div><aside class="lab-settings recipe-overview" aria-label="Recipe overview">
      <div class="inspector-title">${icon("lab")} Your plan</div><div class="recipe-readiness" id="recipe-readiness" role="status"></div>
      <section><dl class="facts"><dt>Workflow</dt><dd>${managed ? "Local Mac training" : "Train in a terminal"}</dd><dt>Model</dt><dd id="preview-model">${esc(draft.student ? modelName(draft.student) : "Not chosen")}</dd><dt>Examples</dt><dd id="preview-examples">${dataset ? num(dataset.records) : "Not chosen"}</dd><dt>Output</dt><dd>${managed ? "New private job folder, registered automatically" : "Adapter in the terminal bundle; import its result"}</dd></dl><div class="estimate">${icon("clock")}<span id="step-estimate">${stepEstimate()}</span></div></section>
      <section><h3>What saving does</h3><p class="help">${managed ? hosted ? "Saves this recipe in this browser and explains how to move it to local Mamase. This website cannot start or monitor training." : "Saves this recipe and opens a review page. You choose the original file and confirm Start training there." : "Saves a recipe to export. You run the trainer yourself and import its reports."}</p><p class="help">An adapter needs its base model. Nothing is deployed or approved automatically.</p></section>
    </aside><div class="lab-submit"><div class="lab-footer"><p>${icon("local")} No training starts when you save.</p><button type="submit" class="button primary">${icon("arrow")} Save recipe &amp; review</button></div>
      <p class="form-error" role="alert" hidden></p></div></form>`;
}

function datasetSummary(dataset) {
  return `${num(splitCounts(dataset).train)} examples to learn from · ${num(splitCounts(dataset).holdout)} kept aside for holdout checks`;
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
  document.querySelector("#preview-model").textContent = ui.draft.student ? modelName(ui.draft.student) : "Not chosen";
  document.querySelector("#preview-examples").textContent = dataset ? num(dataset.records) : "Not chosen";
  const identitiesRequired = ui.draft.workflow === "cli" || Boolean(ui.draft.familiarId || ui.draft.instanceId);
  for (const name of ["familiarId", "instanceId"]) {
    const control = form.elements.namedItem(name);
    control.required = identitiesRequired;
    control.closest(".field").querySelector(".field-requirement").textContent = identitiesRequired ? "Required" : "Optional";
  }
  const missing = [["name", "a run name"], ...(identitiesRequired ? [["familiarId", "a familiar ID"], ["instanceId", "a Coven instance ID"]] : []), ["objective", "an objective"], ["datasetId", "a dataset"], ["student", "a base/student model"]].filter(([key]) => !ui.draft[key].trim()).map(([, label]) => label);
  const ready = !missing.length && [...form.querySelectorAll("input, select, textarea")].every((control) => control.validity.valid);
  const message = incompatible ? "Choose a teacher-generated dataset for response distillation." : teacherControl?.validity.customError ? teacherControl.validationMessage : missing.length ? `Add ${missing.join(", ")}.` : ready ? "Ready to save your recipe. Training has not started." : "Review the highlighted fields and advanced settings before saving.";
  const readiness = document.querySelector("#recipe-readiness");
  if (readiness.textContent !== message) readiness.textContent = message;
}

function stepEstimate() {
  const dataset = workspace.datasets.find((item) => item.id === ui.draft.datasetId);
  const recipe = numericRecipe(ui.draft);
  if (!dataset || recipe.batchSize < 1 || recipe.accumulation < 1 || recipe.epochs < 1) return "Select a dataset to estimate steps.";
  const steps = estimatedSteps(recipe, dataset);
  return Number.isFinite(steps) ? `${num(steps)} planned learning updates · ${num(recipe.epochs)} passes through the training data` : "Enter valid parameters to estimate updates.";
}

function numericRecipe(draft) {
  const recipe = { ...draft };
  for (const key of ["rank", "alpha", "learningRate", "epochs", "batchSize", "accumulation", "maxSequence"]) recipe[key] = Number(recipe[key]);
  return recipe;
}

function artifactTable(artifacts) {
  return table(["Model / artifact", "Format", "Source run", "Local path", ""], artifacts.map((artifact) => [
    `<a class="record-link" id="artifact-name-${artifact.id}" href="#/checkpoints/${artifact.id}">${esc(artifact.name)}</a><small>${artifact.lineage ? `${esc(artifact.lineage.instanceId)} / ${esc(artifact.lineage.familiarId)} · CLI training report` : artifact.id === `artifact-${byId(workspace.runs, artifact.runId).localJobId}` ? "Managed trainer output" : "Manual file reference"}</small>${artifact.lineage ? `<small>Holdout loss: ${artifact.lineage.baseLoss.toFixed(4)} base → ${artifact.lineage.adapterLoss.toFixed(4)} adapter · not a final benchmark</small>` : ""}`,
    `<span class="tag">${esc(artifact.kind.toUpperCase())}</span><small>${esc(familiarContextLabel(artifact.lineage))}</small>`, runLink(byId(workspace.runs, artifact.runId)),
    `<code class="path">${esc(artifact.path)}</code>`,
    `<div class="actions">${artifact.id === `artifact-${byId(workspace.runs, artifact.runId).localJobId}` && artifact.kind === "adapter" ? `<a class="button small" href="#/testing/${artifact.id}" aria-describedby="artifact-name-${artifact.id}">${icon("chat")} Test model</a>` : ""}${button("Manifest", "artifact-manifest", "download", "small", `data-id="${artifact.id}" aria-describedby="artifact-name-${artifact.id}"`)}</div>`,
  ]), "Local model artifacts");
}

function modelsPage() {
  const artifacts = workspace.artifacts.filter((artifact) => ui.modelKind === "all" || artifact.kind === ui.modelKind);
  return `${header("Model library", workspace.runs.length ? `${button("Import training result", "import-training-result", "upload")}${button("Register artifact", "new-artifact", "plus")}` : link("Create a training recipe", "#/playground", "plus"), "The adapters, checkpoints, and local models we are making our own.")}
    <div class="notice">${icon("models")} Managed training adds its adapter here automatically. Other outputs can be imported or registered manually. An adapter still needs its base model; a library entry is not approval to deploy it.</div>
    <div class="filter-tabs" role="group" aria-label="Artifact format">${[["all", "All artifacts"], ["adapter", "LoRA adapters"], ["checkpoint", "Checkpoints"], ["merged", "Merged models"], ["gguf", "GGUF"]].map(([kind, label]) => `<button data-action="model-filter" data-kind="${kind}" class="${ui.modelKind === kind ? "active" : ""}" aria-pressed="${ui.modelKind === kind}">${label}</button>`).join("")}</div>
    ${artifacts.length ? artifactTable(artifacts) : empty("No saved output here yet.", workspace.artifacts.length ? "No artifacts match this format." : "Finish a managed training run and its adapter will appear here. For terminal training, import the completed result.json.", workspace.artifacts.length ? button("Show all artifacts", "model-filter", "", "", 'data-kind="all"') : workspace.runs.length ? link("View training runs", "#/sessions", "runs") : link("Plan the first experiment", "#/playground", "arrow"), "models")}`;
}

function evaluationTable(evaluations) {
  return table(["Model", "Benchmark / version", "Base → adapter", "Regressions", "Samples", "Recorded", ""], evaluations.slice().reverse().map((evaluation) => {
    const artifact = byId(workspace.artifacts, evaluation.artifactId);
    const comparison = evaluation.comparison;
    return [`<a class="record-link" href="#/checkpoints/${artifact.id}">${esc(artifact.name)}</a><small>${esc(familiarContextLabel(comparison))}</small>`, `${esc(evaluation.benchmark)}<small>${comparison ? `Paired local report - ${esc(suiteAssessment(comparison.suite, workspace.evaluations.flatMap((item) => item.comparison ? [item.comparison.suite] : [])).independence)}` : "Manual observation"}</small>`,
      comparison ? `<strong>${comparison.basePassed} → ${comparison.adapterPassed} / ${comparison.samples}</strong><small>Case-sensitive rule passes</small>` : `<strong>${evaluation.score} / ${evaluation.maximum}</strong><small>No recorded base comparison</small>`,
      comparison ? `<span class="${comparison.regressions ? "error-text" : "muted"}">${comparison.regressions} regressed</span><small>Not approved for promotion</small>` : "—",
      num(evaluation.samples), formatDate(evaluation.createdAt), `${button("Details", "evaluation-details", "", "small", `data-id="${evaluation.id}" aria-label="Details for ${esc(evaluation.benchmark)} on ${esc(artifact.name)}"`)}${comparison ? button("Inspect local report", "review-report", "", "small", `data-id="${evaluation.id}" aria-label="Inspect local report for ${esc(evaluation.benchmark)}"`) : ""}`];
  }), "Recorded benchmark evaluations");
}

function artifactDetail(id) {
  const artifact = byId(workspace.artifacts, id);
  const run = byId(workspace.runs, artifact.runId);
  const dataset = byId(workspace.datasets, run.recipe.datasetId);
  const evaluations = workspace.evaluations.filter((item) => item.artifactId === id);
  const managed = artifact.id === `artifact-${run.localJobId}` && run.status === "completed";
  return `<a class="breadcrumb" href="#/checkpoints">Model library / ${esc(artifact.name)}</a>${header(esc(artifact.name), `${managed && artifact.kind === "adapter" ? link("Test in playground", `#/testing/${id}`, "chat", "primary") : ""}${button("Manifest", "artifact-manifest", "download", "", `data-id="${id}"`)}${button("Record evaluation", "new-evaluation", "plus", managed ? "" : "primary", `data-id="${id}"`)}`, `${artifact.kind.toUpperCase()} · registered ${formatDate(artifact.createdAt)}`)}
    <section class="card"><span class="eyebrow">REVIEW BEFORE USE</span><h2>${evaluations.length ? "Results are recorded. Review the evidence." : "Saved does not mean evaluated."}</h2><p>${artifact.kind === "adapter" ? "This adapter contains learned changes, not the complete model. Load it alongside the same compatible base model in your local runner." : "Check this output's format and requirements in a compatible local runner before using it."}</p>
      <ol class="next-steps"><li><strong>Try fresh examples.</strong> Use examples excluded from training and holdout. ${managed ? "Open the playground to test this adapter with its original base model on the training Mac." : "External formats need a compatible local runner; the playground supports managed MLX adapters."}</li><li><strong>Compare fairly.</strong> Give the base model and adapted model the same prompts and settings. Read the answers, not just a score.</li><li><strong>Record what happened.</strong> Save the benchmark version, sample count and conditions. Training alone does not approve a model or change the coven's runtime.</li></ol></section>
    <section class="card"><h2>Files and source experiment</h2><dl class="facts"><dt>${artifact.kind === "adapter" ? "Adapter folder" : "Local path"}</dt><dd><code>${esc(artifact.path)}</code></dd><dt>Base model</dt><dd><code>${esc(run.recipe.student)}</code></dd><dt>Source run</dt><dd>${runLink(run)}</dd><dt>Dataset</dt><dd><a class="record-link" href="#/datasets/${dataset.id}">${esc(dataset.name)}</a></dd><dt>Registration</dt><dd>${managed ? "The local trainer finalized its files before automatic registration." : artifact.lineage ? "Imported from a CLI training result, with recorded fingerprints." : "Manually recorded file reference; contents were not checked."}</dd><dt>Notes</dt><dd class="prose-notes">${esc(artifact.notes) || "No artifact notes recorded."}</dd></dl><p class="help">The browser does not recheck these files now. Keep model files separately: workspace backups and the downloadable manifest contain references, not model weights.</p><details class="disclosure"><summary>Dataset fingerprint</summary><code>${dataset.sha256}</code></details></section>
    <section class="card"><h2>Familiar context</h2><p class="prose-notes">${esc(familiarContextLabel(managed ? undefined : artifact.lineage))}</p><p class="help">Selected-source fingerprints bind declared configuration, not authenticated membership, full runtime parity or permission to adopt. Legacy identity-files-only results do not include role/skill sources. Managed and manually registered outputs remain unbound unless the identity-bound CLI evidence is imported.</p></section>
    <section class="card"><div class="section-heading"><h2>Recorded evaluations</h2>${link("Compare evaluations", "#/evaluations", "arrow", "small quiet")}</div>${evaluations.length ? evaluationTable(evaluations) : '<p>No evaluations have been recorded for this artifact yet.</p>'}</section>`;
}

function comparisonResult() {
  const first = workspace.evaluations.find((item) => item.id === ui.baseline);
  const second = workspace.evaluations.find((item) => item.id === ui.candidate);
  const result = compareEvaluations(first, second);
  if (!result.compatible) return `<p class="warning">Comparison unavailable: ${result.reasons.map(esc).join(" ")}</p>`;
  return `<p><strong>${result.delta > 0 ? "+" : ""}${result.delta.toFixed(2)} percentage points</strong> · candidate minus baseline</p>
    ${table(["Record", "Model", "Score", "Samples"], [[first, "Baseline"], [second, "Candidate"]].map(([evaluation, label]) => [label, `${esc(byId(workspace.artifacts, evaluation.artifactId).name)}<small>${esc(familiarContextLabel(evaluation.comparison))}</small>`, `${evaluation.score} / ${evaluation.maximum}`, num(evaluation.samples)]), "Evaluation comparison")}
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
  return `${header("Evaluations", workspace.artifacts.length ? `${button("Record evaluation", "new-evaluation", "plus", "primary")}${button("Import paired report", "import-evaluation", "upload")}` : link("Open model library", "#/checkpoints", "models", "primary"), "Collect evidence before choosing a model. This page records results; it does not run a benchmark.")}
    <section class="card"><h2>Start with a fair comparison</h2><p>Test the base model and its adapter on the same fresh examples with the same settings. Record the benchmark version, sample count and conditions below. Loss from training is not an evaluation score.</p><p class="help">A rule-check pass is narrow evidence, not proof of correct or safe answers. Review regressions and raw outputs. Nothing on this page authorizes deployment.</p></section>
    ${comparisonPanel()}${workspace.evaluations.length ? evaluationTable(workspace.evaluations) : empty("No evaluation results recorded.", "Run a benchmark in your local tools, then record its results. For identity-bound terminal bundles, you can also import a paired evaluation report.", link("Choose an output to review", "#/checkpoints", "arrow"), "evaluations")}
    <details class="card disclosure"><summary>Advanced: paired evaluation for terminal bundles <span>PEFT CLI outputs only, not managed MLX adapters</span></summary><div class="section-heading"><h2>Run an independent suite</h2>${button("Suite template", "example-suite", "download", "small")}</div>
      <p>For identity-bound CLI runs, import <code>run-report.json</code>, then <code>result.json</code> in Model library. Author local v2 suites with owner/reviewer, permission, written category rubrics, opaque task families, and declared development/training/tuning/final use. The template is unmistakably synthetic, non-production and not a readiness benchmark. Legacy v1 stays development evidence with independence unverified.</p>
      <pre>.venv/bin/python training/evaluate.py --bundle .lab/experiment --suite /path/suite.json --history /private/evaluation-history.json --out .lab/eval-001</pre>
      <p class="help">Reuse the same private history journal across suite names, versions and candidates; new or missing history is unverified. Optional <code>--task-lineage /private/task-lineage.json</code> checks a declared bundle/dataset-bound inventory, not inferred parser lineage. Import the report, then choose Inspect local report to read paired text and record a separate human opinion. Raw cases are cleared on close/navigation and never enter backups. Only identical suite fingerprints, sample counts and decoding support score comparisons.</p></details>`;
}

const STEP_MARK = { done: "✓", next: "▸", blocked: "!", pending: "○", "not-applicable": "–" };

// The steps whose action genuinely happens in this browser, not a terminal.
// The old prose page linked to these; the spine's step copy (handbook.js,
// owned separately) does not, so the link lives here instead. One link per
// step, in the existing link() style -- never a rewrite of the step's own
// copy or of the receipt's note, which stays exactly as workflow-receipt.mjs
// wrote it for CLI parity.
const docsLink = (label, href) => `<a class="button small quiet" href="${esc(href)}" target="_blank" rel="noreferrer">${icon("external")}${label}</a>`;

const STEP_LINKS = {
  curate: () => link("Import a dataset", "#/datasets", "upload", "small quiet"),
  plan: () => link("Open the lab", "#/playground", "lab", "small quiet"),
  "human-review": () => link("Go to evaluations", "#/evaluations", "arrow", "small quiet"),
  // The prose page this spine replaced carried these two references; the steps
  // that name the techniques are where they belong.
  train: () => docsLink("PEFT adapter techniques", "https://huggingface.co/docs/peft/main/en/package_reference/lora"),
  job: () => docsLink("MLX-LM documentation", "https://github.com/ml-explore/mlx-lm"),
};

// "launch"'s receipt note is written for an agent (POST a command token to an
// HTTP endpoint); the actual browser action is the launch button on this run's
// own session page, so that step needs the run to link to rather than a fixed route.
function handbookStepLink(step, run) {
  if (step.id === "launch") return run ? link("Open this run's session", `#/sessions/${run.id}`, "arrow", "small quiet") : "";
  return STEP_LINKS[step.id]?.() ?? "";
}

function handbookStep(step, index, run) {
  const stepLink = handbookStepLink(step, run);
  // handbookCapabilityState latches "failed" until this button (or a full
  // reload) resets it, so a probe that failed before `npm run dev` was
  // started would otherwise never get retried for the rest of the session.
  const retryTrainer = step.id === "capability" && step.evidence?.state === "unreachable";
  return `<li class="handbook-step" data-step-state="${esc(step.state)}" data-step-id="${esc(step.id)}">
    <span class="handbook-mark" aria-hidden="true">${STEP_MARK[step.state] || "○"}</span>
    <div class="handbook-body">
      <h3>${String(index + 1).padStart(2, "0")} · ${esc(step.title)}<span class="handbook-state">${esc(step.state)}</span></h3>
      <p>${esc(step.purpose)}</p>
      ${stepLink ? `<p class="handbook-step-link">${stepLink}</p>` : ""}
      ${step.requiresApproval ? `<p class="handbook-approval">${icon("local")} Needs your explicit go-ahead.</p>` : ""}
      ${step.command ? `<div class="handbook-command"><pre>${esc(step.command)}</pre>${button("Copy", "copy-command", "copy", "small quiet", `data-command="${esc(step.command)}" aria-label="Copy the ${esc(step.title)} command"`)}</div>
        ${hosted ? '<p class="help">Run this on your Mac. This hosted site cannot run or monitor training.</p>' : ""}` : ""}
      ${step.note ? `<p class="help">${esc(step.note)}</p>` : ""}
      ${retryTrainer ? `<p class="handbook-step-link">${button("Check trainer connection", "handbook-capability-retry", "local", "small quiet")}</p>` : ""}
      ${step.setup ? `<details id="handbook-setup-${esc(step.id)}" class="disclosure"><summary>One-time setup <span>Run in a terminal inside the Mamase folder</span></summary><pre>${esc(step.setup.commands)}</pre><p class="help">${esc(step.setup.note)}</p></details>` : ""}
      ${step.boundaries ? `<details class="disclosure"><summary>What this does not do</summary><p>${esc(step.boundaries)}</p></details>` : ""}
    </div></li>`;
}

// Whether the local runtime has been asked for the managed-mlx lane's capability
// step: "unset" (not asked yet), "loading" (a request is in flight), "ready" (an
// answer arrived; read it from training.available) or "failed" (the request
// itself errored, e.g. no JSON response -- the server did not answer, distinct
// from never having asked at all).
let handbookCapabilityState = "unset";

function handbookState() {
  // undefined = not queried (classifyCapability's "unknown"), null = queried but
  // the server did not answer ("unreachable"), an object = the last answer. The
  // ternary below must keep all three distinct -- collapsing null into undefined
  // would silently hide the unreachable-server state.
  const capability = training.available !== undefined ? training.available
    : handbookCapabilityState === "failed" ? null
    : undefined;
  return handbookModel(workspace, {
    runId: ui.handbookRun,
    ...(capability !== undefined ? { capability } : {}),
  });
}

// render() calls training.watch(null) on every page but the run detail page, so
// the handbook's own capability step must ask for itself: the managed-mlx lane
// is the only one that ever forwards a capability into the receipt (handbook.js
// refuses it for peft/unselected), so only query there. Re-renders once the
// answer (or failure) is in, from whatever page is still showing at that point.
async function refreshHandbookCapability() {
  if (handbookCapabilityState !== "unset" || handbookState().lane !== "managed-mlx") return;
  handbookCapabilityState = "loading";
  try {
    await training.capability();
    handbookCapabilityState = "ready";
  } catch {
    handbookCapabilityState = "failed";
  }
  if (route().page === "resources" && !storageError) render();
}

function resourcesPage() {
  const model = handbookState();
  const picker = model.choices.length > 1 && model.run
    ? `<label class="handbook-picker">Run <select name="handbook-run">${model.choices.map((choice) => `<option value="${esc(choice.id)}" ${choice.id === model.run.id ? "selected" : ""}>${esc(choice.name)}</option>`).join("")}</select></label>`
    : "";
  return `${header("Training handbook", model.run ? button("Hand off to an agent", "agent-handoff", "download", "primary") : model.empty ? button("Download example dataset", "example-dataset", "download", "quiet") : "", "Where this run stands, and the next thing to do.")}
    <section class="card handbook-card">
      <div class="handbook-top">
        <p id="handbook-lane" class="eyebrow">${model.empty ? "NEW WORKSPACE" : `LANE: ${esc(model.lane)} · ${esc(model.run.name)}`}</p>
        ${picker}
      </div>
      ${model.blockers.length ? `<div class="notice" role="status"><div><strong>Blocked</strong>${model.blockers.map((item) => `<p>${esc(item.message)}</p>`).join("")}</div></div>` : ""}
      <ol id="handbook-steps" class="handbook-steps">${model.steps.map((step, index) => handbookStep(step, index, model.run)).join("")}</ol>
      <p class="help handbook-boundary">${HANDBOOK_BOUNDARY} ${model.empty ? "Import a dataset to begin." : "This page reads your saved workspace. It never inspects prepared bundles on disk; pass --bundle to npm run ops -- receipt to verify those files."}</p>
    </section>
    <section class="card"><h2>Work with an agent</h2>
      <p>This repository ships a skill at <code>skills/mamase/SKILL.md</code>. Handing off exports your workspace and copies a prompt naming that file, this run and its lane.</p>
      <p class="help">The prompt carries no dataset contents and no local training command token. An agent may plan, prepare and read evidence; only you approve training, and only a human records a review decision.</p>
    </section>`;
}

function appearanceSettings() {
  return `<section class="card appearance-card"><h2>Appearance</h2><p>System is the default and follows your device automatically. Choose an override here when you prefer.</p>${themePicker()}<p class="help" id="theme-description"></p><p class="help">Saved on this browser, independently of workspace backups.</p></section>`;
}

function settingsPage() {
  return `${header("Workspace settings", "", "A local home for the coven's experiments.")}
    <div class="settings-grid">${accountSettings()}${appearanceSettings()}
    <section class="card"><h2>Workspace identity</h2><form data-form="workspace">${field("Workspace name", "workspaceName", workspace.name, { attrs: 'maxlength="80"' })}<button class="button primary" type="submit">Save name</button><p class="form-error" role="alert" hidden></p></form></section>
    <section class="card"><h2>Backups &amp; portability</h2><p>Recipes, dataset fingerprints, recorded results, and artifact references are saved in this browser, not in a cloud account.</p><div class="actions">${button("Export workspace", "export-workspace", "download")}${button("Restore backup", "restore-workspace", "upload")}</div><p class="help">Exports use a versioned backup envelope. Restore previews the source format and collection counts before replacement; legacy v1 backups remain supported. Appearance settings, dataset contents and model weights are not included.</p></section>
    <section class="card"><h2>Execution boundary</h2><dl class="facts"><dt>Trainer</dt><dd>${hosted ? "Not available on this hosted site" : "Local MLX-LM or explicit PEFT CLI"}</dd><dt>Inference</dt><dd>${hosted ? "Not available on this hosted site" : "Local MLX playground for completed managed models"}</dd><dt>Storage</dt><dd>Workspace in this browser; model files stay on local disk</dd><dt>Workspace size</dt><dd id="workspace-size">${formatBytes(new TextEncoder().encode(JSON.stringify(workspace)).length)} / 4 MB</dd></dl><p>${hosted ? "This site supports workspace planning and account sign-in, not training or inference. Export a backup and restore it in local Mamasé to move your recipes; the two addresses do not share browser storage." : "Managed jobs keep their input, splits, logs and adapters separately. Test their output in the playground. Training and generation share one local runtime slot."}</p></section>
    <section class="card"><h2>Reset workspace</h2><p>Remove this browser's saved metadata and start fresh. Your datasets and local model files are not touched.</p>${button("Reset local workspace", "reset-workspace", "", "danger")}</section></div>`;
}

const pages = { home: homePage, projects: projectsPage, datasets: datasetsPage, sessions: runsPage, checkpoints: modelsPage, playground: labPage, testing: () => '<div id="model-playground"></div>', evaluations: evaluationsPage, resources: resourcesPage, settings: settingsPage };

function render() {
  const gate = accessPhase(account.state);
  if (gate !== "open") { renderAccessGate(gate); return; }
  const { page, id } = route();
  if (page !== "testing" || storageError) modelPlayground.deactivate();
  const viewKey = `${page}/${id || ""}`;
  const expanded = app.dataset.viewKey === viewKey ? [...app.querySelectorAll("details[id][open]")].map((element) => element.id) : [];
  app.dataset.viewKey = viewKey;
  if (page === "sessions" && !id) {
    const { query, status, program, sort, runPage } = route();
    Object.assign(ui, { query, status, program, sort, runPage });
  }
  let content;
  if (storageError) content = `${header("Workspace needs attention")}<div class="card"><p class="error-text">${esc(storageError)}</p><div class="actions">${button("Download stored data", "raw-backup", "download")}${button("Restore backup", "restore-workspace", "upload")}${button("Reset local workspace", "reset-workspace", "", "danger")}</div></div>${page === "settings" ? accountSettings() + appearanceSettings() : ""}`;
  else if (page === "sessions" && id) content = workspace.runs.some((run) => run.id === id) ? runDetail(id) : empty("Run not found.", "This run is not in the current workspace.", link("Back to training runs", "#/sessions"));
  else if (page === "datasets" && id) content = workspace.datasets.some((item) => item.id === id) ? datasetDetail(id) : empty("Dataset not found.", "This dataset is not in the current workspace.", link("Back to datasets", "#/datasets"));
  else if (page === "checkpoints" && id) content = workspace.artifacts.some((item) => item.id === id) ? artifactDetail(id) : empty("Artifact not found.", "This artifact is not in the current workspace.", link("Back to model library", "#/checkpoints"));
  else content = pages[page] ? pages[page]() : empty("Page not found.", "Choose a workspace view from the navigation.", link("Back to overview", "#/home"));
  const collection = page === "sessions" ? workspace?.runs : page === "datasets" ? workspace?.datasets : page === "checkpoints" ? workspace?.artifacts : null;
  const pageTitle = (id && collection?.find((item) => item.id === id)?.name) || nav.find(([key]) => key === page)?.[1] || (page === "settings" ? "Workspace settings" : page === "resources" ? "Training handbook" : "Mamasé");
  document.title = `${pageTitle} · Mamasé`;
  app.innerHTML = `<div class="shell ${ui.menu ? "menu-open" : ""} ${ui.collapsed ? "collapsed" : ""}">
    <a class="skip-link" href="#main">Skip to content</a>${sidebar(page)}
    <button class="menu-scrim" type="button" data-action="close-menu" aria-label="Close navigation" ${ui.menu ? "" : "hidden"}></button>
    <div class="mobile-header"><button type="button" class="icon-button" data-action="toggle-menu" aria-controls="navigation" aria-expanded="${ui.menu}" aria-label="Open navigation">${icon("panel")}</button><a class="brand" href="#/home">mamasé.</a><span class="workspace-tag">${hosted ? "HOSTED" : "LOCAL LAB"}</span>${workspace ? `<button type="button" class="icon-button mobile-search" data-action="search" aria-label="Search workspace">${icon("search")}</button>` : ""}<a class="icon-button" href="#/settings" aria-label="Account settings">${icon("settings")}</a></div>
    <main class="main ${page === "home" && !storageError ? "main-home" : ""}" id="main" tabindex="-1"><section id="workspace-alert" class="notice workspace-alert" role="alert" hidden></section>${content}</main></div>`;
  for (const id of expanded) { const details = document.getElementById(id); if (details instanceof HTMLDetailsElement) details.open = true; }
  updateSidebarAccess();
  updateStorageNotice();
  syncRunCount();
  syncRecipe();
  syncThemeControls();
  if (page === "testing" && !storageError) modelPlayground.mount(document.querySelector("#model-playground"), { artifactId: id, workspace });
  void training.watch(page === "sessions" && id && !storageError ? workspace.runs.find((run) => run.id === id) : null);
  if (page === "resources" && !storageError) void refreshHandbookCapability();
}

function updateSidebarAccess() {
  const mobile = matchMedia("(max-width: 760px)").matches;
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;
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
  if (!notice) return;
  notice.hidden = !ui.conflict;
  document.querySelector("#main").classList.toggle("has-workspace-alert", ui.conflict);
  if (ui.conflict && !notice.childElementCount) notice.innerHTML = `<div><strong>This workspace changed in another tab.</strong><p>Your open forms have been kept. Reload the latest data before saving to avoid overwriting changes.</p><div class="actions">${button("Export open workspace", "export-workspace", "download", "small")}${button("Reload workspace", "reload-workspace", "", "small")}</div></div>`;
}

function assertWorkspaceSource(expectedSource) {
  if (localStorage.getItem(STORAGE_KEY) !== expectedSource) {
    ui.conflict = true;
    updateStorageNotice();
    throw new Error("This workspace changed while you were editing. Reload before saving to avoid overwriting those changes.");
  }
}

function persist(next, expectedSource) {
  assertWorkspaceSource(expectedSource);
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
  dialog.classList.toggle("case-review", form === "human-review");
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
  modalContext = undefined;
  dialog.replaceChildren();
  dialog.classList.remove("case-review");
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

function importDialog(title, form, description, context = {}, label = "Import") {
  openModal(title, `<p class="muted">${description}</p>${field("JSON file", "file", "", { type: "file", attrs: 'accept=".json,application/json"' })}${formFooter(label)}`, form, context);
}

function progressReportPreview(preview, report, expectedSource) {
  const { additions, duplicates, conflicts } = preview;
  openModal("Review progress report", `
    <p id="report-summary" role="status">${num(additions.length)} new · ${num(duplicates.length)} duplicates · ${num(conflicts.length)} conflicts</p>
    <p>No changes have been saved. Duplicates match recorded evidence or repeat an observation in this file. Original timestamps and journal order are preserved.</p>
    ${conflicts.length ? `<p class="warning">The entire import is blocked. Correct the source report or use a separate run; existing evidence cannot be overwritten.</p><ul>${conflicts.slice(0, 20).map(({ index, message }) => `<li>Observation ${index + 1}: ${esc(message)}</li>`).join("")}</ul>${conflicts.length > 20 ? "<p>Showing the first 20 conflicts.</p>" : ""}` : additions.length ? "<p>Confirm to append only the new observations below.</p>" : "<p>This report contains no new observations. Keeping the existing history will not write to storage, even for a closed run.</p>"}
    ${additions.length ? `${table(["Report row", "Recorded", "Status", "Step", "Loss / validation", "Notes"], additions.slice(0, 20).map(({ index, update }) => [index + 1, esc(update.recordedAt), badge(update.status), `${update.step} / ${update.totalSteps}`, `${update.loss ?? "—"} / ${update.evalLoss ?? "—"}`, esc(update.note) || "—"]), "Proposed progress observations")}${additions.length > 20 ? `<p class="help">Showing the first 20 of ${num(additions.length)} proposed additions.</p>` : ""}` : ""}
    <p class="help">If storage is full, export a backup and free space before retrying. If another tab saved changes, reload the latest workspace and preview the report again.</p>
    <div class="actions">${button("Export open workspace", "export-workspace", "download", "small")}${button("Reload workspace", "reload-workspace", "", "small")}</div>
    ${conflicts.length ? `<div class="modal-footer">${button("Cancel", "close-dialog", "", "quiet")}${button("Choose another report", "import-report", "upload", "primary", `data-id="${preview.runId}"`)}</div>` : formFooter(additions.length ? "Import new observations" : "Keep existing history")}`,
  conflicts.length ? "" : "confirm-report", { runId: preview.runId, report, expectedSource });
  const title = dialog.querySelector("#dialog-title");
  title.tabIndex = -1;
  title.focus();
}

function workspaceRestorePreview(backup, filename, expectedSource) {
  const collections = ["programs", "datasets", "runs", "artifacts", "evaluations"];
  openModal("Review workspace restore", `
    <p id="restore-summary" role="status">No changes have been saved. This replaces all current workspace metadata, not individual records.</p>
    <dl class="facts"><dt>Source file</dt><dd>${esc(filename)}</dd><dt>Backup format</dt><dd>${esc(backup.format)}</dd><dt>Workspace version</dt><dd>${backup.workspace.version}</dd><dt>Exported at</dt><dd>${backup.exportedAt ? esc(backup.exportedAt) : "Not recorded in a legacy backup"}</dd><dt>Current workspace</dt><dd>${esc(workspace?.name || "Unavailable: stored data needs recovery")}</dd><dt>Replacement workspace</dt><dd>${esc(backup.workspace.name)}</dd></dl>
    ${backup.migration ? '<p class="help">Legacy workspace v1 will be validated and restored as workspace v1. The next export uses the versioned backup envelope; existing lineage and comparisons are retained.</p>' : ""}
    ${table(["Collection", "Current", "Backup"], collections.map((key) => [esc(key), workspace ? num(workspace[key].length) : "Unavailable", num(backup.workspace[key].length)]), "Workspace restore collection counts")}
    <p class="warning">Current browser metadata will be replaced. Appearance settings and files on disk are unchanged. This does not cancel or delete managed training jobs.</p>
    <p class="help">Export recovery data first. If storage is full, free space and retry this confirmation. If another tab changes the workspace, reload and preview again.</p>
    <div class="actions">${workspace ? button("Export open workspace", "export-workspace", "download", "small") : button("Download stored data", "raw-backup", "download", "small")}${button("Reload workspace", "reload-workspace", "", "small")}</div>
    <label class="check-label"><input name="confirm" type="checkbox" required> I understand this replaces the browser's saved workspace.</label>${formFooter("Restore workspace")}`,
  "confirm-restore", { backup, expectedSource });
  const title = dialog.querySelector("#dialog-title");
  title.tabIndex = -1;
  title.focus();
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
  "auth-refresh": () => account.refresh(),
  "sign-in": () => {
    assert(account.state.phase === "signed-out", "Check the account connection before signing in.");
    const returnTo = /^#\/[A-Za-z0-9/_-]{0,200}$/.test(location.hash) ? `/${location.hash}` : "/#/settings";
    location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  },
  "sign-out": async () => location.assign(await account.logout()),
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
    requestDraft({ ...defaults(), ...Object.fromEntries(Object.entries(run.recipe).map(([key, value]) => [key, String(value)])), workflow: trainingWorkflow(run), name: `${run.name.slice(0, 90)} · copy`, outputPath: run.recipe.outputPath.length <= 495 ? `${run.recipe.outputPath}-copy` : "" });
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
  // Resets the latch in handbookCapabilityState so a probe that failed before
  // `npm run dev` was running gets asked again, instead of reporting
  // "unreachable" for the rest of the session with no way to retry.
  "handbook-capability-retry": () => { handbookCapabilityState = "unset"; render(); void refreshHandbookCapability(); },
  "local-sync": flushTrainingUpdates,
  "run-details": () => {
    const details = document.querySelector("#run-technical");
    details.open = true;
    details.querySelector(".trainer-log").open = true;
    details.querySelector("summary").focus();
    details.scrollIntoView({ block: "start", behavior: "instant" });
  },
  workflow: (element) => {
    const value = element.dataset.workflow;
    assert(["managed", "cli"].includes(value), "Choose a training workflow.");
    const changedTechnique = value === "managed" && ui.draft.adapter !== "lora";
    ui.draft.workflow = value;
    if (value === "managed") ui.draft.adapter = "lora";
    saveDraft();
    render();
    document.querySelector(`[data-workflow="${value}"]`).focus();
    if (changedTechnique) notify("Train on this Mac uses LoRA. Your other settings have been kept.");
  },
  "local-launch": (element) => {
    const run = byId(workspace.runs, element.dataset.id);
    const dataset = byId(workspace.datasets, run.recipe.datasetId);
    assert(run.status === "planned" && !run.localJobId, "Duplicate this recipe to start a new local attempt.");
    const recipeIssue = managedRecipeIssue(run.recipe);
    assert(!recipeIssue, recipeIssue);
    openModal("Review before starting training", `<p>Start a real training process on this Mac. The base model stays unchanged; learned changes are saved as a new adapter.</p>
      <div class="launch-summary"><div><small>Model</small><strong>${esc(modelName(run.recipe.student))}</strong></div><div><small>Examples</small><strong>${num(splitCounts(dataset).train)} train / ${num(splitCounts(dataset).holdout)} holdout</strong></div><div><small>Planned work</small><strong>${num(run.totalSteps)} learning updates</strong></div></div>
      ${field("Original JSONL file", "file", "", { type: "file", attrs: 'accept=".jsonl,.ndjson,application/x-ndjson"', hint: `Choose <strong>${esc(dataset.filename)}</strong> (${formatBytes(dataset.bytes)}). Its contents must match the file you imported. A renamed or edited replacement may not match.` })}
      <label class="check-label"><input type="checkbox" name="confirmManagedOutput" required> Start training and keep a private local copy of these examples, logs and output. Do not overwrite existing model files.</label>
      <p class="help">You can close the browser, but keep the Mamase server running. No model is downloaded. Nothing is deployed automatically.</p>
      <details class="disclosure"><summary>File locations and fingerprint</summary><dl class="facts"><dt>Base model folder</dt><dd><code>${esc(run.recipe.student)}</code></dd><dt>Dataset SHA-256</dt><dd><code>${dataset.sha256}</code></dd><dt>Output</dt><dd>A new job folder inside <code>${esc(training.available?.outputRoot || ".mamase/training")}</code></dd></dl>${run.recipe.familiarId ? '<p class="help">Familiar IDs are labels here; this workflow does not load the canonical identity bundle.</p>' : ""}</details>
      ${formFooter("Start training")}`, "local-launch", { runId: run.id });
  },
  "local-cancel": (element) => openModal("Cancel local training?", `<p>The local trainer process will be stopped. Partial files are retained for inspection but will not be registered as a completed adapter.</p>${formFooter("Cancel local job")}`, "local-cancel", { jobId: element.dataset.id }),
  "new-program": () => programModal(),
  "edit-program": (element) => programModal(byId(workspace.programs, element.dataset.id)),
  "import-dataset": () => openModal("Import a dataset", `
    <p class="muted">Choose a JSONL file, up to 20 MB: one conversation or prompt/response pair per line. This step saves its description, not a training job. Keep the original file for later.</p>
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
    importDialog("Import progress report", "report", "Choose a mamase.run-report.v1 JSON file (up to 4 MB). Preview new observations, duplicates and conflicts before saving. Exact repeats are safe, including on closed runs; history is never rewritten.", { runId: element.dataset.id }, "Preview report");
  },
  "import-training-result": (element) => importDialog("Import training result", "training-result", "Choose result.json from a completed local training bundle. Import its run-report.json first. This registers the actual adapter path, source fingerprints, and base/adapter holdout loss; it never promotes a model.", { runId: element.dataset.id }),
  "import-evaluation": () => importDialog("Import paired evaluation", "paired-evaluation", "Choose evaluation-report.json from the local evaluator (up to 20 MB). Import the matching training result first. Scores are recomputed from the report's string checks; only summaries and fingerprints are saved, not its prompts or responses."),
  "review-report": (element) => {
    const evaluation = byId(workspace.evaluations, element.dataset.id);
    assert(evaluation.comparison, "Import a paired report before inspecting its cases.");
    importDialog("Inspect exact local paired report", "review-file", "Select the original evaluation-report.json from your disk (up to 20 MB). Its exact bytes must match the imported fingerprint. Missing or changed files cannot be recovered from a workspace backup. Per-case text is temporary and is cleared on close/navigation. External execution receipts are unsupported.",
      { evaluationId: evaluation.id, expectedSource: savedSource }, "Inspect report");
  },
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
      ${suiteFacts(comparison.suite, workspace.evaluations.flatMap((item) => item.comparison ? [item.comparison.suite] : []))}
      ${decisionHistory(evaluation)}
      <p class="prose-notes">Familiar context: ${esc(familiarContextLabel(comparison))}</p>
      <p class="help">Full per-case prompts, checks, and model outputs are in the original local report. These fingerprints identify imported evidence; they are not a signature or a browser verification of model files.</p>
      ${button("Inspect local report", "review-report", "", "primary", `data-id="${evaluation.id}"`)}` : `<p>Score: ${evaluation.score} / ${evaluation.maximum} · ${evaluation.samples} samples. No paired base comparison was imported.</p>`}`);
  },
  "example-suite": () => downloadJson("synthetic-non-production-suite-v2.json", syntheticSuiteTemplate()),
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
  "export-workspace": () => download("coven-workspace.json", exportWorkspaceBackup(workspace, now())),
  "agent-handoff": async () => {
    const model = handbookState();
    assert(model.run, "Save a recipe before handing this workspace to an agent.");
    assertWorkspaceSource(savedSource);
    const timestamp = now();
    const filename = handoffFilename(timestamp);
    download(filename, exportWorkspaceBackup(workspace, timestamp));
    const prompt = agentPrompt({ filename, run: model.run, lane: model.lane });
    try {
      await navigator.clipboard.writeText(prompt);
      notify(`Workspace exported as ${filename}. The agent prompt is on your clipboard.`);
    } catch {
      openModal("Copy the agent prompt", `<p>The workspace was exported as <code>${esc(filename)}</code>, but this browser refused clipboard access. Copy the prompt below and hand it to an agent using <code>skills/mamase/SKILL.md</code>.</p><textarea class="handoff-prompt" rows="14" readonly>${esc(prompt)}</textarea>`);
    }
  },
  "copy-command": async (element) => {
    const command = element.dataset.command || "";
    assert(command, "This step has no command to copy.");
    try {
      await navigator.clipboard.writeText(command);
      notify("Command copied.");
    } catch {
      openModal("Copy the command", `<textarea class="handoff-prompt" rows="4" readonly>${esc(command)}</textarea>`);
    }
  },
  "restore-workspace": () => openModal("Restore a workspace backup", `<p>Choose a versioned Mamase backup or a legacy workspace v1 JSON file. Preview its source and collection counts before confirming replacement. The workspace payload must fit the 4 MB storage budget.</p>${field("Workspace JSON backup", "file", "", { type: "file", attrs: 'accept=".json,application/json"' })}${formFooter("Preview backup")}`, "restore"),
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
  const expectedSource = ["confirm-report", "confirm-restore", "review-file", "human-review"].includes(type) ? context.expectedSource : savedSource;
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
  if (type === "review-file") {
    const { report, reportSha256 } = await readReviewFile(input.file);
    assert(form.isConnected && dialog.open, "The review was closed before loading finished. No evidence was retained.");
    assertWorkspaceSource(expectedSource);
    const review = await prepareReview(workspace, context.evaluationId, report, reportSha256);
    assert(form.isConnected && dialog.open, "The review was closed before loading finished. No evidence was retained.");
    assertWorkspaceSource(expectedSource);
    openModal("Inspect paired case evidence", reviewBody(review, byId(workspace.evaluations, review.evaluationId),
      workspace.evaluations.flatMap((item) => item.comparison ? [item.comparison.suite] : [])),
    "human-review", { review, expectedSource });
    const title = dialog.querySelector("#dialog-title");
    title.tabIndex = -1;
    title.focus();
    return;
  } else if (type === "human-review") {
    assert(input.confirmTextOnly === "on", "Acknowledge the text-only review and authorization boundary.");
    next = recordHumanDecision(next, context.review, {
      ...input, id: newId("review"), recordedAt: now(), annotations: reviewAnnotations(context.review, input),
    });
    destination = "#/evaluations";
    message = "Human review opinion saved for this exact report. Rule scores unchanged; no deployment, promotion, identity or tool changes.";
  } else if (type === "program") {
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
    message = "Recipe saved. Review the next step; training has not started.";
  } else if (type === "progress") {
    assert(!byId(next.runs, context.runId).localJobId && !training.jobs.has(context.runId), "Managed local jobs record their own progress.");
    const index = next.runs.findIndex((run) => run.id === context.runId);
    next.runs[index] = recordProgress(byId(next.runs, context.runId), { ...input, step: Number(input.step), totalSteps: Number(input.totalSteps), loss: optionalNumber(input.loss), evalLoss: optionalNumber(input.evalLoss), recordedAt: now() });
    message = "Training progress recorded.";
  } else if (type === "report") {
    assert(!byId(next.runs, context.runId).localJobId && !training.jobs.has(context.runId), "Managed local jobs record their own progress.");
    const { source } = await readFile(form, MAX_WORKSPACE_BYTES);
    const report = JSON.parse(source);
    const preview = previewProgressReport(byId(next.runs, context.runId), report);
    assert(form.isConnected && dialog.open, "The form was closed before saving. No changes were made.");
    assertWorkspaceSource(expectedSource);
    progressReportPreview(preview, report, expectedSource);
    return;
  } else if (type === "confirm-report") {
    assert(!training.jobs.has(context.runId), "Managed local jobs record their own progress.");
    const preview = previewProgressReport(byId(workspace.runs, context.runId), context.report);
    next = importProgressReport(workspace, context.report);
    if (!preview.additions.length) {
      assert(form.isConnected && dialog.open, "The form was closed before saving. No changes were made.");
      assertWorkspaceSource(expectedSource);
      closeModal();
      notify(`Already recorded: ${num(preview.duplicates.length)} duplicate observations. No changes were saved.`);
      return;
    }
    message = `${num(preview.additions.length)} new observations imported; ${num(preview.duplicates.length)} duplicates skipped.`;
  } else if (type === "artifact") {
    next.artifacts.push(validateArtifact({ ...input, id: newId("artifact"), createdAt: now() }, next));
    message = "Artifact reference registered. Local files were not changed.";
  } else if (type === "training-result" || type === "paired-evaluation") {
    const { file, source } = await readFile(form, MAX_IMPORT_BYTES);
    assert(form.isConnected && dialog.open, "The form was closed before saving. No changes were made.");
    let report;
    try {
      report = JSON.parse(source);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("The report contains invalid JSON. No changes were made.");
    }
    if (context.runId) assert(report.runId === context.runId, "Training result belongs to another run.");
    const metadata = { id: newId(type === "training-result" ? "artifact" : "evaluation"), sha256: await fileDigest(file), createdAt: now() };
    assert(form.isConnected && dialog.open, "The form was closed before saving. No changes were made.");
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
    const { file, source } = await readFile(form, MAX_BACKUP_BYTES);
    const backup = parseWorkspaceBackup(source);
    assert(form.isConnected && dialog.open, "The form was closed before saving. No changes were made.");
    assertWorkspaceSource(expectedSource);
    workspaceRestorePreview(backup, file.name, expectedSource);
    return;
  } else if (type === "confirm-restore") {
    assert(input.confirm === "on", "Confirm that you want to replace the workspace.");
    next = context.backup.workspace;
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
  if (type === "recipe" || type === "reset" || type === "confirm-restore") {
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
  if (type === "reset" || type === "confirm-restore") { ui.program = "all"; ui.status = "all"; ui.query = ""; training.forget(); pendingTraining.clear(); trainingSyncErrors.clear(); }
  closeModal();
  if (destination && location.hash !== destination) location.hash = destination; else render();
  if (type === "dataset" && context.fromLab) document.querySelector("#field-datasetId")?.focus();
  notify(message);
}

document.addEventListener("click", (event) => {
  const element = event.target.closest("[data-action]");
  if (!element) return;
  try {
    assert(!gated() || GATE_ACTIONS.has(element.dataset.action), "This workspace stays closed until an approved account is signed in.");
    const action = actions[element.dataset.action];
    assert(action, "This action is unavailable.");
    const result = action(element);
    if (result && typeof result.then === "function") result.catch((error) => notify(error.message, true));
  } catch (error) {
    notify(error.message, true);
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-form]");
  if (!form) return;
  event.preventDefault();
  if (gated()) { notify("This workspace stays closed until an approved account is signed in.", true); return; }
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
    const cancelledReview = ["review-file", "human-review"].includes(form.dataset.form) && (!form.isConnected || !dialog.open);
    errorBox.textContent = cancelledReview ? "The review was closed before loading finished. No evidence was retained."
      : error.name === "QuotaExceededError" ? "Browser storage is full. Export a backup and free space before saving." : error.message;
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

document.addEventListener("invalid", (event) => {
  event.target.setAttribute("aria-invalid", "true");
  for (let details = event.target.closest("details"); details; details = details.parentElement.closest("details")) details.open = true;
}, true);

document.addEventListener("change", (event) => {
  if (event.target.name === "regressionsOnly") {
    const rows = [...dialog.querySelectorAll("[data-review-case]")];
    for (const row of rows) row.hidden = event.target.checked && row.dataset.regression !== "true";
    dialog.querySelector("#dialog-review-visible-count").textContent = `${rows.filter((row) => !row.hidden).length} of ${rows.length} cases shown; deterministic denominator unchanged`;
    return;
  }
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
  else if (event.target.name === "handbook-run") { ui.handbookRun = event.target.value; render(); document.querySelector('select[name="handbook-run"]')?.focus({ preventScroll: true }); return; }
  else return;
  ui.runPage = 1;
  updateRunResults();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k" && workspace && !gated()) {
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
dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeModal(); });
dialog.addEventListener("close", () => {
  if (!dialog.open) { modalContext = undefined; dialog.replaceChildren(); dialog.classList.remove("case-review"); }
  flushTrainingUpdates();
});
window.addEventListener("pagehide", closeModal);
render();
void account.refresh();
window.addEventListener("focus", () => { if (!account.busy) void account.refresh(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) void account.refresh(); });
const authResult = new URL(location.href);
if (authResult.searchParams.has("auth_error")) {
  const messages = {
    cancelled: "Sign-in was cancelled. Your workspace has not changed.",
    invalid_callback: "This sign-in link expired or did not match this browser. Start sign-in again.",
    exchange_failed: "WorkOS could not complete sign-in. Try again or ask the deployment owner to check its configuration.",
  };
  notify(messages[authResult.searchParams.get("auth_error")] || "Sign-in could not be completed. Try again.", true);
  authResult.searchParams.delete("auth_error");
  history.replaceState(null, "", authResult);
}
