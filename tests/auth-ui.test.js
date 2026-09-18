import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";
import { createAppServer } from "../server.mjs";
import { createWorkspace, STORAGE_KEY } from "../workspace.js";
import { createAuthApi } from "../auth-api.mjs";

async function browserFixture(context, auth) {
  const server = createAppServer({ auth: auth || createAuthApi({ env: {} }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const workspace = createWorkspace();
  await page.addInitScript(({ workspace, key }) => localStorage.setItem(key, JSON.stringify(workspace)), { workspace, key: STORAGE_KEY });
  return { page, workspace, base: `http://127.0.0.1:${server.address().port}` };
}

test("account setup is explicit and the offline workspace remains usable", async (context) => {
  const { page, workspace, base } = await browserFixture(context);
  await page.goto(`${base}/#/settings`);
  await page.locator("#main h1").waitFor();
  assert.equal(await page.getByRole("heading", { name: "Account", exact: true }).count(), 1);
  await page.locator('#account-panel[data-phase="unconfigured"]').waitFor();
  assert.match(await page.locator("#account-panel").innerText(), /not configured/i);
  assert.equal(await page.locator('#account-panel [data-action="sign-in"]').count(), 0);
  assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY), workspace);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
});

test("an approved account reaches the workspace and signing out returns to the gate", async (context) => {
  let authenticated = true;
  let logoutRequests = 0;
  const auth = async (request, response, pathname) => {
    if (!pathname.startsWith("/api/auth/")) return false;
    response.setHeader("Content-Type", "application/json");
    if (pathname === "/api/auth/logout") {
      assert.equal(request.method, "POST");
      assert.equal(request.headers["x-mamase-auth"], "1");
      logoutRequests++;
      authenticated = false;
      response.end(JSON.stringify({ logoutUrl: `http://${request.headers.host}/#/settings` }));
    } else response.end(JSON.stringify({
      configured: true, authenticated, approved: authenticated,
      user: authenticated ? { id: "user_fixture", email: "coven@example.test", firstName: "<b>Coven</b>", lastName: "Member" } : null,
    }));
    return true;
  };
  const { page, workspace, base } = await browserFixture(context, auth);
  await page.goto(`${base}/#/settings`);
  await page.locator("#main h1").waitFor();
  assert.equal(await page.getByRole("heading", { name: "Account", exact: true }).count(), 1);
  await page.locator('#account-panel[data-phase="signed-in"]').waitFor();
  assert.equal(await page.locator("#account-panel b").count(), 0);
  assert.match(await page.locator("#account-panel").innerText(), /coven@example.test/);
  assert.match(await page.locator("#account-panel").innerText(), /working copy is shared across sign-ins/i);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.locator('main.gate[data-access="sign-in"]').waitFor();
  assert.equal(await page.locator(".sidebar").count(), 0, "Signing out closes the workspace behind the gate");
  assert.equal(await page.getByRole("button", { name: "Sign in", exact: true }).count(), 1);
  assert.equal(logoutRequests, 1);
  assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY), workspace);
});

test("an account waiting for approval cannot move past the gate into any workspace view", async (context) => {
  const auth = async (_request, response, pathname) => {
    if (!pathname.startsWith("/api/auth/")) return false;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      configured: true, authenticated: true, approved: false,
      user: { id: "user_pending", email: "outsider@example.test", firstName: "Out", lastName: "Sider" },
      message: "Your account is not on the approved list for this deployment.",
    }));
    return true;
  };
  const { page, workspace, base } = await browserFixture(context, auth);
  await page.goto(`${base}/#/home`);
  const gate = page.locator('main.gate[data-access="pending"]');
  await gate.waitFor();
  assert.match(await gate.innerText(), /approval/i);
  assert.match(await gate.innerText(), /outsider@example.test/);
  assert.equal(await page.locator(".sidebar").count(), 0);
  assert.equal(await page.getByRole("link", { name: "Datasets" }).count(), 0);
  for (const view of ["sessions", "datasets", "checkpoints", "settings", "playground", "testing"]) {
    await page.goto(`${base}/#/${view}`);
    await gate.waitFor();
    assert.equal(await page.locator(".sidebar, #account-panel, table").count(), 0, `The ${view} view must stay behind the gate`);
  }
  await page.keyboard.press("Control+k");
  assert.equal(await page.locator("dialog[open]").count(), 0, "Workspace search stays closed behind the gate");
  assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY), workspace);
});

test("account errors keep the workspace closed and stay actionable", async (context) => {
  let unavailable = true;
  const auth = async (_request, response, pathname) => {
    if (!pathname.startsWith("/api/auth/")) return false;
    response.writeHead(unavailable ? 503 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(unavailable ? { error: "Account service unavailable. Try again." } : { configured: true, authenticated: false, approved: false }));
    return true;
  };
  const { page, workspace, base } = await browserFixture(context, auth);
  await page.goto(`${base}/#/settings`);
  await page.locator('main.gate[data-access="error"]').waitFor();
  assert.equal(await page.locator(".sidebar").count(), 0, "An unreachable account service must not open the workspace");
  unavailable = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.locator('main.gate[data-access="sign-in"]').waitFor();
  assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY), workspace);
});
