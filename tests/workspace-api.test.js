import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAppServer } from "../server.mjs";
import { createWorkspace } from "../workspace.js";

const skip = false;

// A stand-in for the account service. `authorize` is the only thing the API consults, and it is the
// same call the gate already makes, so a test account here is exactly as trusted as a real session.
const authFor = (user) => Object.assign(async () => false, { authorize: async () => ({ gated: true, authenticated: Boolean(user), approved: Boolean(user), refusal: "Sign in.", user }) });
const val = { id: "user_val", email: "val@opencoven.ai" };
const buns = { id: "user_buns", email: "bunsthedev@gmail.com" };
const workspace = (name) => ({ ...createWorkspace(), name });

async function serve(context, user) {
  // HTTP behavior runs without a database; workspace-store.test.js exercises the real SQL.
  const store = context.store ??= {
    rows: new Map(),
    async read(id) { return structuredClone(this.rows.get(id) || null); },
    async write(id, { payload, baseRevision }) {
      const stored = await this.read(id);
      if ((stored?.revision || 0) !== baseRevision) return { conflict: true, stored };
      const result = { revision: baseRevision + 1, updatedAt: new Date().toISOString() };
      this.rows.set(id, { ...result, payload });
      return result;
    },
  };
  const server = createAppServer({ auth: authFor(user), store, inference: null });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => { await new Promise((resolve) => server.close(resolve));  });
  return `http://127.0.0.1:${server.address().port}`;
}
const put = (base, body, accountId = val.id) => fetch(`${base}/api/workspace`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Mamase-Account": accountId }, body: JSON.stringify(body) });

test("a signed-in account saves and reads back its own workspace", { skip }, async (context) => {
  const base = await serve(context, val);
  const empty = await (await fetch(`${base}/api/workspace`)).json();
  assert.deepEqual(empty, { revision: 0, payload: null, updatedAt: null });

  const saved = await put(base, { baseRevision: 0, payload: workspace("The Coven") });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);

  const read = await (await fetch(`${base}/api/workspace`)).json();
  assert.equal(read.revision, 1);
  assert.equal(read.payload.name, "The Coven");
  // A per-account answer must never be reused by a shared cache.
  const headers = (await fetch(`${base}/api/workspace`)).headers;
  assert.match(headers.get("cache-control"), /no-store/);
  assert.match(headers.get("vary"), /Cookie/);
});

test("one account never sees or overwrites another's workspace", { skip }, async (context) => {
  const hers = await serve(context, val);
  await put(hers, { baseRevision: 0, payload: workspace("val's coven") });
  const theirs = await serve(context, buns);
  // The second account is keyed by its own session, so it starts empty however the first one saved.
  assert.deepEqual(await (await fetch(`${theirs}/api/workspace`)).json(), { revision: 0, payload: null, updatedAt: null });
  await put(theirs, { baseRevision: 0, payload: workspace("buns' coven") }, buns.id);
  assert.equal((await (await fetch(`${hers}/api/workspace`)).json()).payload.name, "val's coven");
  assert.equal((await (await fetch(`${theirs}/api/workspace`)).json()).payload.name, "buns' coven");
});

test("the account is taken from the session, never from the request body", { skip }, async (context) => {
  const base = await serve(context, val);
  await put(base, { baseRevision: 0, payload: workspace("val's coven") });
  // Naming another account in the body must change nothing about whose workspace is written.
  const forged = await put(base, { baseRevision: 1, payload: workspace("forged"), accountId: buns.id, email: buns.email });
  assert.equal(forged.status, 200);
  const other = await serve(context, buns);
  assert.equal((await (await fetch(`${other}/api/workspace`)).json()).revision, 0,
    "a body-supplied account id must not be able to write into another account");
});

test("a stale save is refused with the stored workspace, not silently merged", { skip }, async (context) => {
  const base = await serve(context, val);
  await put(base, { baseRevision: 0, payload: workspace("first") });
  await put(base, { baseRevision: 1, payload: workspace("second") });
  const stale = await put(base, { baseRevision: 1, payload: workspace("stale") });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.match(body.error, /Reload the latest data/);
  assert.equal(body.revision, 2);
  assert.equal(body.payload.name, "second", "the refusal must carry what is actually stored so the client can recover");
  assert.equal((await (await fetch(`${base}/api/workspace`)).json()).payload.name, "second");
});

test("signed out, storage refuses rather than falling back to a shared workspace", { skip }, async (context) => {
  const base = await serve(context, null);
  assert.equal((await fetch(`${base}/api/workspace`)).status, 401);
  assert.equal((await put(base, { baseRevision: 0, payload: workspace("anonymous") })).status, 401);
});

