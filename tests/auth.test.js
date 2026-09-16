import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAppServer } from "../server.mjs";
import { createAuthApi } from "../auth-api.mjs";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";

function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function fixture(context, overrides = {}) {
  let handler;
  const server = createAppServer({ auth: (...args) => handler(...args) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const calls = { exchanges: [], logout: 0, logs: [] };
  const user = { id: "user_fixture", email: "coven@example.test", firstName: "Coven", lastName: "Member", metadata: { private: "never-return-this" } };
  const provider = {
    authorizationUrl: ({ state, codeChallenge }) => `https://auth.example.test/authorize?state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`,
    exchange: async (input) => { calls.exchanges.push(input); return { sealedSession: "opaque-sealed-session" }; },
    session: async (value) => value === "opaque-sealed-session" ? { authenticated: true, user } : { authenticated: false },
    logout: async () => { calls.logout++; return "https://api.workos.com/user_management/sessions/logout?session_id=fixture"; },
    ...overrides.provider,
  };
  let time = Date.now();
  const env = {
    WORKOS_API_KEY: "sk_test_synthetic_fixture",
    WORKOS_CLIENT_ID: "client_synthetic_fixture",
    WORKOS_COOKIE_PASSWORD: "synthetic-cookie-password-for-tests-only",
    WORKOS_REDIRECT_URI: `${base}/api/auth/callback`,
    MAMASE_ACCESS_LIST: "coven@example.test",
    ...overrides.env,
  };
  handler = createAuthApi({ env, provider: overrides.realProvider ? null : provider, clock: () => time, log: (value) => calls.logs.push(value) });
  return { base, provider, calls, user, advance: (milliseconds) => { time += milliseconds; } };
}

async function begin(base, returnTo = "/#/settings", headers = {}) {
  const response = await fetch(`${base}/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { headers, redirect: "manual" });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  const cookie = response.headers.getSetCookie().find((value) => !value.includes("Max-Age=0"));
  assert.ok(cookie);
  return { response, location, state: location.searchParams.get("state"), cookie: cookie.split(";")[0] };
}

async function finish(base, flow, options = {}) {
  return fetch(`${base}/api/auth/callback?code=one-use-code&state=${encodeURIComponent(options.state || flow.state)}`, {
    redirect: "manual", headers: { Cookie: options.cookie || flow.cookie },
  });
}

test("an unconfigured account API reports its setup state without disabling the workspace", async (context) => {
  const server = createAppServer({ auth: createAuthApi({ env: {} }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/auth/session`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const session = await response.json();
  assert.equal(session.configured, false);
  assert.equal(session.authenticated, false);
  assert.match(session.message, /not configured/i);
  const index = await fetch(base);
  assert.equal(index.status, 200);
  await index.text();
});

test("unconfigured sign-in fails explicitly instead of redirecting to a pretend provider", async (context) => {
  const server = createAppServer({ auth: createAuthApi({ env: {} }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, { redirect: "manual" });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("location"), null);
  assert.match((await response.json()).error, /not configured/i);
});

test("sign-in binds a random PKCE transaction to an HttpOnly browser cookie", async (context) => {
  const { base, calls } = await fixture(context);
  const flow = await begin(base, "/#/playground");
  const second = await begin(base);
  assert.notEqual(flow.state, second.state);
  assert.match(flow.cookie, /^mamase_auth_state=/);
  assert.match(flow.response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(flow.response.headers.get("set-cookie"), /SameSite=Lax/);
  assert.match(flow.location.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  const response = await finish(base, flow);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${base}/#/playground`);
  assert.equal(calls.exchanges.length, 1);
  assert.equal(createHash("sha256").update(calls.exchanges[0].codeVerifier).digest("base64url"), flow.location.searchParams.get("code_challenge"));
  assert.match(response.headers.getSetCookie().join(";"), /mamase_session=opaque-sealed-session/);
  assert.match(response.headers.getSetCookie().join(";"), /HttpOnly/);
});

test("callback state mismatches, tampering and expired transactions never exchange a code", async (context) => {
  const { base, calls, advance } = await fixture(context);
  const flow = await begin(base);
  for (const options of [{ state: "wrong-state" }, { cookie: "mamase_auth_state=corrupt" }]) {
    const response = await finish(base, flow, options);
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location"), /auth_error=invalid_callback/);
  }
  advance(11 * 60 * 1000);
  assert.match((await finish(base, flow)).headers.get("location"), /auth_error=invalid_callback/);
  assert.equal(calls.exchanges.length, 0);
});

test("return destinations and Host headers cannot redirect sign-in to another site", async (context) => {
  const { base } = await fixture(context);
  for (const returnTo of ["https://evil.example", "//evil.example", "/\\evil.example", "/?next=evil", "/#/settings\n"]) {
    const response = await fetch(`${base}/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { redirect: "manual" });
    assert.equal(response.status, 400, returnTo);
    assert.equal(response.headers.get("location"), null);
  }
  assert.equal((await rawGet(`${base}/api/auth/session`, { Host: "evil.example" })).status, 403);
});

test("secure deployments use host-only Secure session and transaction cookies", async (context) => {
  const { base } = await fixture(context, { env: { WORKOS_REDIRECT_URI: "https://mamase.example/api/auth/callback" } });
  const flow = await rawGet(`${base}/api/auth/login`, { Host: "mamase.example" });
  assert.equal(flow.status, 302);
  const cookie = flow.headers["set-cookie"][0];
  assert.match(cookie, /^__Host-mamase_auth_state=/);
  assert.match(cookie, /; Secure/);
  assert.ok(!cookie.includes("Domain="));
  const state = new URL(flow.headers.location).searchParams.get("state");
  const completed = await rawGet(`${base}/api/auth/callback?code=fixture&state=${state}`, { Host: "mamase.example", Cookie: cookie.split(";")[0] });
  assert.equal(completed.status, 303);
  const session = completed.headers["set-cookie"].find((value) => value.startsWith("__Host-mamase_session="));
  assert.match(session, /; Secure/);
  assert.ok(!session.includes("Domain="));
});

test("session responses expose only profile fields and rotate refreshed sealed cookies", async (context) => {
  const { base, user } = await fixture(context, {
    provider: { session: async () => ({ authenticated: true, user: { id: "user_fixture", email: "coven@example.test", firstName: "Coven", lastName: "Member", private: "never-return-this" }, sealedSession: "rotated-seal" }) },
  });
  const response = await fetch(`${base}/api/auth/session`, { headers: { Cookie: "mamase_session=old-seal" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.user, { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName });
  assert.equal(body.authenticated, true);
  assert.ok(!JSON.stringify(body).includes("seal"));
  assert.ok(!JSON.stringify(body).includes("never-return-this"));
  assert.match(response.headers.get("set-cookie"), /mamase_session=rotated-seal/);
});

test("logout requires same-origin POST and does not modify browser workspace storage", async (context) => {
  const { base, calls } = await fixture(context);
  const path = `${base}/api/auth/logout`;
  assert.equal((await fetch(path)).status, 405);
  assert.equal((await fetch(path, { method: "POST" })).status, 403);
  assert.equal((await fetch(path, { method: "POST", headers: { Origin: "https://evil.example", "X-Mamase-Auth": "1" } })).status, 403);
  const response = await fetch(path, { method: "POST", headers: { Origin: base, "X-Mamase-Auth": "1", Cookie: "mamase_session=opaque-sealed-session" } });
  assert.equal(response.status, 200);
  assert.match((await response.json()).logoutUrl, /^https:\/\/api.workos.com\//);
  assert.match(response.headers.getSetCookie().join(";"), /Max-Age=0/);
  assert.equal(calls.logout, 1);
});

test("provider outages are explicit, preserve existing cookies and redact internal errors", async (context) => {
  const { base, calls } = await fixture(context, { provider: { session: async () => { throw new Error("secret-token must not leak"); } } });
  const response = await fetch(`${base}/api/auth/session`, { headers: { Cookie: "mamase_session=opaque-sealed-session" } });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.ok(!(await response.text()).includes("secret-token"));
  assert.ok(!JSON.stringify(calls.logs).includes("secret-token"));
  assert.equal(calls.logs.length, 1);
});

test("partial or unsafe configuration cannot create an authenticated-looking session", async (context) => {
  const { base } = await fixture(context, { env: { WORKOS_COOKIE_PASSWORD: "short" } });
  const response = await fetch(`${base}/api/auth/session`);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /configuration/i);
});

test("malformed account cookies can be cleared without trapping the browser in a retry loop", async (context) => {
  const { base, calls } = await fixture(context);
  const response = await fetch(`${base}/api/auth/session`, { headers: { Cookie: "mamase_session=%ZZ" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authenticated, false);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Origin: base, "X-Mamase-Auth": "1", Cookie: "mamase_session=%ZZ" } });
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).logoutUrl, `${base}/#/settings`);
  assert.equal(calls.logout, 0);
});

test("cancelled callbacks and provider rejection never erase an existing account session", async (context) => {
  const { base, provider, calls } = await fixture(context);
  const flow = await begin(base);
  const cancelled = await fetch(`${base}/api/auth/callback?error=access_denied&state=${flow.state}`, {
    redirect: "manual", headers: { Cookie: `${flow.cookie}; mamase_session=existing-session` },
  });

  assert.match(cancelled.headers.get("location"), /auth_error=cancelled/);
  assert.ok(!cancelled.headers.getSetCookie().some((value) => value.startsWith("mamase_session=")));
  provider.exchange = async () => { throw new Error("private-provider-response"); };
  const failed = await finish(base, flow);
  assert.match(failed.headers.get("location"), /auth_error=exchange_failed/);
  assert.ok(!failed.headers.getSetCookie().some((value) => value.startsWith("mamase_session=")));
  assert.ok(!JSON.stringify(calls.logs).includes("private-provider-response"));
});

test("the real WorkOS SDK creates the hosted provider-picker URL without exposing a secret", async (context) => {
  const { base } = await fixture(context, { realProvider: true });
  const { location } = await begin(base);
  assert.equal(location.hostname, "api.workos.com");
  assert.equal(location.searchParams.get("provider"), "authkit");
  assert.equal(location.searchParams.get("client_id"), "client_synthetic_fixture");
  assert.equal(location.searchParams.get("redirect_uri"), `${base}/api/auth/callback`);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(!location.href.includes("sk_test_synthetic_fixture"));
});
