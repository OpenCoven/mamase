import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAppServer } from "../server.mjs";
import { createAuthApi } from "../auth-api.mjs";
import { parseAccessList, isApproved, accessRefusal } from "../access-list.mjs";
import { accessPhase, accessGateView } from "../access-gate.js";

const member = { id: "user_member", email: "Coven@Example.test", firstName: "Coven", lastName: "Member" };
const outsider = { id: "user_outsider", email: "outsider@example.test", firstName: "Out", lastName: "Sider" };

/**
 * A server whose WorkOS redirect URI matches its own ephemeral port, so the
 * account API accepts requests from the test client.
 */
async function fixture(context, { list = "coven@example.test", configured = true } = {}) {
  let handler = () => false;
  const auth = (...args) => handler(...args);
  auth.authorize = (request) => handler.authorize(request);
  const server = createAppServer({ auth });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const provider = {
    authorizationUrl: () => "https://auth.example.test/authorize",
    exchange: async () => ({ sealedSession: "member-seal" }),
    session: async (value) => value === "member-seal" ? { authenticated: true, user: member }
      : value === "outsider-seal" ? { authenticated: true, user: outsider }
      : { authenticated: false },
    logout: async () => "https://api.workos.com/user_management/sessions/logout?session_id=fixture",
  };
  handler = createAuthApi({
    provider,
    env: configured ? {
      WORKOS_API_KEY: "sk_test_synthetic_fixture",
      WORKOS_CLIENT_ID: "client_synthetic_fixture",
      WORKOS_COOKIE_PASSWORD: "synthetic-cookie-password-for-tests-only",
      WORKOS_REDIRECT_URI: `${base}/api/auth/callback`,
      ...(list === null ? {} : { MAMASE_ACCESS_LIST: list }),
    } : {},
    log: () => {},
  });
  const as = (seal) => (seal ? { headers: { Cookie: `mamase_session=${seal}` } } : {});
  return { base, as };
}

test("an approved list accepts addresses and whole domains, and rejects everything else", () => {
  const list = parseAccessList("Member@Coven.example, second@coven.example\n@familiar.example");
  assert.equal(isApproved(list, "member@coven.example"), true);
  assert.equal(isApproved(list, "MEMBER@COVEN.EXAMPLE"), true);
  assert.equal(isApproved(list, "anyone@familiar.example"), true);
  assert.equal(isApproved(list, "member@coven.example.evil"), false);
  assert.equal(isApproved(list, "member+alias@coven.example"), false, "Plus-addressing is a different address, not an alias of an approved one");
  assert.equal(isApproved(list, "familiar.example"), false);
  assert.equal(isApproved(list, ""), false);
  assert.equal(isApproved(list, undefined), false);
});

test("a malformed or empty list fails closed without echoing configured addresses", () => {
  assert.throws(() => parseAccessList("member@coven.example, not-an-address"), (error) => {
    assert.match(error.message, /entry 2/);
    assert.ok(!error.message.includes("coven.example"), "Configured addresses must not leak into configuration errors");
    return true;
  });
  const empty = parseAccessList("");
  assert.equal(empty.configured, false);
  assert.equal(isApproved(empty, "member@coven.example"), false);
  assert.match(accessRefusal(empty, { authenticated: true, email: "member@coven.example" }), /no approved accounts/i);
  const list = parseAccessList("member@coven.example");
  assert.match(accessRefusal(list, { authenticated: false }), /sign in/i);
  assert.match(accessRefusal(list, { authenticated: true, email: "other@coven.example" }), /not on the approved list/i);
  assert.equal(accessRefusal(list, { authenticated: true, email: "member@coven.example" }), "");
});

test("sessions report approval separately from sign-in", async (context) => {
  const { base, as } = await fixture(context);
  const signedOut = await (await fetch(`${base}/api/auth/session`)).json();
  assert.deepEqual([signedOut.configured, signedOut.authenticated, signedOut.approved], [true, false, false]);
  assert.match(signedOut.message, /sign in/i);
  const approved = await (await fetch(`${base}/api/auth/session`, as("member-seal"))).json();
  assert.deepEqual([approved.authenticated, approved.approved], [true, true]);
  assert.equal(approved.message, undefined);
  const pending = await (await fetch(`${base}/api/auth/session`, as("outsider-seal"))).json();
  assert.equal(pending.authenticated, true);
  assert.equal(pending.approved, false, "Signing in is not approval");
  assert.match(pending.message, /not on the approved list/i);
  assert.equal(pending.user.email, outsider.email);
});

