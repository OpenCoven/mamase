import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { createAppServer } from "../server.mjs";
import { createAuthApi } from "../auth-api.mjs";
import { createWorkspace, createRun, recordProgress, STORAGE_KEY } from "../workspace.js";

test("desktop views prioritize useful records over oversized headers and cards", async (context) => {
  const server = createAppServer({ auth: createAuthApi({ env: {} }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const workspace = createWorkspace(), createdAt = "2026-09-14T12:00:00.000Z";
  workspace.datasets.push({ id: "data", name: "Coven reference set", filename: "examples.jsonl", bytes: 1000, records: 100, format: "prompt-response", kind: "supervised", teacher: "", provenance: "Synthetic layout fixture", holdout: 10, sha256: "a".repeat(64), createdAt });
  for (let index = 0; index < 24; index++) {
    const run = createRun({ id: `run-${index}`, name: `Coven reasoning ${index + 1}`, createdAt, recipe: { workflow: "managed", method: "lora", programId: "coven", datasetId: "data", student: "/models/coven-base", teacher: "", rank: 8, alpha: 16, learningRate: .0002, epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 512, objective: "Compare held-out reasoning.", outputPath: `./outputs/run-${index}` } }, workspace);
    if (index === 0) {
      let observed = recordProgress(run, { status: "running", step: 1, totalSteps: run.totalSteps, loss: 1.5, evalLoss: 1.6, note: "Recorded observation", recordedAt: createdAt });
      observed = recordProgress(observed, { status: "completed", step: run.totalSteps, totalSteps: run.totalSteps, loss: .8, evalLoss: 1.1, note: "Recorded completion", recordedAt: createdAt });
      workspace.runs.push(observed);
      workspace.artifacts.push({ id: "artifact-fixture", runId: run.id, name: "Coven reasoning adapter", kind: "adapter", path: "/models/coven-adapter", notes: "Synthetic layout reference", createdAt });
    } else workspace.runs.push(run);
  }
  const measurements = [];
  for (const mode of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: mode });
    await page.addInitScript(({ workspace, key }) => localStorage.setItem(key, JSON.stringify(workspace)), { workspace, key: STORAGE_KEY });
    const result = { mode };
    for (const route of ["home", "sessions", "sessions/run-0", "playground", "settings"]) {
      await page.goto(`${base}/#/${route}`);
      await page.locator("#main h1").waitFor();
      if (route === "settings") await page.locator('#account-panel:not([data-phase="loading"])').waitFor();
      if (process.env.MAMASE_SCREENSHOTS) {
        await mkdir(process.env.MAMASE_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: join(process.env.MAMASE_SCREENSHOTS, `${mode}-${route.replaceAll("/", "-")}.png`), fullPage: true, animations: "disabled" });
      }
      if (route === "home") Object.assign(result, await page.evaluate(() => ({
        heroHeight: document.querySelector(".home-stage").getBoundingClientRect().height,
        recentRows: [...document.querySelectorAll(".recent-run")].filter((item) => item.getClientRects().length).length,
        background: getComputedStyle(document.body).backgroundImage,
        headingAlignment: getComputedStyle(document.querySelector(".home-copy")).textAlign,
        metricHeight: document.querySelector(".overview-metrics .metric").getBoundingClientRect().height,
        ambient: getComputedStyle(document.querySelector(".main")).backgroundImage,
      })));
      if (route === "sessions") Object.assign(result, await page.evaluate(() => ({
        visibleRows: [...document.querySelectorAll("#run-results tbody tr")].filter((row) => row.getBoundingClientRect().bottom <= innerHeight).length,
        searchGutter: parseFloat(getComputedStyle(document.querySelector("#run-search")).paddingLeft),
      })));
      if (route === "settings") Object.assign(result, await page.evaluate(() => ({
        cardPadding: Math.max(...[...document.querySelectorAll(".settings-grid .card")].map((item) => parseFloat(getComputedStyle(item).paddingTop))),
        primaryShadow: getComputedStyle(document.querySelector(".button.primary")).boxShadow,
      })));
      if (route === "playground") result.selectionRing = await page.locator(".method-card.selected").first().evaluate((item) => getComputedStyle(item).boxShadow);
    }
    assert.equal(await page.locator(".workspace-label [data-action='search']").count(), 1);
    assert.equal(await page.locator(".sidebar > .workspace-search-button").count(), 0);
    await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
    await page.getByRole("button", { name: "Search workspace", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").isVisible(), false);
    await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
    const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: mode, hasTouch: true });
    await touch.addInitScript(({ workspace, key }) => localStorage.setItem(key, JSON.stringify(workspace)), { workspace, key: STORAGE_KEY });
    await touch.goto(`${base}/#/home`);
    await touch.locator("#main h1").waitFor();
    Object.assign(result, await touch.evaluate(() => ({
      mobileHero: document.querySelector(".home-stage").getBoundingClientRect().height,
      mobileAction: document.querySelector(".home-copy .primary").getBoundingClientRect().height,
      mobileRecentRows: [...document.querySelectorAll(".recent-run")].filter((item) => item.getClientRects().length).length,
    })));
    if (process.env.MAMASE_SCREENSHOTS) await touch.screenshot({ path: join(process.env.MAMASE_SCREENSHOTS, `${mode}-touch-home.png`), fullPage: true, animations: "disabled" });
    measurements.push(result);
    await touch.close();
    await page.close();
  }
  for (const value of measurements) {
    assert.ok(value.heroHeight <= 250, JSON.stringify(value));
    assert.ok(value.recentRows >= 5, JSON.stringify(value));
    assert.ok(value.visibleRows >= 10, JSON.stringify(value));
    assert.ok(value.searchGutter >= 36, JSON.stringify(value));
    assert.ok(value.cardPadding <= 20, JSON.stringify(value));
    assert.ok(value.mobileHero <= 250, JSON.stringify(value));
    assert.ok(value.mobileAction >= 44, JSON.stringify(value));
    assert.equal(value.mobileRecentRows, 4);
    assert.equal(value.headingAlignment, "center");
    assert.ok(value.metricHeight <= 80, JSON.stringify(value));
    assert.match(value.ambient, /radial-gradient/);
    assert.equal(value.background, "none");
    assert.match(value.primaryShadow, /inset/);
    assert.notEqual(value.selectionRing, "none");
  }
});
