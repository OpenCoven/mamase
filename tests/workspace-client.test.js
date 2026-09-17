import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspace } from "../workspace.js";

const module = await import("../workspace-client.js").catch(() => ({}));
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const record = (name, revision = 1) => ({ revision, payload: { ...createWorkspace(), name }, updatedAt: "2026-09-17T00:00:00.000Z" });
function client(fetch) {
  assert.equal(typeof module.WorkspaceClient, "function", "The account workspace client must exist");
  return new module.WorkspaceClient({ fetch });
}

test("account snapshots are validated and writes carry the account and observed revision", async () => {
  const calls = [];
  const api = client(async (url, options) => { calls.push({ url, ...options }); return response(options.method === "PUT" ? { revision: 3, updatedAt: "2026-09-17T00:00:00.000Z" } : record("remote", 2)); });
  const loaded = await api.read("account-a");
  assert.equal(loaded.payload.name, "remote");
  await api.save("account-a", createWorkspace(), loaded.revision);
  assert.equal(calls[1].headers["X-Mamase-Account"], "account-a");
  assert.equal(JSON.parse(calls[1].body).baseRevision, 2);
  assert.equal(calls[1].credentials, "same-origin");
});

test("conflicts are explicit and never retried as an overwrite", async () => {
  let calls = 0;
  const api = client(async () => { calls++; return response({ error: "Reload the latest data.", ...record("other browser", 2) }, 409); });
  await assert.rejects(api.save("account-a", createWorkspace(), 1), (error) => error.status === 409 && /latest/.test(error.message));
  assert.equal(calls, 1);
});

test("malformed and oversized snapshots cannot be restored or uploaded", async () => {
  let calls = 0;
  const api = client(async () => { calls++; return response({ revision: 1, payload: {}, updatedAt: "today" }); });
  await assert.rejects(api.read("account-a"), /workspace|response/i);
  await assert.rejects(api.save("account-a", {}, 0), /workspace/i);
  assert.equal(calls, 1);
});

test("missing storage and a non-JSON proxy response produce actionable errors", async () => {
  const api = client(async () => response({ error: "No account storage configured. Your workspace stays in this browser." }, 503));
  await assert.rejects(api.read("account-a"), /stays in this browser/);
  const proxy = client(async () => new Response("Bad gateway", { status: 502 }));
  await assert.rejects(proxy.read("account-a"), /unavailable/i);
});
