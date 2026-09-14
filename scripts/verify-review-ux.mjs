import assert from "node:assert/strict";
import { reviewFixture } from "../tests/fixtures/evaluation-fixture.js";
import { STORAGE_KEY } from "../workspace.js";

export async function verifyReviewUx({ newContext, base, watch, downloaded, bounds }) {
  const { workspace, source, report } = reviewFixture();
  const context = await newContext({ viewport: { width: 1440, height: 1000 } });
  let completed = false;
  try {
    await context.addInitScript(({ workspace, key }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(workspace));
    }, { workspace, key: STORAGE_KEY });
    const page = await context.newPage();
    watch(page);
    const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
    const modal = page.locator("#dialog");
    const file = (content = source) => ({ name: "operator-selected-report.json", mimeType: "application/json", buffer: Buffer.from(content) });
    const choose = async () => {
      await page.locator('[data-action="review-report"]').first().click();
      await modal.getByRole("heading", { name: "Inspect exact local paired report", exact: true }).waitFor();
    };
    const load = async (content = source) => {
      await modal.getByLabel("JSON file", { exact: true }).setInputFiles(file(content));
      await modal.getByRole("button", { name: "Inspect report", exact: true }).click();
    };
    const open = async () => {
      await choose();
      await load();
      await modal.getByRole("heading", { name: "Inspect paired case evidence", exact: true }).waitFor();
    };
    const fillOpinion = async () => {
      await modal.getByLabel("Reviewer", { exact: true }).fill("Synthetic reviewer");
      await modal.getByLabel("Human decision", { exact: true }).selectOption("approved");
      await modal.getByLabel("Rationale (metadata only; no private quotations)", { exact: true }).fill("Truthful block; literal formatting failure remains separate.");
      await modal.getByLabel("Limitations (metadata only; no private quotations)", { exact: true }).fill("Text-only synthetic demonstration; no receipts and no deployment approval.");
      await modal.locator('[name="confirmTextOnly"]').check();
    };
    const noRawDom = async () => {
      assert.equal(await modal.locator("[data-review-case]").count(), 0);
      assert.ok(!(await modal.innerHTML()).includes("PRIVATE_CASE_SENTINEL"));
      assert.equal(await page.evaluate(() => window.reviewInjected), undefined);
    };
    await page.goto(`${base}/#/evaluations`);
    await choose();
    await modal.getByRole("button", { name: "Inspect report", exact: true }).click();
    assert.equal(await modal.getByLabel("JSON file", { exact: true }).evaluate((element) => element.validity.valueMissing), true);
    assert.deepEqual(await stored(), workspace);
    await load(`${source}\n`);
    await modal.locator(".form-error").getByText(/not the exact imported report/).waitFor();
    assert.equal(await modal.locator("[data-review-case]").count(), 0);
    await load(JSON.stringify({ ...report, familiarContext: { schema: "synthetic-context", revision: "changed" } }));
    await modal.locator(".form-error").getByText(/not the exact imported report/).waitFor();
    await load("{");
    await modal.locator(".form-error").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");

    // A selected disk file can disappear/become unreadable after selection.
    await choose();
    await page.evaluate(() => {
      window.originalReviewRead = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function() { return Promise.reject(new DOMException("Selected report is no longer readable.", "NotReadableError")); };
    });
    await load();
    await modal.getByText("Selected report is no longer readable.", { exact: true }).waitFor();
    assert.deepEqual(await stored(), workspace);
    await page.evaluate(() => { File.prototype.arrayBuffer = window.originalReviewRead; });
    await page.keyboard.press("Escape");

    for (const interruption of ["escape-and-replace", "navigation", "malformed-navigation"]) {
      await choose();
      await page.evaluate(() => {
        window.originalReviewRead = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = function() {
          return new Promise((resolve, reject) => { window.releaseReview = () => window.originalReviewRead.call(this).then(resolve, reject); });
        };
      });
      await load(interruption === "malformed-navigation" ? '{"prompt":PRIVATE_CASE_SENTINEL}' : source);
      await page.waitForFunction(() => typeof window.releaseReview === "function");
      assert.equal(await modal.locator("form").getAttribute("aria-busy"), "true");
      if (interruption === "escape-and-replace") {
        await page.keyboard.press("Escape");
        await choose();
      } else {
        await page.evaluate(() => { location.hash = "#/settings"; });
        await page.waitForURL("**/#/settings");
      }
      await page.evaluate(() => {
        File.prototype.arrayBuffer = window.originalReviewRead;
        window.releaseReview();
        delete window.releaseReview;
      });
      await page.locator("#toast").getByText(/review was closed/).waitFor();
      await noRawDom();
      assert.ok(!(await page.locator("#toast").innerHTML()).includes("PRIVATE_CASE_SENTINEL"));
      assert.deepEqual(await stored(), workspace);
      await page.keyboard.press("Escape");
      await page.evaluate(() => { location.hash = "#/evaluations"; });
      await page.locator('[data-action="review-report"]').first().waitFor();
    }

    await open();
    assert.equal(await page.evaluate(() => document.activeElement.id), "dialog-title");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("#dialog"))), true);
    assert.equal(await modal.locator("img, script").count(), 0);
    assert.ok((await modal.innerText()).includes("PRIVATE_CASE_SENTINEL"));
    await modal.getByText(/base 2 \/ 4; adapter 2 \/ 4; 1 regressions/).waitFor();
    assert.equal(await modal.locator("[data-review-case]").count(), 4);
    await modal.locator('[name="state-3-adapter"]').selectOption("blocked");
    await modal.locator('[name="judgment-3-adapter"]').selectOption("truthful-within-scope");
    await modal.locator('[name="regressionsOnly"]').check();
    assert.equal(await modal.locator("[data-review-case]:visible").count(), 1);
    await modal.getByText("1 of 4 cases shown; deterministic denominator unchanged", { exact: true }).waitFor();
    await modal.locator('[name="regressionsOnly"]').uncheck();
    assert.equal(await modal.locator('[name="state-3-adapter"]').inputValue(), "blocked");
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await bounds(page);
    }
    const whileOpen = await downloaded(page, modal.getByRole("button", { name: "Export open workspace", exact: true }));
    assert.ok(!whileOpen.includes("PRIVATE_CASE_SENTINEL") && !whileOpen.includes('"response"'));
    await fillOpinion();
    await page.evaluate(() => {
      window.originalReviewSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === "mamase.coven-lab.v1") throw new DOMException("Synthetic quota failure", "QuotaExceededError");
        return window.originalReviewSetItem.call(this, key, value);
      };
    });
    await modal.getByRole("button", { name: "Record review opinion", exact: true }).click();
    await modal.getByText(/Browser storage is full/).waitFor();
    assert.equal(await modal.getByLabel("Reviewer", { exact: true }).inputValue(), "Synthetic reviewer");
    assert.equal(await modal.locator('[name="state-3-adapter"]').inputValue(), "blocked");
    assert.deepEqual(await stored(), workspace);
    await page.evaluate(() => { Storage.prototype.setItem = window.originalReviewSetItem; });
    await modal.getByRole("button", { name: "Record review opinion", exact: true }).click();
    await modal.waitFor({ state: "hidden" });
    await noRawDom();
    const approved = await stored();
    assert.deepEqual(approved.evaluations[0].comparison, workspace.evaluations[0].comparison);
    assert.equal(approved.evaluations[0].reviews[0].decision, "approved");
    assert.equal(approved.evaluations[0].reviews[0].authorization, "none");
    assert.equal(approved.evaluations[0].reviews[0].annotations[3].adapter.taskState, "blocked");
    assert.equal(approved.evaluations[0].reviews[0].annotations[3].adapter.executionEvidence, "unknown");
    assert.deepEqual(approved.artifacts, workspace.artifacts);
    assert.deepEqual(approved.runs, workspace.runs);
    await page.locator('[data-action="evaluation-details"]').first().click();
    await modal.getByText(/approved - Synthetic reviewer/).waitFor();
    await page.keyboard.press("Escape");

    // Cross-tab conflict must use the original loaded snapshot, not the latest global source.
    await open();
    await fillOpinion();
    const other = await context.newPage();
    await other.goto(`${base}/#/settings`);
    await other.evaluate((key) => {
      const value = JSON.parse(localStorage.getItem(key));
      value.name = "Concurrent review workspace";
      localStorage.setItem(key, JSON.stringify(value));
    }, STORAGE_KEY);
    const latest = await stored();
    await modal.getByRole("button", { name: "Record review opinion", exact: true }).click();
    await modal.getByText(/workspace changed while you were editing/).waitFor();
    assert.deepEqual(await stored(), latest);
    assert.equal(await modal.getByLabel("Reviewer", { exact: true }).inputValue(), "Synthetic reviewer");
    await modal.getByRole("button", { name: "Reload workspace", exact: true }).click();
    await noRawDom();
    await modal.getByRole("button", { name: "Reload latest data", exact: true }).click();
    await page.locator('[data-action="review-report"]').first().waitFor();
    await other.close();
    await open();
    assert.equal(await modal.getByLabel("Reviewer", { exact: true }).inputValue(), "");
    await page.keyboard.press("Escape");
    await noRawDom();
    await open();
    await page.evaluate(() => { location.hash = "#/settings"; });
    await page.waitForURL("**/#/settings");
    await noRawDom();
    const backup = await downloaded(page, page.getByRole("button", { name: "Export workspace", exact: true }));
    for (const privateText of ["PRIVATE_CASE_SENTINEL", "PRIVATE_BASE_SENTINEL", "PRIVATE_ADAPTER_SENTINEL", '"prompt"', '"response"', '"checks"', '"requestedOutcome"']) {
      assert.ok(!backup.includes(privateText), privateText);
    }
    assert.equal(JSON.parse(backup).workspace.evaluations[0].reviews.length, 1);
    await page.reload();
    await noRawDom();
    completed = true;
  } finally {
    // The owning runner needs a failed page alive for bounded screenshot evidence.
    if (completed) await context.close();
  }
}
