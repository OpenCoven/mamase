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
