import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { createAppServer } from "../server.mjs";
import { createWorkspace, createRun, recordProgress, STORAGE_KEY } from "../workspace.js";
import { DRAFT_KEY } from "../experience.js";

const server = createAppServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const screenshots = process.env.MAMASE_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const errors = [];
const external = [];
let browser;
let currentPage;
let layouts = 0;
const capture = async (page, name) => {
  if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true });
};
const watch = (page) => {
  currentPage = page;
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", (request) => {
    if (!request.url().startsWith(base) && !request.url().startsWith("blob:")) external.push(request.url());
  });
};
const go = async (page, path) => {
  await page.goto(`${base}/#/${path}`);
  await page.locator("#main").waitFor();
};
const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
const downloaded = async (page, locator) => {
  const waiting = page.waitForEvent("download");
  await locator.click();
  const download = await waiting;
  let value = "";
  for await (const chunk of await download.createReadStream()) value += chunk;
  return value;
};
const bounds = async (page, home = false) => {
  const result = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, viewport: innerWidth,
    heading: document.querySelector(".home-copy h1")?.getBoundingClientRect().toJSON(),
    actions: document.querySelector(".home-copy .actions")?.getBoundingClientRect().toJSON(),
    kicker: document.querySelector(".home-kicker")?.getBoundingClientRect().toJSON(),
    panel: document.querySelector(".home-panel")?.getBoundingClientRect().toJSON(),
    lastRun: document.querySelector(".recent-run:last-child")?.getBoundingClientRect().toJSON(),
  }));
  assert.equal(result.width, result.viewport, `Horizontal overflow at ${page.url()}: ${JSON.stringify(result)}`);
  if (home) {
    assert.ok(result.heading.bottom <= result.actions.top, `Hero/action overlap: ${JSON.stringify(result)}`);
    assert.ok(result.heading.top >= result.kicker.bottom, `Hero/kicker overlap: ${JSON.stringify(result)}`);
    if (result.lastRun) assert.ok(result.lastRun.bottom <= result.panel.bottom);
  }
  layouts++;
};

function fixture() {
  const workspace = createWorkspace();
  const createdAt = new Date().toISOString();
  workspace.datasets.push({
    id: "teacher-data", name: "Coven teacher examples", filename: "teacher.jsonl", records: 100, bytes: 4000,
    format: "prompt-response", kind: "teacher", teacher: "local/teacher", provenance: "Original licensed examples.",
    holdout: 10, sha256: "a".repeat(64), createdAt,
  });
  for (let index = 0; index < 45; index++) {
    const run = createRun({
      id: `run-${index}`, name: `Coven experiment ${String(index).padStart(2, "0")}`, createdAt,
      recipe: { method: "distillation", programId: "coven", datasetId: "teacher-data", student: "local/student",
        teacher: "local/teacher", rank: 16, alpha: 32, learningRate: 0.0002, epochs: 3, batchSize: 1,
        accumulation: 4, maxSequence: 2048, outputPath: `./outputs/run-${index}`, objective: "Improve held-out reasoning." },
    }, workspace);
    workspace.runs.push(index % 2 ? run : recordProgress(run, { status: "running", step: 3, totalSteps: run.totalSteps, loss: null, evalLoss: 1.25, note: "Validation-only observation.", recordedAt: createdAt }));
  }
  for (let index = 0; index < 2; index++) {
    workspace.artifacts.push({ id: `artifact-${index}`, name: `Coven adapter ${index}`, runId: `run-${index}`, kind: "adapter", path: `./models/adapter-${index}`, notes: "BF16 adapter; checkpoint step 3.", createdAt });
    workspace.evaluations.push({ id: `evaluation-${index}`, artifactId: `artifact-${index}`, benchmark: "Coven reasoning v1", score: 60 + 15 * index, maximum: 100, samples: 50, notes: "holdout-v1; seed=42; greedy; accuracy", createdAt });
  }
  workspace.evaluations.push({ ...workspace.evaluations[1], id: "evaluation-mismatch", benchmark: "Coven reasoning v2", samples: 20, notes: "Different holdout and protocol." });
  return workspace;
}