test("an empty approved list approves nobody instead of opening the deployment", async (context) => {
  const { base, as } = await fixture(context, { list: null });
  const session = await (await fetch(`${base}/api/auth/session`, as("member-seal"))).json();
  assert.equal(session.authenticated, true);
  assert.equal(session.approved, false);
  assert.match(session.message, /no approved accounts/i);
  assert.equal((await fetch(`${base}/api/training/capabilities`, as("member-seal"))).status, 403);
});

test("workspace APIs stay closed until an approved account signs in", async (context) => {
  const { base, as } = await fixture(context);
  const refused = await fetch(`${base}/api/training/capabilities`);
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("cache-control"), "no-store");
  assert.match((await refused.json()).error, /sign in/i);
  const pending = await fetch(`${base}/api/training/capabilities`, as("outsider-seal"));
  assert.equal(pending.status, 403);
  assert.match((await pending.json()).error, /not on the approved list/i);
  const approved = await fetch(`${base}/api/training/capabilities`, as("member-seal"));
  assert.equal(approved.status, 200);
  assert.equal(typeof (await approved.json()).enabled, "boolean");
  const gatePage = await fetch(base);
  assert.equal(gatePage.status, 200, "The gate page itself must still load for a refused visitor");
  await gatePage.text();
});

test("a deployment without sign-in configured keeps its local workspace open", async (context) => {
  const { base } = await fixture(context, { configured: false });
  const session = await (await fetch(`${base}/api/auth/session`)).json();
  assert.equal(session.configured, false);
  assert.equal(session.approved, false);
  assert.equal((await fetch(`${base}/api/training/capabilities`)).status, 200);
  assert.equal(accessPhase({ phase: "unconfigured", approved: false }), "open");
});

test("an invalid approved list refuses workspace APIs instead of ignoring the setting", async (context) => {
  const { base, as } = await fixture(context, { list: "member@coven.example, not-an-address" });
  const refused = await fetch(`${base}/api/training/capabilities`, as("member-seal"));
  assert.equal(refused.status, 503);
  const body = await refused.json();
  assert.match(body.error, /approved-account list/i);
  assert.ok(!body.error.includes("coven.example"));
});

test("the browser gate only opens for an approved account", () => {
  assert.equal(accessPhase({ phase: "loading", approved: false }), "checking");
  assert.equal(accessPhase({ phase: "unconfigured", approved: false }), "open");
  assert.equal(accessPhase({ phase: "signed-out", approved: false }), "sign-in");
  assert.equal(accessPhase({ phase: "signed-in", approved: false }), "pending");
  assert.equal(accessPhase({ phase: "signed-in", approved: true }), "open");
  assert.equal(accessPhase({ phase: "error", approved: true }), "error", "An unreachable account service must not open the workspace");
  assert.equal(accessPhase(undefined), "checking");
});

test("the gate page shows no workspace data and escapes account text", () => {
  const view = accessGateView("pending", {
    phase: "signed-in", approved: false,
    user: { id: "user_1", email: "outsider@example.test", firstName: "<b>Ex</b>", lastName: "" },
    message: "Your account is not on the approved list for this deployment.",
  });
  assert.ok(!view.includes("<b>Ex</b>"));
  assert.match(view, /&lt;b&gt;Ex/);
  assert.match(view, /outsider@example.test/);
  assert.match(view, /data-action="sign-out"/);
  assert.match(view, /data-action="auth-refresh"/);
  assert.ok(!view.includes("nav-link"), "The gate renders no workspace navigation");
  assert.match(accessGateView("sign-in", { phase: "signed-out", approved: false }), /data-action="sign-in"/);
  assert.ok(!accessGateView("checking", { phase: "loading" }).includes("data-action"), "Nothing is actionable before access is known");
});
