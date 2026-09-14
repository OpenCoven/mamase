import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { createAppServer } from "../server.mjs";
import { createAuthApi } from "../auth-api.mjs";
import { createWorkspace, createRun, recordProgress, STORAGE_KEY } from "../workspace.js";
import { DRAFT_KEY } from "../experience.js";
import { MAX_BACKUP_BYTES } from "../backups.js";
import { verifyReviewUx } from "./verify-review-ux.mjs";
import { contrastRatio, writeFailureEvidence } from "./ux-evidence.mjs";

const server = createAppServer({ auth: createAuthApi({ env: {} }) });
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
let contrastChecks = 0;
const newContext = async (options = {}) => {
  const context = await browser.newContext({ ...options, serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base || url.protocol === "blob:") return route.continue();
    external.push("Blocked non-loopback request");
    return route.abort("blockedbyclient");
  });
  return context;
};
const capture = async (page, name) => {
  if (screenshots) {
    await page.locator("#toast").waitFor({ state: "hidden" });
    await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true, animations: "disabled" });
  }
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
    lastRun: [...document.querySelectorAll(".recent-run")].filter((item) => item.getClientRects().length).at(-1)?.getBoundingClientRect().toJSON(),
  }));
  assert.equal(result.width, result.viewport, `Horizontal overflow at ${page.url()}: ${JSON.stringify(result)}`);
  if (home) {
    assert.ok(result.heading.bottom <= result.actions.top, `Hero/action overlap: ${JSON.stringify(result)}`);
    assert.ok(result.heading.top >= result.kicker.bottom, `Hero/kicker overlap: ${JSON.stringify(result)}`);
    if (result.lastRun) assert.ok(result.lastRun.bottom <= result.panel.bottom);
  }
  layouts++;
};

const contrast = async (page) => {
  const pairs = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    document.body.append(probe);
    const color = (token) => {
      probe.style.color = root.getPropertyValue(token);
      return getComputedStyle(probe).color;
    };
    const pairs = [
      ["body", "--ink", "--page"], ["help", "--muted", "--wash"],
      ["secondary", "--secondary", "--surface"], ["placeholder", "--placeholder", "--surface"],
      ["regression", "--danger-ink", "--surface"], ["warning", "--warning-ink", "--surface"],
      ["focus", "--focus", "--page", 3], ["focus surface", "--focus", "--surface", 3],
    ].map(([label, fg, bg, minimum = 4.5]) => ({ label, fg: color(fg), bg: color(bg), minimum }));
    probe.remove();
    for (const element of document.querySelectorAll(".badge, .button.primary")) {
      if (!element.checkVisibility()) continue;
      const style = getComputedStyle(element);
      pairs.push({ label: element.className, fg: style.color, bg: style.backgroundColor, minimum: 4.5 });
    }
    return pairs;
  });
  for (const { label, fg, bg, minimum } of pairs) {
    assert.ok(contrastRatio(fg, bg) >= minimum, `${label}: ${fg} on ${bg} must meet ${minimum}:1`);
    contrastChecks++;
  }
};