try {
  browser = await chromium.launch({ headless: true });
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", hasTouch: true });
  const page = await fresh.newPage();
  watch(page);
  await go(page, "settings");
  await page.getByLabel("Workspace name", { exact: true }).fill("Unsubmitted coven name");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  assert.equal(await page.locator("#main").evaluate((element) => element.inert), true);
  assert.equal(await page.locator(".sidebar").getAttribute("aria-modal"), "true");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByLabel("Workspace name", { exact: true }).inputValue(), "Unsubmitted coven name");
  assert.equal(await page.locator("#main").evaluate((element) => element.inert), false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  assert.equal(await page.getByLabel("Workspace name", { exact: true }).inputValue(), "Unsubmitted coven name");
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();

  await go(page, "playground");
  await page.getByLabel("Run name", { exact: true }).fill("Recovered recipe");
  await page.getByLabel("Training objective", { exact: true }).fill("Keep my experiment intact.");
  await page.reload();
  assert.equal(await page.getByLabel("Run name", { exact: true }).inputValue(), "Recovered recipe");
  await page.getByRole("button", { name: /Response distillation/ }).click();
  assert.equal(await page.evaluate(() => document.activeElement.dataset.method), "distillation");
  await page.getByRole("button", { name: /LoRA fine-tuning/ }).click();
  const hint = await page.getByLabel("Base model", { exact: true }).getAttribute("aria-describedby");
  assert.ok(await page.locator(`#${hint}`).isVisible());

  await page.getByRole("button", { name: "Import dataset", exact: true }).click();
  let modal = page.locator("#dialog");
  const ids = await page.locator("[id]").evaluateAll((elements) => elements.map((element) => element.id));
  assert.equal(new Set(ids).size, ids.length, "Modal and page field IDs must be unique");
  await modal.getByLabel("Dataset name", { exact: true }).fill("Imported from the lab");
  await modal.getByLabel("Provenance & permission", { exact: true }).fill("Original test data.");
  await modal.getByLabel("JSONL file", { exact: true }).setInputFiles({ name: "bad.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from("not json") });
  await modal.getByRole("button", { name: "Import dataset", exact: true }).click();
  await modal.getByText("Line 1: invalid JSON.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.className), "form-error");
  assert.equal(await stored(page), null, "A rejected import must not create stored workspace data");
  await modal.getByLabel("JSONL file", { exact: true }).setInputFiles({
    name: "valid.jsonl", mimeType: "application/x-ndjson",
    buffer: Buffer.from('{"prompt":"Question one","response":"Answer one"}\n{"prompt":"Question two","response":"Answer two"}'),
  });
  await page.evaluate(() => {
    window.originalFileText = File.prototype.text;
    File.prototype.text = function() {
      return new Promise((resolve, reject) => { window.releaseImport = () => window.originalFileText.call(this).then(resolve, reject); });
    };
  });
  await modal.getByRole("button", { name: "Import dataset", exact: true }).click();
  assert.equal(await modal.locator("form").getAttribute("aria-busy"), "true");
  assert.ok(await modal.getByRole("button", { name: "Importing…" }).isDisabled());
  await page.evaluate(() => { File.prototype.text = window.originalFileText; window.releaseImport(); });
  await modal.waitFor({ state: "hidden" });
  assert.equal(await page.getByLabel("Training objective", { exact: true }).inputValue(), "Keep my experiment intact.");
  assert.equal(await page.getByLabel("Training dataset", { exact: true }).inputValue(), (await stored(page)).datasets[0].id);
  await page.getByText("Ready to save a planned run. Training remains external.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Save planned run", exact: true }).click();
  await page.waitForURL(/sessions\/run-/);
  assert.equal((await stored(page)).runs[0].status, "planned");
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), DRAFT_KEY), null);
  await go(page, "playground");
  await page.evaluate(() => {
    window.originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "mamase.recipe-draft.v1") throw new DOMException("Draft storage blocked", "QuotaExceededError");
      return window.originalSetItem.call(this, key, value);
    };
  });
  await page.getByLabel("Run name", { exact: true }).fill("Unsaved draft");
  await page.getByText(/Draft is not saved:/).waitFor();
  await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; sessionStorage.setItem("mamase.recipe-draft.v1", "broken"); });
  await page.reload();
  await page.getByText(/Draft could not be restored:/).waitFor();
  await page.getByLabel("Run name", { exact: true }).fill("Do not overwrite recovery data");
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), DRAFT_KEY), "broken");
  assert.equal(await downloaded(page, page.getByRole("button", { name: "Download draft", exact: true })), "broken");
  await page.getByRole("button", { name: "Discard draft", exact: true }).click();
  await modal.getByRole("button", { name: "Discard draft", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), DRAFT_KEY), null);
  await fresh.close();

  const populated = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await populated.addInitScript((workspace) => {
    if (!localStorage.getItem("mamase.coven-lab.v1")) localStorage.setItem("mamase.coven-lab.v1", JSON.stringify(workspace));
  }, fixture());
  const lab = await populated.newPage();
  watch(lab);
  await go(lab, "datasets/teacher-data");
  await lab.getByRole("button", { name: "Use in a recipe", exact: true }).click();
  await lab.waitForURL("**/#/playground");
  assert.equal(await lab.getByLabel("Teacher model", { exact: true }).inputValue(), "local/teacher");
  assert.equal(await lab.getByLabel("Training dataset", { exact: true }).inputValue(), "teacher-data");
  await lab.getByLabel("Run name", { exact: true }).fill("Keep this draft");
  await go(lab, "sessions/run-1");
  await lab.getByRole("button", { name: "Duplicate recipe", exact: true }).click();
  modal = lab.locator("#dialog");
  await modal.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(await lab.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).draft.name, DRAFT_KEY), "Keep this draft");
  await lab.getByRole("button", { name: "Duplicate recipe", exact: true }).click();
  await modal.getByRole("button", { name: "Replace draft", exact: true }).click();
  await lab.waitForURL("**/#/playground");
  assert.equal(await lab.getByLabel("Local output directory", { exact: true }).inputValue(), "./outputs/run-1-copy");
  await lab.getByRole("button", { name: "Save planned run", exact: true }).click();
  await lab.waitForURL(/sessions\/run-/);
  const copy = (await stored(lab)).runs.at(-1);
  assert.equal(copy.status, "planned");
  assert.equal(copy.step, 0);
  assert.deepEqual(copy.history, []);

  await go(lab, "sessions");
  assert.equal(await lab.locator("tbody tr").count(), 20);
  await lab.getByRole("button", { name: "Next", exact: true }).click();
  assert.ok(lab.url().includes("page=2"));
  await lab.reload();
  await lab.getByText("Page 2 of 3", { exact: true }).waitFor();
  await lab.getByLabel("Status", { exact: true }).selectOption("running");
  await lab.getByLabel("Sort runs", { exact: true }).selectOption("name");
  await lab.getByLabel("Search runs", { exact: true }).fill("Coven experiment 0");
  await lab.getByText("5 of 46 runs match.", { exact: true }).waitFor();
  const filteredUrl = lab.url();
  await lab.reload();
  assert.equal(lab.url(), filteredUrl);
  assert.equal(await lab.getByLabel("Status", { exact: true }).inputValue(), "running");
  const csv = await downloaded(lab, lab.getByRole("button", { name: "Export CSV", exact: true }));
  assert.equal(csv.split("\r\n").length, 6);
  assert.ok(!csv.includes("Coven experiment 01"));
  await lab.getByLabel("Search runs", { exact: true }).fill("unmatched");
  await lab.getByRole("button", { name: "Show all runs", exact: true }).click();
  await lab.getByText("46 of 46 runs match.", { exact: true }).waitFor();

  await lab.keyboard.press("Control+k");
  await modal.getByLabel("Search records and views", { exact: true }).fill("Coven adapter 0");
  await lab.keyboard.press("Tab");
  assert.equal(await lab.evaluate(() => document.activeElement.getAttribute("href")), "#/checkpoints/artifact-0");
  await lab.keyboard.press("Enter");
  await lab.waitForURL("**/#/checkpoints/artifact-0");
  await lab.getByText("BF16 adapter; checkpoint step 3.", { exact: true }).waitFor();
  await lab.getByRole("button", { name: "Record evaluation", exact: true }).click();
  assert.equal(await modal.getByLabel("Model artifact", { exact: true }).inputValue(), "artifact-0");
  await modal.getByLabel("Benchmark & version", { exact: true }).fill("Coven reasoning v1");
  await modal.getByLabel("Score", { exact: true }).fill("80");
  await modal.getByLabel("Number of evaluated samples", { exact: true }).fill("50");
  await modal.getByLabel("Conditions & notes", { exact: true }).fill("holdout-v1; seed=42; greedy; accuracy");
  await modal.getByRole("button", { name: "Save evaluation", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
  await lab.getByText("80 / 100", { exact: true }).waitFor();
  const manifest = JSON.parse(await downloaded(lab, lab.getByRole("button", { name: "Manifest", exact: true })));
  assert.equal(manifest.artifact.id, "artifact-0");
  assert.equal(manifest.evaluations.length, 2);
  assert.equal(manifest.training.dataset.sha256, "a".repeat(64));
  await capture(lab, "artifact-lineage");

  await go(lab, "checkpoints");
  await lab.getByRole("button", { name: "Register artifact", exact: true }).click();
  await modal.getByLabel("Source run", { exact: true }).selectOption("run-0");
  assert.equal(await modal.getByLabel("Local file or directory path", { exact: true }).inputValue(), "./outputs/run-0");
  await modal.getByLabel("Local file or directory path", { exact: true }).fill("./custom/model");
  await modal.getByLabel("Source run", { exact: true }).selectOption("run-1");
  assert.equal(await modal.getByLabel("Local file or directory path", { exact: true }).inputValue(), "./custom/model");
  await lab.keyboard.press("Escape");
  await go(lab, "evaluations");
  await lab.getByLabel("Baseline evaluation", { exact: true }).selectOption("evaluation-0");
  await lab.getByLabel("Candidate evaluation", { exact: true }).selectOption("evaluation-1");
  await lab.getByText("+15.00 percentage points", { exact: true }).waitFor();
  await lab.getByLabel("Candidate evaluation", { exact: true }).selectOption("evaluation-0");
  await lab.getByText(/Choose two different evaluations/).waitFor();
  await lab.getByLabel("Candidate evaluation", { exact: true }).selectOption("evaluation-mismatch");
  await lab.getByText(/Benchmark and version differ/).waitFor();
  assert.equal(await lab.getByText("+15.00 percentage points", { exact: true }).count(), 0);
  await lab.getByLabel("Candidate evaluation", { exact: true }).selectOption("evaluation-1");
  await capture(lab, "evaluation-comparison");
  await go(lab, "sessions/run-0");
  assert.equal(await lab.locator(".loss-chart circle.validation-loss").count(), 1);
  assert.equal(await lab.locator(".loss-chart circle:not(.validation-loss)").count(), 0);
  await lab.getByText("View loss observations", { exact: true }).click();
  await lab.getByRole("region", { name: "Loss observations", exact: true }).getByText("Not recorded", { exact: true }).waitFor();
  await capture(lab, "validation-loss");

  for (const theme of ["dark", "light"]) {
    await lab.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844], [320, 640], [320, 568], [844, 390]]) {
      await lab.setViewportSize({ width, height });
      for (const path of ["home", "projects", "datasets/teacher-data", "sessions", "sessions/run-0", "checkpoints/artifact-0", "playground", "evaluations", "settings"]) {
        await go(lab, path);
        await bounds(lab, path === "home");
        if (path === "home" && height > 620) assert.equal(await lab.evaluate(() => document.documentElement.scrollHeight), height);
      }
      if (width === 320 && height === 568) {
        await go(lab, "home");
        await capture(lab, `short-home-${theme}`);
      }
    }
  }

  await lab.setViewportSize({ width: 390, height: 844 });
  await go(lab, "settings");
  await lab.getByLabel("Workspace name", { exact: true }).fill("Preserved during conflict");
  const other = await populated.newPage();
  await go(other, "settings");
  await other.getByLabel("Workspace name", { exact: true }).fill("Newer workspace");
  await other.getByRole("button", { name: "Save name", exact: true }).click();
  await lab.getByText("This workspace changed in another tab.", { exact: true }).waitFor();
  assert.equal(await lab.getByLabel("Workspace name", { exact: true }).inputValue(), "Preserved during conflict");
  await lab.getByRole("button", { name: "Save name", exact: true }).click();
  await lab.getByText(/This workspace changed while you were editing/).waitFor();
  assert.equal((await stored(lab)).name, "Newer workspace");
  await lab.getByRole("button", { name: "Reload workspace", exact: true }).click();
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await lab.getByLabel("Workspace name", { exact: true }).inputValue(), "Preserved during conflict");
  await go(lab, "home");
  await bounds(lab, true);
  await lab.getByRole("button", { name: "Reload workspace", exact: true }).click();
  await modal.getByRole("button", { name: "Reload latest data", exact: true }).click();
  await lab.locator("#main").waitFor();
  assert.ok(await lab.locator("#workspace-alert").isHidden());
  await other.close();
  await populated.close();
  const longContent = fixture();
  longContent.name = "W".repeat(80);
  longContent.programs[0].name = "P".repeat(100);
  longContent.datasets[0].name = "D".repeat(100);
  longContent.datasets[0].teacher = "T".repeat(200);
  for (const run of longContent.runs) {
    run.name = "R".repeat(100);
    run.recipe.student = "M".repeat(200);
    run.recipe.teacher = longContent.datasets[0].teacher;
    run.recipe.objective = "O".repeat(2000);
  }
  for (const artifact of longContent.artifacts) { artifact.name = "A".repeat(100); artifact.notes = "N".repeat(2000); }
  for (const theme of ["dark", "light"]) {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme: theme });
    await context.addInitScript((data) => localStorage.setItem("mamase.coven-lab.v1", JSON.stringify(data)), longContent);
    const page = await context.newPage();
    watch(page);
    for (const path of ["home", "projects", "datasets/teacher-data", "sessions", "sessions/run-0", "checkpoints/artifact-0", "playground", "evaluations", "settings"]) {
      await go(page, path);
      await bounds(page, path === "home");
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(`UX end-to-end passed: 11 enhancement journeys, ${layouts} responsive layouts, recoverable drafts, atomic imports, matching CSV exports, artifact lineage, guarded comparisons, loss accessibility and conflict recovery.`);
} catch (error) {
  if (currentPage && !currentPage.isClosed()) await capture(currentPage, "failure");
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
