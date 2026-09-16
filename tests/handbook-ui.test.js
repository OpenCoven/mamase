import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";
import { createAppServer } from "../server.mjs";
import { createAuthApi } from "../auth-api.mjs";
import { createWorkspace, createRun, STORAGE_KEY } from "../workspace.js";

const createdAt = "2026-09-14T00:00:00.000Z";

function seeded() {
  const workspace = createWorkspace();
  workspace.datasets.push({
    id: "data", name: "Examples", filename: "data.jsonl", bytes: 100, records: 6,
    format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original",
    holdout: 20, sha256: "a".repeat(64), createdAt,
  });
  workspace.runs.push(createRun({
    id: "run-1", name: "Coven adapter", createdAt,
    recipe: {
      workflow: "cli", method: "lora", programId: workspace.programs[0].id, datasetId: "data",
      student: "./models/local", teacher: "", rank: 4, alpha: 8, learningRate: 0.001,
      epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 128,
      objective: "Learn examples.", outputPath: "./outputs/local",
      familiarId: "fam", instanceId: "inst",
    },
  }, workspace));
  return workspace;
}

function seededManaged() {
  const workspace = createWorkspace();
  workspace.datasets.push({
    id: "data", name: "Examples", filename: "data.jsonl", bytes: 100, records: 6,
    format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original",
    holdout: 20, sha256: "a".repeat(64), createdAt,
  });
  workspace.runs.push(createRun({
    id: "run-managed", name: "Mac adapter", createdAt,
    recipe: {
      workflow: "managed", method: "lora", programId: workspace.programs[0].id, datasetId: "data",
      student: "/Users/you/Models/local", teacher: "", rank: 4, alpha: 8, learningRate: 0.001,
      epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 128,
      objective: "Learn examples.", outputPath: "./outputs/local",
      familiarId: "", instanceId: "", adapter: "lora",
    },
  }, workspace));
  return workspace;
}

async function fixture(context, workspace) {
  const server = createAppServer({ auth: createAuthApi({ env: {} }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(({ value, key }) => localStorage.setItem(key, JSON.stringify(value)), { value: workspace, key: STORAGE_KEY });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, errors, base: `http://127.0.0.1:${server.address().port}` };
}

test("the handbook shows the run's real position and the next command", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  assert.match(await page.locator("#handbook-lane").innerText(), /peft/i);
  const next = page.locator('[data-step-state="next"]').first();
  await next.waitFor();
  assert.match(await next.innerText(), /npm run lab -- prepare/);
  assert.equal(await page.locator('[data-step-state="next"]').count(), 1, "Exactly one next step");
  assert.ok(await page.locator("#handbook-steps details").count(), "Boundaries are disclosed, not inline");
  assert.deepEqual(errors, []);
});

test("an empty workspace renders the first-run path", async (context) => {
  const { page, errors, base } = await fixture(context, createWorkspace());
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  assert.match(await page.locator("#handbook-steps").innerText(), /Curate the examples/);
  assert.equal(await page.locator('[data-action="agent-handoff"]').count(), 0, "No run, nothing to hand off");
  assert.deepEqual(errors, []);
});

test("handing off exports the workspace and copies a prompt naming it", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Hand off to an agent" }).click();
  const download = await waiting;
  assert.match(download.suggestedFilename(), /^coven-workspace-\d{4}-\d{2}-\d{2}\.json$/);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.includes(download.suggestedFilename()), "The prompt must name the file just exported");
  assert.match(copied, /run-1/);
  assert.match(copied, /skills\/mamase\/SKILL\.md/);
  assert.deepEqual(errors, []);
});

test("a denied clipboard still exports and shows the prompt to copy by hand", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true,
    });
  });
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Hand off to an agent" }).click();
  await waiting;
  await page.locator("dialog[open]").waitFor();
  assert.match(await page.locator("dialog[open]").innerText(), /skills\/mamase\/SKILL\.md/);
  assert.deepEqual(errors, []);
});

test("a workspace changed in another tab refuses to hand off instead of exporting stale state", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  // Simulate another tab's write landing after this page loaded its copy, the
  // same condition the "workspace changed in another tab" banner reacts to.
  await page.evaluate((key) => {
    const changed = JSON.parse(localStorage.getItem(key));
    changed.name = "Renamed from another tab";
    localStorage.setItem(key, JSON.stringify(changed));
  }, STORAGE_KEY);
  await page.getByRole("button", { name: "Hand off to an agent" }).click();
  await page.getByText("This workspace changed in another tab.", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test("switching runs re-derives the spine without writing anything", async (context) => {
  const workspace = seeded();
  workspace.runs.push({ ...workspace.runs[0], id: "run-2", name: "Second attempt", createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z" });
  const { page, errors, base } = await fixture(context, workspace);
  const before = JSON.stringify(workspace);
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  assert.match(await page.locator("#handbook-lane").innerText(), /Second attempt/i);
  await page.selectOption('select[name="handbook-run"]', "run-1");
  await page.locator('#handbook-lane:has-text("Coven adapter")').waitFor();
  const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  assert.equal(stored, before, "Choosing a run is view state and must not write");
  assert.deepEqual(errors, []);
});

test("choosing a run in the handbook keeps focus on the picker", async (context) => {
  const workspace = seeded();
  workspace.runs.push({ ...workspace.runs[0], id: "run-2", name: "Second attempt", createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z" });
  const { page, errors, base } = await fixture(context, workspace);
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const picker = page.locator('select[name="handbook-run"]');
  await picker.focus();
  await picker.selectOption("run-1");
  await page.locator('#handbook-lane:has-text("Coven adapter")').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('select[name="handbook-run"]')), true, "Focus must return to the run picker, not fall back to the document body");
  assert.deepEqual(errors, []);
});

// The managed-mlx lane is the only one whose spine depends on a local capability
// probe (handbook.js refuses to forward capability to the peft/unselected
// lanes). render() calls training.watch(null) on every page but the run detail
// page, so a direct load of the handbook used to never ask, while visiting the
// run page first cached an answer that the handbook then picked up -- two
// different reports of the same run and workspace. Assert both routes to the
// handbook converge on the same spine.
test("the managed lane handbook reports the same spine on a direct load as after visiting the run page", async (context) => {
  const { page, errors, base } = await fixture(context, seededManaged());

  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  await page.locator('[data-step-id="capability"][data-step-state="blocked"]').waitFor();
  const direct = await page.evaluate(() => ({
    lane: document.querySelector("#handbook-lane").innerText,
    blockers: [...document.querySelectorAll(".notice p")].map((element) => element.textContent),
    steps: [...document.querySelectorAll("[data-step-id]")].map((element) => [element.dataset.stepId, element.dataset.stepState]),
  }));

  await page.goto(`${base}/#/sessions/run-managed`);
  await page.locator("#local-training-panel h2").waitFor();
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  await page.locator('[data-step-id="capability"][data-step-state="blocked"]').waitFor();
  const afterVisitingRun = await page.evaluate(() => ({
    lane: document.querySelector("#handbook-lane").innerText,
    blockers: [...document.querySelectorAll(".notice p")].map((element) => element.textContent),
    steps: [...document.querySelectorAll("[data-step-id]")].map((element) => [element.dataset.stepId, element.dataset.stepState]),
  }));

  assert.ok(direct.blockers.length, "The disabled local runtime should be reported as a blocker");
  assert.deepEqual(direct, afterVisitingRun, "A direct load must report the same spine as a load that visited the run page first");
  assert.deepEqual(errors, []);
});
