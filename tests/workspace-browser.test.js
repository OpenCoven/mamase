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
    switchAccount() { user.id = `other-${crypto.randomUUID()}`; },
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

test("a restore preview refuses a newer account revision and requires a new preview", async (t) => {
  const f = await fixture(t, "Existing account records");
  await f.page.getByRole("button", { name: "Restore account workspace", exact: true }).click();
  await f.page.locator('[name="confirm"]').check();
  await f.advance();
  await f.page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await f.page.locator('#dialog .form-error:not([hidden])').waitFor();
  assert.match(await f.page.locator('#dialog .form-error').textContent(), /changed.*preview/i);
  assert.equal(await localName(f.page), "Browser records");
  await f.page.keyboard.press("Escape");
  await f.page.getByRole("button", { name: "Restore account workspace", exact: true }).click();
  await f.page.locator('[name="confirm"]').check();
  await f.page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await f.page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(await localName(f.page), "Other browser");
});

test("restore reauthorizes the account even without a browser account refresh", async (t) => {
  const f = await fixture(t, "Account A snapshot");
  await f.page.getByRole("button", { name: "Restore account workspace", exact: true }).click();
  await f.page.locator('[name="confirm"]').check();
  f.switchAccount();
  await f.page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await f.page.locator('#dialog .form-error:not([hidden])').waitFor();
  assert.match(await f.page.locator('#dialog .form-error').textContent(), /account changed/i);
  assert.equal(await localName(f.page), "Browser records");
});

test("closing a restore confirmation during its revision check preserves browser records", async (t) => {
  const f = await fixture(t, "Account snapshot");
  await f.page.getByRole("button", { name: "Restore account workspace", exact: true }).click();
  await f.page.locator('[name="confirm"]').check();
  let release, observed;
  const delayed = new Promise((resolve) => { release = resolve; });
  const requested = new Promise((resolve) => { observed = resolve; });
  await f.page.route("**/api/workspace", async (route) => { observed(); await delayed; await route.continue(); });
  await f.page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await requested;
  await f.page.keyboard.press("Escape");
  const finished = f.page.waitForResponse((response) => response.url().endsWith("/api/workspace"));
  release(); await finished;
  await f.page.getByRole("button", { name: "Restore account workspace", exact: true }).click();
  await f.page.locator('[name="confirm"]').waitFor();
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

// What a screen reader is handed by these dialogs. Each one replaces the progress dialog in an
// element that is already open, which is not entering a dialog: nothing is re-read on its own, and
// content that arrives with the dialog cannot announce as a live region -- the rule proved in
// tests/ux-announcements.test.js. So the name has to be focused and the consequence has to be the
// description. Asserting the rendered text alone would pass while none of it reached anyone.
const described = (page) => page.evaluate(() => {
  const dialog = document.querySelector("dialog[open]");
  return (dialog?.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent.replace(/\s+/g, " ").trim()).join(" ");
});
const focused = (page) => page.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.textContent?.replace(/\s+/g, " ").trim()}`);

test("the save confirmation names the account and the snapshot it replaces, by ear", async (t) => {
  const f = await fixture(t, "Existing account records");
  await f.page.getByRole("button", { name: "Save workspace to account", exact: true }).click();
  await f.page.getByRole("button", { name: "Save account snapshot", exact: true }).waitFor();
  // Focus on the submit button announced "Save account snapshot, button" and nothing else: not the
  // account, and not that an existing snapshot other browsers depend on is about to be replaced.
  assert.equal(await focused(f.page), "H2:Save workspace to account");
  const description = await described(f.page);
  assert.match(description, /This saves the current browser workspace, Browser records, to member@example\.test\./);
  assert.match(description, /replaces the account snapshot Existing account records \(revision 1\)\. Other browsers must restore/);
});

test("the first save to an empty account says so rather than naming a replacement", async (t) => {
  const f = await fixture(t);
  await f.page.getByRole("button", { name: "Save workspace to account", exact: true }).click();
  await f.page.getByRole("button", { name: "Save account snapshot", exact: true }).waitFor();
  const description = await described(f.page);
  assert.match(description, /This account has no saved workspace yet\./);
  assert.doesNotMatch(description, /replaces/, "there is nothing to replace; saying so would be false");
});

test("the account restore preview is read before its confirmation, like any other restore", async (t) => {
  const f = await fixture(t, "Account records");
  await f.page.getByRole("button", { name: "Restore account workspace", exact: true }).click();
  await f.page.locator("#dialog-restore-summary").waitFor();
  assert.equal(await focused(f.page), "H2:Review workspace restore");
  assert.match(await described(f.page), /^No changes have been saved\./);
});

test("the progress dialog is described, not falsely announced, and leaves no stale description", async (t) => {
  const f = await fixture(t, "Account records");
  let release; const delayed = new Promise((resolve) => { release = resolve; });
  await f.page.route("**/api/workspace**", async (route) => { await delayed; await route.continue(); });
  await f.page.getByRole("button", { name: "Restore account workspace", exact: true }).click();
  await f.page.locator("#dialog-snapshot-progress").waitFor();
  // A live region rendered with its dialog never fires. As role="status" this paragraph promised an
  // announcement that could not happen; it is the dialog's description instead.
  const progress = f.page.locator("#dialog-snapshot-progress");
  assert.equal(await progress.getAttribute("role"), null);
  assert.equal(await progress.getAttribute("aria-live"), null);
  assert.match(await described(f.page), /^Reading the saved account snapshot\. Your browser records have not changed\.$/);
  release();
  await f.page.locator("#dialog-restore-summary").waitFor();
  assert.doesNotMatch(await described(f.page), /Reading the saved account snapshot/);
});

test("a dialog that describes nothing carries no description left by the one it replaced", async (t) => {
  const f = await fixture(t);
  // The failure dialog sets no description of its own and replaces one that did. Stated precisely,
  // because it is easy to overclaim here: openModal rewrites the dialog's contents, so a description
  // left behind points at an element that no longer exists, and a dangling reference is ignored by
  // assistive technology. Nothing is misread today. What this guards is the attribute itself, so a
  // later dialog that happens to render an element of the same name cannot inherit a description
  // written for an earlier one. The assertion is on the attribute for that reason, not on the text.
  await f.page.route("**/api/workspace**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "The account workspace service is unavailable." }) }));
  await f.page.getByRole("button", { name: "Save workspace to account", exact: true }).click();
  await f.page.getByRole("heading", { name: "Account workspace unavailable", exact: true }).waitFor();
  assert.equal(await f.page.locator("#dialog").getAttribute("aria-describedby"), null);
});

test("a failed account read interrupts, because an alert is the one role announced on appearance", async (t) => {
  const f = await fixture(t);
  await f.page.route("**/api/workspace**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The account workspace service is unavailable." }) }));
  await f.page.getByRole("button", { name: "Save workspace to account", exact: true }).click();
  // Every dialog also carries an always-present hidden .form-error alert; this is the other one.
  const alert = f.page.locator('#dialog p[role="alert"]:not(.form-error)');
  await alert.waitFor();
  assert.match(await alert.textContent(), /unavailable/i);
  await f.page.getByRole("heading", { name: "Account workspace unavailable", exact: true }).waitFor();
  assert.equal(await localName(f.page), "Browser records");
});