const keyboardActivate = async (page, target) => {
  await target.waitFor({ state: "visible" });
  for (let index = 0; index < 120; index++) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      // Wide data tables are keyboard-scrollable regions; Tab alone may expose only part of a cell.
      for (let scroll = 0; scroll < 30; scroll++) {
        const direction = await target.evaluate((element) => {
          const region = element.closest(".table-scroll");
          if (!region) return null;
          const box = element.getBoundingClientRect();
          const clip = region.getBoundingClientRect();
          return box.right > clip.right - 6 ? "ArrowRight" : box.left < clip.left + 6 ? "ArrowLeft" : null;
        });
        if (!direction) break;
        await page.keyboard.press(direction, { delay: 100 });
      }
      await page.waitForFunction(() => {
        const box = document.activeElement.getBoundingClientRect();
        return box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
      }, null, { timeout: 2000 });
      const box = await target.boundingBox();
      const viewport = page.viewportSize();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1, `Keyboard action must scroll fully into the viewport: ${JSON.stringify({ box, viewport })}`);
      assert.equal(await target.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
      await page.keyboard.press("Enter");
      return;
    }
    await page.keyboard.press("Tab");
  }
  assert.fail("Core action was unreachable by Tab");
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
        familiarId: "cody", instanceId: "test-coven", adapter: "lora",
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
  const fresh = await newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", hasTouch: true });
  const page = await fresh.newPage();
  watch(page);
  await go(page, "settings");
  if (process.argv.includes("--failure-fixture")) assert.fail("Deliberate synthetic failure for evidence verification");
  assert.equal(await page.locator(".sidebar [data-theme-value]").count(), 0);
  assert.equal(await page.locator("html").getAttribute("data-theme-preference"), "system");
  const appearance = page.getByRole("group", { name: "Appearance mode", exact: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await appearance.getByRole("button", { name: "Dark", exact: true }).click();
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await appearance.getByRole("button", { name: "Dark", exact: true }).getAttribute("aria-pressed"), "true");
  await appearance.getByRole("button", { name: "System", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
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
  await page.getByLabel("Base model", { exact: true }).fill("/local/model");
  await page.locator("#recipe-advanced > summary").click();
  for (const label of ["Familiar ID", "Coven instance ID"]) {
    const input = page.getByLabel(label, { exact: true });
    await input.fill("invalid id");
    assert.equal(await input.evaluate((element) => element.validity.patternMismatch), true);
    await input.fill("valid-id_1");
    assert.equal(await input.evaluate((element) => element.validity.valid), true);
  }
  await page.getByLabel("Familiar ID", { exact: true }).fill("cody");
  await page.getByLabel("Coven instance ID", { exact: true }).fill("test-coven");
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
  await page.getByText("Ready to save your recipe. Training has not started.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Save recipe & review", exact: true }).click();
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
  await page.evaluate((key) => localStorage.setItem(key, "invalid workspace"), STORAGE_KEY);
  await page.reload();
  await go(page, "settings");
  await page.reload();
  await page.getByRole("heading", { name: "Workspace needs attention", exact: true }).waitFor();
  await page.getByRole("group", { name: "Appearance mode", exact: true }).getByRole("button", { name: "Light", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  assert.equal(await page.locator(".sidebar [data-theme-value]").count(), 0);
  await fresh.close();

  const pairedData = fixture();
  pairedData.runs = [pairedData.runs[1]];
  pairedData.artifacts = [];
  pairedData.evaluations = [];
  const pairedContext = await newContext({ viewport: { width: 1440, height: 900 } });
  await pairedContext.addInitScript((data) => {
    if (!localStorage.getItem("mamase.coven-lab.v1")) localStorage.setItem("mamase.coven-lab.v1", JSON.stringify(data));
  }, pairedData);
  const pairedPage = await pairedContext.newPage();
  watch(pairedPage);
  await go(pairedPage, "sessions/run-1");
  const importJson = async (data, label = "Import") => {
    const modal = pairedPage.locator("#dialog");
    await modal.getByLabel("JSON file", { exact: true }).setInputFiles({
      name: "synthetic-report.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)),
    });
    await modal.getByRole("button", { name: label, exact: true }).click();
  };
  const recordedAt = new Date().toISOString();
  const progressUpdates = [
    { status: "running", step: 0, totalSteps: 2, loss: null, evalLoss: 2, note: "Synthetic browser fixture", recordedAt },
    { status: "running", step: 1, totalSteps: 2, loss: 1.8, evalLoss: null, note: "Synthetic browser fixture", recordedAt: new Date(Date.parse(recordedAt) + 1).toISOString() },
    { status: "completed", step: 2, totalSteps: 2, loss: 1, evalLoss: 1.5, note: "Synthetic browser fixture", recordedAt: new Date(Date.parse(recordedAt) + 2).toISOString() },
  ];
  const progressReport = (updates) => ({ schema: "mamase.run-report.v1", runId: "run-1", updates });
  const previewReport = async (updates) => {
    await pairedPage.getByRole("button", { name: "Import report", exact: true }).click();
    await importJson(progressReport(updates), "Preview report");
    await pairedPage.locator("#dialog-report-summary").waitFor();
  };
  const reportModal = pairedPage.locator("#dialog");
  const untouched = await stored(pairedPage);
  await previewReport(progressUpdates.slice(0, 1));
  assert.match(await reportModal.locator("#dialog-report-summary").textContent(), /1 new.*0 duplicates.*0 conflicts/);
  assert.equal(await pairedPage.evaluate(() => document.activeElement.id), "dialog-title");
  await pairedPage.setViewportSize({ width: 390, height: 844 });
  await bounds(pairedPage);
  assert.deepEqual(await stored(pairedPage), untouched, "Preview must not persist observations");
  await pairedPage.keyboard.press("Escape");
  await pairedPage.setViewportSize({ width: 1440, height: 900 });
  assert.deepEqual(await stored(pairedPage), untouched, "Cancelling a preview must leave storage unchanged");

  await pairedPage.getByRole("button", { name: "Import report", exact: true }).click();
  await pairedPage.evaluate(() => {
    window.originalReportText = File.prototype.text;
    File.prototype.text = function() {
      return new Promise((resolve, reject) => { window.releaseReport = () => window.originalReportText.call(this).then(resolve, reject); });
    };
  });
  await importJson(progressReport(progressUpdates.slice(0, 1)), "Preview report");
  await pairedPage.waitForFunction(() => typeof window.releaseReport === "function");
  await pairedPage.keyboard.press("Escape");
  await pairedPage.evaluate(() => { File.prototype.text = window.originalReportText; window.releaseReport(); });
  await pairedPage.locator("#toast").getByText(/form was closed/).waitFor();
  assert.deepEqual(await stored(pairedPage), untouched, "An aborted file read must not reopen a preview or save");
  assert.equal(await reportModal.isVisible(), false);

  await previewReport(progressUpdates.slice(0, 1));
  await reportModal.getByRole("button", { name: "Import new observations", exact: true }).click();
  await reportModal.waitFor({ state: "hidden" });
  const partialReport = await stored(pairedPage);
  assert.deepEqual(partialReport.runs[0].history, progressUpdates.slice(0, 1));
  await pairedPage.evaluate(() => {
    window.originalReportSetItem = Storage.prototype.setItem;
    window.reportWriteAttempts = 0;
    Storage.prototype.setItem = function(key, value) {
      if (key === "mamase.coven-lab.v1") {
        window.reportWriteAttempts++;
        throw new DOMException("Synthetic full storage", "QuotaExceededError");
      }
      return window.originalReportSetItem.call(this, key, value);
    };
  });
  await previewReport(progressUpdates.slice(0, 1));
  assert.match(await reportModal.locator("#dialog-report-summary").textContent(), /0 new.*1 duplicates.*0 conflicts/);
  await reportModal.getByRole("button", { name: "Keep existing history", exact: true }).click();
  await reportModal.waitFor({ state: "hidden" });
  assert.equal(await pairedPage.evaluate(() => window.reportWriteAttempts), 0, "Duplicate-only imports must not write storage");
  assert.deepEqual(await stored(pairedPage), partialReport);

  await previewReport(progressUpdates.slice(0, 2));
  assert.match(await reportModal.locator("#dialog-report-summary").textContent(), /1 new.*1 duplicates.*0 conflicts/);
  await reportModal.getByRole("button", { name: "Import new observations", exact: true }).click();
  await reportModal.getByText(/Browser storage is full/).waitFor();
  assert.deepEqual(await stored(pairedPage), partialReport, "Quota failures must preserve the partial journal");
  assert.ok(await reportModal.getByRole("button", { name: "Export open workspace", exact: true }).isVisible());
  await pairedPage.evaluate(() => { Storage.prototype.setItem = window.originalReportSetItem; });
  await reportModal.getByRole("button", { name: "Import new observations", exact: true }).click();
  await reportModal.waitFor({ state: "hidden" });
  assert.deepEqual((await stored(pairedPage)).runs[0].history, progressUpdates.slice(0, 2));

  await previewReport(progressUpdates);
  const otherTab = await pairedContext.newPage();
  await go(otherTab, "settings");
  await otherTab.evaluate((key) => {
    const latest = JSON.parse(localStorage.getItem(key));
    latest.name = "Concurrent report workspace";
    localStorage.setItem(key, JSON.stringify(latest));
  }, STORAGE_KEY);
  const concurrentReport = await stored(pairedPage);
  await reportModal.getByRole("button", { name: "Import new observations", exact: true }).click();
  await reportModal.getByText(/workspace changed while you were editing/).waitFor();
  assert.deepEqual(await stored(pairedPage), concurrentReport, "Confirmation must use the preview's original snapshot");
  await reportModal.getByRole("button", { name: "Reload workspace", exact: true }).click();
  await reportModal.getByRole("button", { name: "Reload latest data", exact: true }).click();
  await reportModal.waitFor({ state: "hidden" });
  await otherTab.close();
  await previewReport(progressUpdates);
  assert.match(await reportModal.locator("#dialog-report-summary").textContent(), /1 new.*2 duplicates.*0 conflicts/);
  await reportModal.getByRole("button", { name: "Import new observations", exact: true }).click();
  await reportModal.waitFor({ state: "hidden" });
  const completedReport = await stored(pairedPage);
  assert.equal(completedReport.name, "Concurrent report workspace");
  assert.deepEqual(completedReport.runs[0].history, progressUpdates);
  await previewReport([progressUpdates[0], { ...progressUpdates[1], loss: 0.5 }, progressUpdates[2]]);
  assert.match(await reportModal.locator("#dialog-report-summary").textContent(), /0 new.*2 duplicates.*1 conflicts/);
  assert.equal(await reportModal.getByRole("button", { name: "Import new observations", exact: true }).count(), 0);
  assert.deepEqual(await stored(pairedPage), completedReport, "Competing closed-run evidence must not replace history");
  await pairedPage.keyboard.press("Escape");
  await previewReport(progressUpdates);
  await reportModal.getByRole("button", { name: "Keep existing history", exact: true }).click();
  await reportModal.waitFor({ state: "hidden" });
  assert.deepEqual(await stored(pairedPage), completedReport, "Closed-run replays must be visible no-ops");
  const hash = (letter) => letter.repeat(64);
  const trainingResult = {
    schema: "mamase.training-result.v1", runId: "run-1", bundleSha256: hash("c"),
    familiar: { familiarId: "cody", instanceId: "test-coven" },
    baseModel: { label: "local/student", localPath: "/synthetic/model", files: { "model.safetensors": hash("d") } },
    adapter: { path: "/synthetic/bundle/adapter", technique: "lora", files: { "adapter_model.safetensors": hash("f"), "adapter_config.json": hash("a") } },
    datasetSha256: hash("a"), holdoutSha256: hash("d"), optimizerSteps: 2,
    evaluation: { metric: "completion-token-weighted-negative-log-likelihood", samples: 10, baseLoss: 2, adapterLoss: 1.5, delta: -0.5 },
    trainableParameters: 100, totalParameters: 1000, promotion: "not-authorized",
    familiarContext: {
      schema: "mamase.familiar-context-summary.v1", sha256: hash("a"), scope: "selected-sources",
      familiarId: "cody", instanceId: "test-coven", lane: "coding", role: "Synthetic code familiar",
      promptSha256: hash("b"), sourceRoles: ["identity", "soul", "role"],
    },
  };
  await pairedPage.getByRole("button", { name: "Import training result", exact: true }).click();
  await importJson(trainingResult);
  await pairedPage.waitForURL("**/#/checkpoints");
  await pairedPage.getByText("/synthetic/bundle/adapter", { exact: true }).waitFor();
  await pairedPage.getByText(/Holdout loss: 2.0000 base/).waitFor();
  await pairedPage.getByText(/Selected sources \(3\)/).waitFor();
  const pairedReport = {
    schema: "mamase.evaluation-report.v1", runId: "run-1", createdAt: recordedAt,
    resultSha256: createHash("sha256").update(JSON.stringify(trainingResult)).digest("hex"),
    bundleSha256: hash("c"), datasetSha256: hash("a"), familiar: trainingResult.familiar,
    familiarContext: trainingResult.familiarContext,
    adapterPath: trainingResult.adapter.path, suite: { name: "Synthetic browser regressions", version: "1", sha256: hash("f") },
    decoding: { doSample: false, numBeams: 1, maxNewTokens: 16, seed: 42 }, device: "cpu", promotion: "not-authorized",
    cases: ["task", "identity", "consent", "tool-boundary"].map((category, index) => ({
      id: category, category, prompt: `private synthetic ${category} prompt`, checks: [{ type: "equals", value: "pass" }],
      base: { response: index % 2 === 0 ? "pass" : "fail", passed: index % 2 === 0 },
      adapter: { response: index === 1 || index === 2 ? "pass" : "fail", passed: index === 1 || index === 2 },
    })),
    summary: { samples: 4, basePassed: 2, adapterPassed: 2, regressions: 1 },
  };
  await go(pairedPage, "evaluations");
  await pairedPage.getByRole("button", { name: "Import paired report", exact: true }).click();
  const beforeInvalid = await stored(pairedPage);
  await importJson({ ...pairedReport, summary: { ...pairedReport.summary, adapterPassed: 4 } });
  await pairedPage.locator("#dialog .form-error").waitFor({ state: "visible" });
  assert.deepEqual(await stored(pairedPage), beforeInvalid);
  await pairedPage.keyboard.press("Escape");
  for (const dismiss of [false, true]) {
    await pairedPage.getByRole("button", { name: "Import paired report", exact: true }).click();
    await reportModal.getByLabel("JSON file", { exact: true }).setInputFiles({
      name: "synthetic-malformed-report.json", mimeType: "application/json",
      buffer: Buffer.from("RAWCASE-CANARY is malformed synthetic JSON"),
    });
    await pairedPage.evaluate(() => {
      window.originalMalformedRead = File.prototype.text;
      window.pendingMalformedForm = document.querySelector('[data-form="paired-evaluation"]');
      File.prototype.text = function() {
        return new Promise((resolve, reject) => { window.releaseMalformedRead = () => window.originalMalformedRead.call(this).then(resolve, reject); });
      };
    });
    await reportModal.getByRole("button", { name: "Import", exact: true }).click();
    await pairedPage.waitForFunction(() => typeof window.releaseMalformedRead === "function");
    if (dismiss) {
      await pairedPage.keyboard.press("Escape");
      await pairedPage.getByRole("button", { name: "Import paired report", exact: true }).click();
    }
    await pairedPage.evaluate(() => {
      File.prototype.text = window.originalMalformedRead;
      window.releaseMalformedRead();
    });
    await pairedPage.waitForFunction(() => !window.pendingMalformedForm.hasAttribute("aria-busy"));
    assert.ok(!(await pairedPage.locator("body").textContent()).includes("RAWCASE"), "Malformed paired JSON must never copy file excerpts into the DOM");
    assert.deepEqual(await stored(pairedPage), beforeInvalid);
    if (dismiss) {
      await pairedPage.locator("#toast").getByText(/form was closed.*No changes were made/).waitFor();
      assert.equal(await reportModal.locator(".form-error").isVisible(), false);
    } else await reportModal.getByText("The report contains invalid JSON. No changes were made.", { exact: true }).waitFor();
    assert.equal(await reportModal.locator('[type="submit"]').isEnabled(), true);
    await pairedPage.keyboard.press("Escape");
    await pairedPage.evaluate(() => {
      delete window.pendingMalformedForm;
      delete window.releaseMalformedRead;
      delete window.originalMalformedRead;
    });
  }
  for (const method of ["text", "arrayBuffer"]) {
    await pairedPage.getByRole("button", { name: "Import paired report", exact: true }).click();
    await pairedPage.evaluate((method) => {
      window.originalPairedRead = File.prototype[method];
      File.prototype[method] = function() {
        return new Promise((resolve, reject) => { window.releasePairedRead = () => window.originalPairedRead.call(this).then(resolve, reject); });
      };
    }, method);
    await importJson(pairedReport);
    await pairedPage.waitForFunction(() => typeof window.releasePairedRead === "function");
    assert.equal(await reportModal.locator("form").getAttribute("aria-busy"), "true");
    await pairedPage.keyboard.press("Escape");
    assert.equal(await pairedPage.getByRole("button", { name: "Import paired report", exact: true }).evaluate((element) => element === document.activeElement), true);
    // Reopening must not allow the previous detached form to save or close the new dialog.
    await pairedPage.getByRole("button", { name: "Import paired report", exact: true }).click();
    await pairedPage.evaluate((method) => {
      File.prototype[method] = window.originalPairedRead;
      window.releasePairedRead();
      delete window.releasePairedRead;
    }, method);
    await pairedPage.locator("#toast").getByText(/form was closed.*No changes were made/).waitFor();
    assert.equal(await pairedPage.locator("#toast").getAttribute("role"), "alert");
    assert.equal(await pairedPage.locator("#toast").getAttribute("aria-live"), "assertive");
    assert.deepEqual(await stored(pairedPage), beforeInvalid, `Interrupted paired ${method} read must preserve exact workspace`);
    assert.equal(await reportModal.isVisible(), true);
    assert.equal(await reportModal.locator('[type="submit"]').isEnabled(), true);
    await pairedPage.keyboard.press("Escape");
  }
  await pairedPage.getByRole("button", { name: "Import paired report", exact: true }).click();
  await importJson({ ...pairedReport, familiarContext: { ...pairedReport.familiarContext, sha256: hash("f") } });
  await pairedPage.locator("#dialog .form-error").waitFor({ state: "visible" });
  assert.match(await pairedPage.locator("#dialog .form-error").textContent(), /familiar context/i);
  assert.deepEqual(await stored(pairedPage), beforeInvalid);
  await importJson(pairedReport);
  await pairedPage.locator("#dialog").waitFor({ state: "hidden" });
  await pairedPage.getByText("2 → 2 / 4", { exact: true }).waitFor();
  await pairedPage.getByText("1 regressed", { exact: true }).waitFor();
  const beforeKeyboardJourneys = await stored(pairedPage);
  for (const [preference, system] of [["light", "dark"], ["dark", "light"], ["system", "light"], ["system", "dark"]]) {
    await go(pairedPage, "settings");
    await pairedPage.emulateMedia({ colorScheme: system });
    await pairedPage.getByRole("group", { name: "Appearance mode", exact: true })
      .getByRole("button", { name: preference[0].toUpperCase() + preference.slice(1), exact: true }).click();
    await pairedPage.waitForFunction((theme) => document.documentElement.dataset.theme === theme, preference === "system" ? system : preference);
    await go(pairedPage, "evaluations");
    await pairedPage.getByText("1 regressed", { exact: true }).waitFor();
    assert.match(await pairedPage.locator("main").ariaSnapshot(), /1 regressed/);
    await contrast(pairedPage);
    for (const [width, height] of [[320, 568], [760, 800], [1440, 900], [844, 390]]) {
      await pairedPage.setViewportSize({ width, height });
      await bounds(pairedPage);
      await keyboardActivate(pairedPage, pairedPage.getByRole("button", { name: "Import paired report", exact: true }));
      await reportModal.getByLabel("JSON file", { exact: true }).waitFor();
      await keyboardActivate(pairedPage, reportModal.getByRole("button", { name: "Close dialog", exact: true }));
      await keyboardActivate(pairedPage, pairedPage.locator('[data-action="evaluation-details"]'));
      await reportModal.getByText("tool-boundary", { exact: true }).waitFor();
      await pairedPage.keyboard.press("Escape");
      await go(pairedPage, "settings");
      const download = pairedPage.waitForEvent("download");
      await keyboardActivate(pairedPage, pairedPage.getByRole("button", { name: "Export workspace", exact: true }));
      await download;
      await go(pairedPage, "sessions/run-1");
      await keyboardActivate(pairedPage, pairedPage.getByRole("button", { name: "Import report", exact: true }));
      await pairedPage.keyboard.press("Escape");
      await go(pairedPage, "checkpoints");
      await keyboardActivate(pairedPage, pairedPage.getByRole("button", { name: "Import training result", exact: true }));
      await pairedPage.keyboard.press("Escape");
      await go(pairedPage, "playground");
      await keyboardActivate(pairedPage, pairedPage.getByRole("button", { name: "Import dataset", exact: true }));
      await pairedPage.keyboard.press("Escape");
      await keyboardActivate(pairedPage, pairedPage.getByRole("button", { name: "Save recipe & review", exact: true }));
      assert.match(pairedPage.url(), /#\/playground$/, "Invalid recipe cannot save; its action remains reachable");
      await go(pairedPage, "evaluations");
    }
  }
  assert.deepEqual(await stored(pairedPage), beforeKeyboardJourneys, "Keyboard review and cancelled core actions must not mutate evidence");
  await pairedPage.setViewportSize({ width: 1440, height: 900 });
  await pairedPage.locator('[data-action="evaluation-details"]').click();
  await pairedPage.locator("#dialog").getByText("tool-boundary", { exact: true }).waitFor();
  await pairedPage.locator("#dialog").getByText("Suite SHA-256", { exact: true }).waitFor();
  await pairedPage.locator("#dialog").getByText(/Familiar context: Selected sources/).waitFor();
  for (const width of [320, 760, 1440]) {
    await pairedPage.setViewportSize({ width, height: 720 });
    await bounds(pairedPage);
  }
  await pairedPage.keyboard.press("Escape");
  await go(pairedPage, "settings");
  const pairedBackup = await downloaded(pairedPage, pairedPage.getByRole("button", { name: "Export workspace", exact: true }));
  assert.ok(!pairedBackup.includes("private synthetic") && !pairedBackup.includes('"cases"') && !pairedBackup.includes('"response"'));
  assert.equal(JSON.parse(pairedBackup).schema, "mamase.workspace-backup.v1");
  assert.equal(JSON.parse(pairedBackup).workspace.evaluations[0].comparison.regressions, 1);
  assert.deepEqual(JSON.parse(pairedBackup).workspace.evaluations[0].comparison.familiarContext, trainingResult.familiarContext);
  const backupWorkspace = await stored(pairedPage);
  await pairedPage.getByRole("group", { name: "Appearance mode", exact: true }).getByRole("button", { name: "Light", exact: true }).click();
  const chooseBackup = async (source) => {
    await pairedPage.getByRole("button", { name: "Restore backup", exact: true }).click();
    await reportModal.getByLabel("Workspace JSON backup", { exact: true }).setInputFiles({
      name: "synthetic-backup.json", mimeType: "application/json", buffer: Buffer.from(source),
    });
    await reportModal.getByRole("button", { name: "Preview backup", exact: true }).click();
  };
  for (const source of [
    "broken JSON",
    JSON.stringify({ ...JSON.parse(pairedBackup), schema: "mamase.workspace-backup.v99" }),
    JSON.stringify({ ...backupWorkspace, runs: [{ ...backupWorkspace.runs[0], step: 0 }] }),
    " ".repeat(MAX_BACKUP_BYTES + 1),
  ]) {
    await chooseBackup(source);
    await reportModal.locator(".form-error").waitFor({ state: "visible" });
    assert.deepEqual(await stored(pairedPage), backupWorkspace, "Rejected backups must preserve saved evidence");
    await pairedPage.keyboard.press("Escape");
  }
  await chooseBackup(pairedBackup);
  await reportModal.locator("#dialog-restore-summary").waitFor();
  await reportModal.getByText("mamase.workspace-backup.v1", { exact: true }).waitFor();
  assert.equal(await reportModal.getByRole("region", { name: "Workspace restore collection counts" }).getByRole("row").count(), 6);
  assert.equal(await reportModal.locator("form").evaluate((form) => form.checkValidity()), false);
  await pairedPage.setViewportSize({ width: 390, height: 844 });
  await bounds(pairedPage);
  assert.deepEqual(await stored(pairedPage), backupWorkspace);
  await pairedPage.keyboard.press("Escape");
  await pairedPage.setViewportSize({ width: 1440, height: 900 });
  assert.deepEqual(await stored(pairedPage), backupWorkspace, "Cancelling restore preview must not replace data");

  await pairedPage.evaluate(() => {
    window.originalRestoreText = File.prototype.text;
    File.prototype.text = function() {
      return new Promise((resolve, reject) => { window.releaseRestore = () => window.originalRestoreText.call(this).then(resolve, reject); });
    };
  });
  await chooseBackup(pairedBackup);
  await pairedPage.waitForFunction(() => typeof window.releaseRestore === "function");
  await pairedPage.keyboard.press("Escape");
  await pairedPage.evaluate(() => { File.prototype.text = window.originalRestoreText; window.releaseRestore(); });
  await pairedPage.locator("#toast").getByText(/form was closed/).waitFor();
  assert.equal(await reportModal.isVisible(), false);
  assert.deepEqual(await stored(pairedPage), backupWorkspace, "Interrupted restore reads must not save or reopen a dialog");

  const legacyBackup = { ...backupWorkspace, name: "Restored legacy workspace" };
  await chooseBackup(JSON.stringify(legacyBackup));
  await reportModal.getByText("legacy-workspace-v1", { exact: true }).waitFor();
  await reportModal.getByRole("checkbox").check();
  await pairedPage.evaluate(() => {
    window.originalRestoreSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "mamase.coven-lab.v1") throw new DOMException("Synthetic full storage", "QuotaExceededError");
      return window.originalRestoreSetItem.call(this, key, value);
    };
  });
  await reportModal.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await reportModal.getByText(/Browser storage is full/).waitFor();
  assert.deepEqual(await stored(pairedPage), backupWorkspace);
  const recoveryBackup = await downloaded(pairedPage, reportModal.getByRole("button", { name: "Export open workspace", exact: true }));
  assert.deepEqual(JSON.parse(recoveryBackup).workspace, backupWorkspace);
  await pairedPage.evaluate(() => { Storage.prototype.setItem = window.originalRestoreSetItem; });
  await reportModal.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await reportModal.waitFor({ state: "hidden" });
  await pairedPage.waitForURL("**/#/home");
  assert.deepEqual(await stored(pairedPage), legacyBackup);
  assert.equal(await pairedPage.locator("html").getAttribute("data-theme-preference"), "light");
  await go(pairedPage, "settings");

  await chooseBackup(pairedBackup);
  await reportModal.locator("#dialog-restore-summary").waitFor();
  const restoreTab = await pairedContext.newPage();
  await go(restoreTab, "settings");
  await restoreTab.evaluate((key) => {
    const latest = JSON.parse(localStorage.getItem(key));
    latest.name = "Newer restore workspace";
    localStorage.setItem(key, JSON.stringify(latest));
  }, STORAGE_KEY);
  const newerBackupWorkspace = await stored(pairedPage);
  await reportModal.getByRole("checkbox").check();
  await reportModal.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await reportModal.getByText(/workspace changed while you were editing/).waitFor();
  assert.deepEqual(await stored(pairedPage), newerBackupWorkspace);
  await reportModal.getByRole("button", { name: "Reload workspace", exact: true }).click();
  await reportModal.getByRole("button", { name: "Reload latest data", exact: true }).click();
  await reportModal.waitFor({ state: "hidden" });
  await restoreTab.close();
  await chooseBackup(pairedBackup);
  await reportModal.getByRole("checkbox").check();
  await reportModal.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await reportModal.waitFor({ state: "hidden" });
  assert.deepEqual(await stored(pairedPage), backupWorkspace);
  assert.equal(await pairedPage.locator("html").getAttribute("data-theme-preference"), "light");

  await pairedPage.evaluate((key) => localStorage.setItem(key, "corrupt workspace retained for recovery"), STORAGE_KEY);
  await pairedPage.reload();
  await pairedPage.getByRole("heading", { name: "Workspace needs attention", exact: true }).waitFor();
  await chooseBackup(pairedBackup);
  await reportModal.locator("#dialog-restore-summary").waitFor();
  assert.equal(await downloaded(pairedPage, reportModal.getByRole("button", { name: "Download stored data", exact: true })), "corrupt workspace retained for recovery");
  await reportModal.getByRole("checkbox").check();
  await reportModal.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await reportModal.waitFor({ state: "hidden" });
  assert.deepEqual(await stored(pairedPage), backupWorkspace);
  assert.equal(await pairedPage.locator("html").getAttribute("data-theme-preference"), "light");
  await pairedContext.close();
  await verifyReviewUx({ newContext, base, watch, downloaded, bounds });

  const populated = await newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
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
  const preflightCommand = ".venv/bin/python training/preflight.py --bundle .lab/experiment --model /path/local-model --device cpu";
  const runInstructions = lab.locator("#external-training-guide");
  await runInstructions.waitFor({ state: "visible" });
  await runInstructions.locator("summary").click();
  const commands = await runInstructions.locator("pre").allTextContents();
  assert.ok(commands.includes(preflightCommand));
  assert.ok(commands.indexOf(preflightCommand) < commands.findIndex((command) => command.includes("training/train.py")));
  assert.match(await runInstructions.textContent(), /mamase\.preflight\.v1/);
  assert.match(await runInstructions.textContent(), /not preflight managed MLX jobs/);
  const beforeHandbook = await stored(lab);
  await go(lab, "resources");
  const preflightCard = lab.locator("article.card").filter({ has: lab.getByRole("heading", { name: "Check before loading weights.", exact: true }) });
  assert.equal(await preflightCard.locator("pre").textContent(), preflightCommand);
  const preflightText = await preflightCard.textContent();
  for (const text of ["errors", "warnings", "facts", "ready: false", "exits 1", "not a run report", "OOM guarantee", "browser does not inspect hardware", "training/requirements.txt", "training/requirements-mlx.txt"]) {
    assert.ok(preflightText.includes(text), `Missing preflight boundary: ${text}`);
  }
  assert.deepEqual(await stored(lab), beforeHandbook);
  await go(lab, "sessions/run-1");
  await lab.getByRole("button", { name: "Duplicate recipe", exact: true }).click();
  modal = lab.locator("#dialog");
  await modal.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(await lab.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).draft.name, DRAFT_KEY), "Keep this draft");
  await lab.getByRole("button", { name: "Duplicate recipe", exact: true }).click();
  await modal.getByRole("button", { name: "Replace draft", exact: true }).click();
  await lab.waitForURL("**/#/playground");
  await lab.locator("#recipe-advanced > summary").click();
  assert.equal(await lab.getByLabel("External trainer output hint", { exact: true }).inputValue(), "./outputs/run-1-copy");
  await lab.getByRole("button", { name: "Save recipe & review", exact: true }).click();
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
    for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [760, 800], [390, 844], [390, 800], [320, 900], [320, 640], [320, 568], [844, 390]]) {
      await lab.setViewportSize({ width, height });
      for (const path of ["home", "projects", "datasets/teacher-data", "sessions", "sessions/run-0", "checkpoints/artifact-0", "playground", "evaluations", "resources", "settings"]) {
        await go(lab, path);
        await bounds(lab, path === "home");
        if (path === "sessions") {
          const badges = lab.locator(".badge");
          assert.ok(await badges.count() > 0);
          for (const text of await badges.allTextContents()) assert.match(text, /planned|running|completed|paused|failed/i);
          assert.match(await lab.locator("main").ariaSnapshot(), /running|planned/);
          await contrast(lab);
        }
        if ([1440, 390, 320].includes(width) && height > 620) await capture(lab, `${theme}-${width}x${height}-${path.replaceAll("/", "-")}`);
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
  const statusData = fixture();
  statusData.runs = statusData.runs.slice(0, 10);
  for (const [index, status] of ["paused", "completed", "failed", "cancelled"].entries()) {
    const run = statusData.runs[(index + 1) * 2];
    statusData.runs[(index + 1) * 2] = recordProgress(run, {
      status, step: status === "completed" ? run.totalSteps : run.step, totalSteps: run.totalSteps,
      loss: null, evalLoss: null, note: "Synthetic status accessibility fixture.",
      recordedAt: new Date(Date.parse(run.updatedAt) + 1).toISOString(),
    });
  }
  const statusContext = await newContext({ viewport: { width: 760, height: 800 } });
  await statusContext.addInitScript((data) => localStorage.setItem("mamase.coven-lab.v1", JSON.stringify(data)), statusData);
  const statusPage = await statusContext.newPage();
  watch(statusPage);
  for (const [preference, system] of [["light", "dark"], ["dark", "light"], ["system", "light"], ["system", "dark"]]) {
    await go(statusPage, "settings");
    await statusPage.emulateMedia({ colorScheme: system });
    await statusPage.getByRole("group", { name: "Appearance mode", exact: true })
      .getByRole("button", { name: preference[0].toUpperCase() + preference.slice(1), exact: true }).click();
    await statusPage.waitForFunction((theme) => document.documentElement.dataset.theme === theme, preference === "system" ? system : preference);
    await go(statusPage, "sessions");
    for (const status of ["planned", "running", "paused", "completed", "failed", "cancelled"]) {
      assert.ok(await statusPage.locator(`.badge.status-${status}`).count() > 0);
      for (const text of await statusPage.locator(`.badge.status-${status}`).allTextContents()) assert.equal(text.trim(), status);
      assert.ok((await statusPage.locator("main").ariaSnapshot()).includes(status));
    }
    await contrast(statusPage);
    await bounds(statusPage);
  }
  await statusContext.close();
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
    const context = await newContext({ viewport: { width: 320, height: 640 }, colorScheme: theme, hasTouch: true });
    await context.addInitScript((data) => localStorage.setItem("mamase.coven-lab.v1", JSON.stringify(data)), longContent);
    const page = await context.newPage();
    watch(page);
    for (const path of ["home", "projects", "datasets/teacher-data", "sessions", "sessions/run-0", "checkpoints/artifact-0", "playground", "evaluations", "resources", "settings"]) {
      await go(page, path);
      await bounds(page, path === "home");
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(`UX end-to-end passed: ${layouts} responsive layouts, ${contrastChecks} contrast assertions, light/dark/system non-color cues and keyboard core actions, interrupted paired text/digest recovery, read-only preflight instructions, recoverable drafts, report previews and no-op replay, atomic import/restore recovery, versioned and legacy private-summary backups, independent appearance, paired-report lineage and regression review, matching CSV exports, guarded comparisons and loss accessibility. Human assistive-technology review was NOT executed.`);
} catch (error) {
  if (process.env.MAMASE_UX_EVIDENCE) {
    try { await writeFailureEvidence(process.env.MAMASE_UX_EVIDENCE, currentPage, layouts); }
    catch (evidenceError) { console.error(`Synthetic failure evidence could not be written: ${evidenceError.message}`); }
  }
  if (currentPage && !currentPage.isClosed()) await capture(currentPage, "failure");
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
