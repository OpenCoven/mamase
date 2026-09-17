import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";
import { createAppServer } from "../server.mjs";
import { WorkspaceStore } from "../workspace-store.mjs";
import { createWorkspace, STORAGE_KEY } from "../workspace.js";

async function fixture(t, remote = null) {
  let stored = remote && { payload: { ...createWorkspace(), name: remote }, revision: 1, updatedAt: new Date().toISOString() };
  let writes = 0;
  const user = { id: `synthetic-${crypto.randomUUID()}`, email: "member@example.test" };
  const database = process.env.MAMASE_TEST_DATABASE_URL
    ? new WorkspaceStore({ connectionString: process.env.MAMASE_TEST_DATABASE_URL }) : null;
  if (database) {
    t.after(() => database.close());
    if (stored) await database.write(user.id, { email: user.email, payload: stored.payload, baseRevision: 0 });
  }
  const auth = Object.assign(async (req, res, path) => {
    if (path !== "/api/auth/session") return false;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ configured: true, authenticated: true, approved: true, user }));
    return true;
  }, { authorize: async () => ({ authenticated: true, approved: true, user }) });
  const store = {
    async read() { return database ? database.read(user.id) : structuredClone(stored); },
    async write(id, { payload, baseRevision }) {
      if (database) {
        const result = await database.write(id, { email: user.email, payload, baseRevision });
        stored = await database.read(id);
        if (!result.conflict) writes++;
        return result;
      }
      if (baseRevision !== (stored?.revision || 0)) return { conflict: true, stored };
      stored = { payload, revision: baseRevision + 1, updatedAt: new Date().toISOString() }; writes++;
      return { revision: stored.revision, updatedAt: stored.updatedAt };
    },
  };
  const server = createAppServer({ auth, store, inference: null });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: STORAGE_KEY, value: { ...createWorkspace(), name: "Browser records" } });
  await page.goto(`${base}/#/settings`); await page.reload();
  await page.locator('[data-form="workspace"]').waitFor();
  return { browser, page, base, stored: () => stored, writes: () => writes,
    async advance() {
      await store.write(user.id, { baseRevision: stored.revision, payload: { ...stored.payload, name: "Other browser" } });
    } };
}
const localName = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).name, STORAGE_KEY);

test("sign-in does not upload or replace browser data; explicit snapshots restore in a second browser", async (t) => {
  const f = await fixture(t);
  assert.equal(f.writes(), 0); assert.equal(await localName(f.page), "Browser records");
  await f.page.getByRole("button", { name: "Save workspace to account", exact: true }).click();
  await f.page.getByRole("button", { name: "Save account snapshot", exact: true }).click();
  await f.page.getByText("Account snapshot saved. Browser edits after this save stay local.", { exact: true }).waitFor();
  assert.equal(f.stored().payload.name, "Browser records");
  const other = await f.browser.newPage();
  await other.goto(`${f.base}/#/settings`);
  await other.getByRole("button", { name: "Restore account workspace", exact: true }).click();
  await other.locator("#dialog-restore-summary").waitFor();
  assert.equal(await other.evaluate((key) => localStorage.getItem(key), STORAGE_KEY), null);
  await other.locator('[name="confirm"]').check();
  await other.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await other.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(await localName(other), "Browser records");
  assert.equal(f.writes(), 1, "A restore must not upload the browser workspace again");
});

test("a save preview cannot overwrite a newer account snapshot", async (t) => {
  const f = await fixture(t, "Existing account records");
  await f.page.getByRole("button", { name: "Save workspace to account", exact: true }).click();
  await f.page.getByRole("button", { name: "Save account snapshot", exact: true }).waitFor();
  await f.advance();
  await f.page.getByRole("button", { name: "Save account snapshot", exact: true }).click();
  await f.page.locator('#dialog .form-error:not([hidden])').waitFor();
  assert.match(await f.page.locator('#dialog .form-error').textContent(), /Reload the latest data/);
  assert.equal(f.stored().payload.name, "Other browser");
  assert.equal(await localName(f.page), "Browser records");
});

test("closing a delayed account restore prevents it from reopening a dialog or changing local records", async (t) => {
  const f = await fixture(t, "Account records");
  let release; const delayed = new Promise((resolve) => { release = resolve; });
  await f.page.route("**/api/workspace", async (route) => { await delayed; await route.continue(); });
  await f.page.getByRole("button", { name: "Restore account workspace", exact: true }).click();
  await f.page.locator("#dialog[open]").waitFor();
  await f.page.keyboard.press("Escape");
  const finished = f.page.waitForResponse((res) => res.url().endsWith("/api/workspace"));
  release(); await finished;
  await f.page.getByRole("button", { name: "Save workspace to account", exact: true }).waitFor();
  assert.equal(await f.page.locator("#dialog").evaluate((dialog) => dialog.open), false);
  assert.equal(await localName(f.page), "Browser records");
});

test("storage outages are announced without changing browser records", async (t) => {
  const f = await fixture(t);
  await f.page.route("**/api/workspace", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Account storage unavailable. Try again." }) }));
  await f.page.getByRole("button", { name: "Save workspace to account", exact: true }).click();
  await f.page.getByText("Account storage unavailable. Try again.", { exact: true }).waitFor();
  assert.equal(await localName(f.page), "Browser records");
  assert.equal(f.writes(), 0);
});

test("restore waits for an in-flight account refresh before changing local records", async (t) => {
  const f = await fixture(t, "Account A snapshot");
  await f.page.getByRole("button", { name: "Restore account workspace", exact: true }).click();
  await f.page.locator('[name="confirm"]').check();
  let release; const delayed = new Promise((resolve) => { release = resolve; });
  let observed; const started = new Promise((resolve) => { observed = resolve; });
  await f.page.route("**/api/auth/session", async (route) => {
    observed(); await delayed;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ configured: true, authenticated: true, approved: true,
      user: { id: "account-b", email: "b@example.test" } }) });
  });
  await f.page.evaluate(() => window.dispatchEvent(new Event("focus"))); await started;
  await f.page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  try {
    assert.equal(await localName(f.page), "Browser records", "A pending refresh must block the old account preview");
    await f.page.locator('#dialog .form-error:not([hidden])').waitFor();
  } finally { release(); }
});

test("an account restore preview cannot replace edits saved by another local tab", async (t) => {
  const f = await fixture(t, "Account records");
  await f.page.getByRole("button", { name: "Restore account workspace", exact: true }).click();
  await f.page.locator('[name="confirm"]').check();
  await f.page.evaluate((key) => { const data = JSON.parse(localStorage.getItem(key)); data.name = "New local edit"; localStorage.setItem(key, JSON.stringify(data)); }, STORAGE_KEY);
  await f.page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await f.page.locator('#dialog .form-error:not([hidden])').waitFor();
  assert.equal(await localName(f.page), "New local edit");
});
