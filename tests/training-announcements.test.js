import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";
import { createAppServer } from "../server.mjs";
import { createAuthApi } from "../auth-api.mjs";
import { createWorkspace, createRun, recordProgress, validateDataset, STORAGE_KEY } from "../workspace.js";
import { trainingIdentity, trainingProgress } from "../training-state.js";
import { installAnnouncementRecorder, drainAnnouncements, waitForAnnouncement } from "../scripts/ux-announcements.mjs";

async function fixture(context) {
  const workspace = createWorkspace();
  const createdAt = "2026-09-14T00:00:00.000Z";
  const dataset = validateDataset({ id: "data", name: "Examples", filename: "data.jsonl", bytes: 100, records: 6,
    format: "prompt-response", kind: "supervised", teacher: "", provenance: "Synthetic fixture",
    holdout: 20, sha256: "a".repeat(64), createdAt });
  workspace.datasets.push(dataset);
  const run = createRun({ id: "run", name: "Local adapter", createdAt, recipe: {
    workflow: "managed", method: "lora", programId: "coven", datasetId: "data", student: "./models/local",
    teacher: "", rank: 4, alpha: 8, learningRate: .001, epochs: 1, batchSize: 1, accumulation: 1,
    maxSequence: 128, objective: "Learn examples.", outputPath: "./outputs/local",
  } }, workspace);
  workspace.runs.push(run);
  let job = { id: "job-1", identity: trainingIdentity(run, dataset), dataset, status: "running", sequence: 1,
    artifact: null, logs: [], outputPath: "./outputs/local", run: recordProgress({ ...run, localJobId: "job-1" }, {
      status: "running", step: 1, totalSteps: run.totalSteps, loss: .8, evalLoss: null, note: "Started.", recordedAt: createdAt,
    }) };
  const server = createAppServer({ auth: createAuthApi({ env: {} }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const browser = await chromium.launch();
  context.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installAnnouncementRecorder(page);
  await page.addInitScript(({ workspace, key }) => {
    localStorage.setItem(key, JSON.stringify(workspace));
    window.trainingStreams = [];
    window.EventSource = class {
      constructor() { window.trainingStreams.push(this); }
      close() { this.closed = true; }
    };
  }, { workspace, key: STORAGE_KEY });
  await page.route("**/api/training/capabilities", (route) => route.fulfill({ json: { enabled: true, available: true } }));
  let release;
  await page.route("**/api/training/runs/run", async (route) => {
    await new Promise((resolve) => { release = resolve; });
    await route.fulfill({ json: { job } });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const refresh = async () => {
    release = null;
    const requested = page.waitForRequest("**/api/training/runs/run");
    await page.goto(`${base}/#/sessions/run`);
    await requested;
    assert.deepEqual((await drainAnnouncements(page)).filter((entry) => entry.spoken && entry.id === "live-progress-announcement"), []);
    release();
    const milestone = trainingProgress(job.run.step, job.run.totalSteps, job.status).milestone;
    await page.waitForFunction((expected) => document.querySelector("#live-progress-announcement")?.dataset.milestone === expected, milestone, { timeout: 5000 })
      .catch(async (error) => { throw new Error(`${error.message}\n${JSON.stringify(errors)}\n${await page.locator("#local-training-panel").innerText()}`); });
    assert.deepEqual((await drainAnnouncements(page)).filter((entry) => entry.spoken && entry.id === "live-progress-announcement"), [],
      "a live snapshot that was already true when the view opened must not be announced as a new event");
  };
  const advance = (step, status = "running") => {
    job = { ...job, status, sequence: job.sequence + 1, run: recordProgress(job.run, { status, step,
      totalSteps: run.totalSteps, loss: null, evalLoss: null, note: "Fixture update.",
      recordedAt: new Date(Date.parse(createdAt) + job.sequence * 60_000).toISOString() }) };
    return job;
  };
  const emit = (job) => page.evaluate((job) => window.trainingStreams.at(-1).onmessage({ data: JSON.stringify({ type: "snapshot", job }) }), job);
  context.after(() => assert.deepEqual(errors, []));
  return { page, base, run, refresh, advance, emit };
}

test("opening a run establishes its baseline from the first live snapshot, including on a return visit", async (context) => {
  const { page, base, run, refresh, advance, emit } = await fixture(context);
  await refresh();
  await emit(advance(2));
  assert.equal((await waitForAnnouncement(page, /^running, /)).text, trainingProgress(2, run.totalSteps, "running").announcement);
  await page.goto(`${base}/#/home`);
  advance(2, "cancelled");
  await refresh();
});

test("closing a modal cannot replay older progress over a newer terminal announcement", async (context) => {
  const { page, refresh, advance, emit } = await fixture(context);
  await refresh();
  await page.getByRole("button", { name: "Cancel local training", exact: true }).click();
  await emit(advance(2));
  assert.match(await page.locator("#live-progress-announcement").getAttribute("data-pending"), /^running, /);
  await page.evaluate((job) => {
    document.querySelector("#dialog").close();
    // close dispatches its event in a later task. A newer SSE update can be delivered first.
    window.trainingStreams.at(-1).onmessage({ data: JSON.stringify({ type: "snapshot", job }) });
  }, advance(2, "cancelled"));
  await page.waitForFunction(() => document.querySelector("#dialog").childElementCount === 0);
  assert.match(await page.locator("#live-progress-announcement").textContent(), /^cancelled, /);
  assert.equal(await page.locator("#live-progress-announcement").getAttribute("data-pending"), null);
  assert.equal((await waitForAnnouncement(page, /^cancelled, /)).id, "live-progress-announcement");
});

test("completion while mobile navigation is open is announced when the run page becomes available", async (context) => {
  const { page, refresh, advance, emit, run } = await fixture(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await refresh();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  assert.equal(await page.locator("#main").evaluate((element) => element.inert), true);
  await emit(advance(run.totalSteps, "completed"));
  assert.deepEqual((await drainAnnouncements(page)).filter((entry) => entry.spoken && entry.id === "live-progress-announcement"), []);
  await page.getByRole("button", { name: "Close navigation", exact: true }).first().click();
  assert.equal((await waitForAnnouncement(page, /^completed, 100%/, { timeout: 1000 })).id, "live-progress-announcement");
});
