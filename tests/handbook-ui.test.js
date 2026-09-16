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

// A run with no workflow chosen and no familiar/instance bound: detectLane
// falls through to "unselected", the lane whose hand-off prompt must warn an
// agent not to choose the lane itself rather than warning about training.
function seededUnselected() {
  const workspace = createWorkspace();
  workspace.datasets.push({
    id: "data", name: "Examples", filename: "data.jsonl", bytes: 100, records: 6,
    format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original",
    holdout: 20, sha256: "a".repeat(64), createdAt,
  });
  workspace.runs.push(createRun({
    id: "run-unselected", name: "Undecided attempt", createdAt,
    recipe: {
      method: "lora", programId: workspace.programs[0].id, datasetId: "data",
      student: "./models/local", teacher: "", rank: 4, alpha: 8, learningRate: 0.001,
      epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 128,
      objective: "Learn examples.", outputPath: "./outputs/local",
      familiarId: "", instanceId: "",
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

test("each step's Copy button copies that exact step's command, not another step's", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();

  await page.locator('[data-step-id="prepare"] [data-action="copy-command"]').click();
  const prepareCopied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(prepareCopied, /npm run lab -- prepare/);

  // Preflight is the SECOND step with a command. A copy-command bug that
  // always reaches for the first command-bearing step's button would still
  // pass a test that only ever clicks the first one.
  await page.locator('[data-step-id="preflight"] [data-action="copy-command"]').click();
  const preflightCopied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(preflightCopied, /training\/preflight\.py/);
  assert.notEqual(preflightCopied, prepareCopied, "The preflight step's Copy button must not copy the prepare step's command");

  await page.locator('[data-step-id="train"] [data-action="copy-command"]').click();
  const trainCopied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(trainCopied, /training\/train\.py/);
  assert.notEqual(trainCopied, prepareCopied);
  assert.notEqual(trainCopied, preflightCopied);

  assert.deepEqual(errors, []);
});

test("the Copy button carries the exact step command in data-command", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const button = page.locator('[data-step-id="prepare"] [data-action="copy-command"]');
  await button.waitFor();
  assert.equal(
    await button.getAttribute("data-command"),
    "npm run lab -- prepare --recipe recipe.json --dataset <examples.jsonl> --identity-dir <familiar> --out <bundle>",
    "The Copy button must carry its own step's command as a real attribute",
  );
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

test("handing off a PEFT run warns the agent off training without go-ahead", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Hand off to an agent" }).click();
  await waiting;
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(prompt, /Lane\s+: peft/);
  assert.match(prompt, /Do not run training\/train\.py without my explicit go-ahead for this run\./);
  assert.ok(!prompt.includes("Do not choose the lane for me."), "A bound PEFT run must not get the unselected-lane caution");
  assert.deepEqual(errors, []);
});

test("handing off a run with no lane selected tells the agent not to pick one, not to train", async (context) => {
  const { page, errors, base } = await fixture(context, seededUnselected());
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Hand off to an agent" }).click();
  await waiting;
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(prompt, /Lane\s+: unselected/);
  assert.ok(prompt.includes("Do not choose the lane for me."), "An unselected-lane run must warn the agent off choosing the lane");
  assert.ok(!prompt.includes("Do not run training/train.py without my explicit go-ahead for this run."), "An unselected-lane run must not carry the training go-ahead warning");
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
  // This is the real async-action-rejection path: assertWorkspaceSource throws
  // inside the async agent-handoff action, and the click dispatcher's
  // `.catch()` is what turns that rejection into a toast instead of an
  // unhandled rejection. Assert the toast itself, not just the (independently
  // triggered) banner, or a reverted dispatcher passes this test unnoticed.
  const toast = page.locator("#toast");
  await toast.waitFor({ state: "visible" });
  assert.match(await toast.innerText(), /This workspace changed while you were editing\. Reload before saving to avoid overwriting those changes\./);
  assert.deepEqual(errors, []);
});

test("switching runs re-derives the spine, preselects it in the picker, and writes nothing", async (context) => {
  const workspace = seeded();
  workspace.runs.push({ ...workspace.runs[0], id: "run-2", name: "Second attempt", createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z" });
  const { page, errors, base } = await fixture(context, workspace);
  const before = JSON.stringify(workspace);
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  assert.match(await page.locator("#handbook-lane").innerText(), /Second attempt/i);
  // The picker must default to the run actually shown (the most recently
  // updated one), not just to whatever option happens to be first in the DOM.
  assert.equal(await page.locator('select[name="handbook-run"]').inputValue(), "run-2", "The picker must preselect the run that is actually displayed");
  const beforeStorage = await page.evaluate(() => ({ ...localStorage }));
  await page.selectOption('select[name="handbook-run"]', "run-1");
  await page.locator('#handbook-lane:has-text("Coven adapter")').waitFor();
  const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  assert.equal(stored, before, "Choosing a run is view state and must not write");
  const afterStorage = await page.evaluate(() => ({ ...localStorage }));
  assert.deepEqual(afterStorage, beforeStorage, "Choosing a run must not write to any localStorage key, not only the workspace key");
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

// A dataset genuinely deleted out from under a run cannot reach resourcesPage
// at all: validateWorkspace reconstructs every run's recipe on load (even from
// its own last-saved localStorage), and that reconstruction itself asserts the
// dataset exists -- so a workspace in that state fails to load entirely (the
// generic "Workspace needs attention" recovery page), never reaching the
// handbook's own blockers banner. The lane-unselected run is a blocker
// reachable through a workspace that actually loads, so it is the fixture
// used here instead.
test("a run with a real blocker (no lane selected) shows a blockers banner instead of silently dropping it", async (context) => {
  const { page, errors, base } = await fixture(context, seededUnselected());
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const notice = page.locator('.notice[role="status"]');
  await notice.waitFor();
  const noticeText = await notice.innerText();
  assert.match(noticeText, /Blocked/);
  assert.match(noticeText, /does not select a workflow and is unbound/);
  assert.deepEqual(errors, []);
});

test("a run name with markup cannot inject an element into the lane line or the run picker", async (context) => {
  const workspace = seeded();
  // Reuse the same run shape as seeded(), just with a hostile name. Give it a
  // later, self-consistent createdAt/updatedAt pair (createRun always derives
  // updatedAt from createdAt) so it sorts as the most recently updated run and
  // is the one the handbook actually shows -- the exact spot both esc() call
  // sites (the lane line and the <option> text) need to cover.
  workspace.runs[0].name = '<mark id="pwned-name">Hostile</mark>';
  workspace.runs[0].createdAt = "2026-09-16T00:00:00.000Z";
  workspace.runs[0].updatedAt = "2026-09-16T00:00:00.000Z";
  workspace.runs.push({ ...workspace.runs[0], id: "run-plain", name: "Plain run", createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" });
  const { page, errors, base } = await fixture(context, workspace);
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-lane").waitFor();
  // The lane line is CSS-uppercased for display; read the raw DOM text
  // (textContent), not the rendered/transformed text (innerText).
  assert.match(await page.locator("#handbook-lane").evaluate((element) => element.textContent), /Hostile/i, "The escaped name must still read as text");
  assert.equal(await page.locator("#pwned-name").count(), 0, "The run name must not become a live element in the lane line");
  const selectHtml = await page.evaluate(() => document.querySelector('select[name="handbook-run"]').innerHTML);
  assert.ok(!selectHtml.includes('<mark id="pwned-name">'), "The run name must not inject raw markup into the picker's options");
  assert.match(selectHtml, /&lt;mark id="pwned-name"&gt;Hostile&lt;\/mark&gt;/, "The run name must be HTML-escaped in the option text");
  assert.deepEqual(errors, []);
});

test("step marks are distinct per state, not one repeated glyph", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const doneMark = await page.locator('[data-step-id="plan"] .handbook-mark').innerText();
  const nextMark = await page.locator('[data-step-id="prepare"] .handbook-mark').innerText();
  const pendingMark = await page.locator('[data-step-id="preflight"] .handbook-mark').innerText();
  assert.equal(doneMark, "✓", "The done mark should be a checkmark");
  assert.equal(nextMark, "▸", "The next mark should be a pointer");
  assert.equal(pendingMark, "○", "The pending mark should be a hollow circle");
  assert.notEqual(doneMark, nextMark, "Marks are the non-color state cue and must differ across states");
  assert.notEqual(nextMark, pendingMark);
  assert.notEqual(doneMark, pendingMark);
  assert.deepEqual(errors, []);
});

test("the handbook-state span announces each step's state as text", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const planState = page.locator('[data-step-id="plan"] .handbook-state');
  const prepareState = page.locator('[data-step-id="prepare"] .handbook-state');
  await prepareState.waitFor();
  // The state word is CSS-uppercased for display; read the raw DOM text
  // (textContent), not the rendered/transformed text (innerText).
  assert.equal(await planState.evaluate((element) => element.textContent), "done");
  assert.equal(await prepareState.evaluate((element) => element.textContent), "next");
  assert.deepEqual(errors, []);
});

test("Copy buttons carry a step-specific aria-label, not a generic one", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const prepareButton = page.locator('[data-step-id="prepare"] [data-action="copy-command"]');
  const preflightButton = page.locator('[data-step-id="preflight"] [data-action="copy-command"]');
  await prepareButton.waitFor();
  const prepareLabel = await prepareButton.getAttribute("aria-label");
  const preflightLabel = await preflightButton.getAttribute("aria-label");
  assert.equal(prepareLabel, "Copy the Prepare the bundle command");
  assert.equal(preflightLabel, "Copy the Preflight command");
  assert.notEqual(prepareLabel, preflightLabel, "Repeated Copy buttons must stay distinguishable by their accessible name");
  assert.notEqual(prepareLabel, "Copy");
  await page.getByRole("button", { name: "Copy the Prepare the bundle command" }).waitFor();
  assert.deepEqual(errors, []);
});
