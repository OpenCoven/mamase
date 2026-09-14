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

test("signed-in account controls escape profile text and sign out without deleting local records", async (context) => {
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
      configured: true, authenticated,
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
  assert.match(await page.locator("#account-panel").innerText(), /not.*sync|not.*isolated/i);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.locator('#account-panel[data-phase="signed-out"]').waitFor();
  assert.equal(logoutRequests, 1);
  assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY), workspace);
});

test("account errors are actionable without resetting workspace records", async (context) => {
  let unavailable = true;
  const auth = async (_request, response, pathname) => {
    if (!pathname.startsWith("/api/auth/")) return false;
    response.writeHead(unavailable ? 503 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(unavailable ? { error: "Account service unavailable. Try again." } : { configured: true, authenticated: false }));
    return true;
  };
  const { page, workspace, base } = await browserFixture(context, auth);
  await page.goto(`${base}/#/settings`);
  await page.locator("#main h1").waitFor();
  assert.equal(await page.getByRole("heading", { name: "Account", exact: true }).count(), 1);
  await page.locator('#account-panel[data-phase="error"]').waitFor();
  unavailable = false;
  await page.getByRole("button", { name: "Retry account connection", exact: true }).click();
  await page.locator('#account-panel[data-phase="signed-out"]').waitFor();
  assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY), workspace);
});