test("a deployment with no database says so instead of pretending to save", { skip: false }, async (context) => {
  const server = createAppServer({ auth: authFor(val), store: null, inference: null });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workspace`);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /stays in this browser/);
});

test("malformed saves are refused in words, and change nothing", { skip }, async (context) => {
  const base = await serve(context, val);
  await put(base, { baseRevision: 0, payload: workspace("intact") });
  for (const [body, pattern] of [
    [{ payload: workspace("x") }, /revision this save was based on/],
    [{ baseRevision: -1, payload: workspace("x") }, /revision this save was based on/],
    [{ baseRevision: 1 }, /payload as an object/],
    [{ baseRevision: 1, payload: [] }, /payload as an object/],
  ]) {
    const response = await put(base, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, pattern);
  }
  const raw = await fetch(`${base}/api/workspace`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Mamase-Account": val.id }, body: "{not json" });
  assert.equal(raw.status, 400);
  assert.match((await raw.json()).error, /not valid JSON\. No changes were made/);
  assert.equal((await (await fetch(`${base}/api/workspace`)).json()).payload.name, "intact");
});


test("invalid workspace records cannot poison an account snapshot", async (context) => {
  const base = await serve(context, val);
  for (const payload of [{}, { ...workspace("invalid"), programs: [] }]) {
    const response = await put(base, { baseRevision: 0, payload });
    assert.equal(response.status, 400);
  }
  assert.equal((await (await fetch(`${base}/api/workspace`)).json()).revision, 0);
});

test("a cookie account change cannot redirect an already prepared save", async (context) => {
  const base = await serve(context, buns);
  const response = await put(base, { baseRevision: 0, payload: workspace("belongs to val") });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /account changed/i);
  assert.equal((await (await fetch(`${base}/api/workspace`)).json()).revision, 0);
});

test("mutations require the same-origin client header and JSON content type", async (context) => {
  const base = await serve(context, val);
  for (const headers of [{}, { "X-Mamase-Account": val.id, "Content-Type": "text/plain" }]) {
    const response = await fetch(`${base}/api/workspace`, { method: "PUT", headers,
      body: JSON.stringify({ baseRevision: 0, payload: workspace("cross-origin") }) });
    assert.equal(response.status, 403);
  }
});

test("hosted requests accept a framework-parsed body after the stream is consumed", async (context) => {
  const { createServer } = await import("node:http");
  const { createWorkspaceApi } = await import("../workspace-api.mjs");
  let payload;
  const handle = createWorkspaceApi({ auth: authFor(val), store: { async write(id, value) {
    payload = value.payload; return { revision: 1, updatedAt: new Date().toISOString() };
  } } });
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    Object.defineProperty(request, "body", { get: () => JSON.parse(Buffer.concat(chunks).toString()) });
    await handle(request, response, "/api/workspace");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await put(base, { baseRevision: 0, payload: workspace("Hosted snapshot") });
  assert.equal(response.status, 200);
  assert.equal(payload.name, "Hosted snapshot");
  const oversized = await put(base, { baseRevision: 0, payload: { ...workspace("big"), extra: "x".repeat(5 * 1024 * 1024) } });
  assert.equal(oversized.status, 413);
  const malformed = await fetch(`${base}/api/workspace`, { method: "PUT",
    headers: { "Content-Type": "application/json", "X-Mamase-Account": val.id }, body: "{broken" });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /not valid JSON/);
  assert.equal(payload.name, "Hosted snapshot");
});

test("unapproved accounts cannot read snapshots even if they have a user profile", async (context) => {
  const auth = Object.assign(async () => false, { authorize: async () => ({ authenticated: true, approved: false, user: val }) });
  const server = createAppServer({ auth, store: { read: () => assert.fail("Unapproved account reached storage") }, inference: null });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workspace`);
  assert.equal(response.status, 403);
});

test("DELETE requires the observed revision and returns stale-delete conflicts", async (context) => {
  const base = await serve(context, val);
  let calls = 0;
  context.store.erase = async (id, revision) => {
    calls++; assert.equal(id, val.id); assert.equal(revision, 1);
    return { conflict: true, stored: { revision: 2, payload: workspace("newer"), updatedAt: "2026-09-17T00:00:00.000Z" } };
  };
  const headers = { "Content-Type": "application/json", "X-Mamase-Account": val.id };
  const missing = await fetch(`${base}/api/workspace`, { method: "DELETE", headers, body: "{}" });
  assert.equal(missing.status, 400); assert.equal(calls, 0);
  const stale = await fetch(`${base}/api/workspace`, { method: "DELETE", headers, body: JSON.stringify({ baseRevision: 1 }) });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).payload.name, "newer"); assert.equal(calls, 1);
});
