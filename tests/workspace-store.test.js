import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { WorkspaceStore } from "../workspace-store.mjs";

// These run against a real Postgres when MAMASE_TEST_DATABASE_URL is set, and skip otherwise: a
// store that is only ever exercised against a fake proves nothing about the SQL that guards a
// concurrent write. npm run test:workspace starts a disposable cluster when no URL is supplied.
const connectionString = process.env.MAMASE_TEST_DATABASE_URL;
const skip = connectionString ? false : "Set MAMASE_TEST_DATABASE_URL to exercise the workspace store.";

const workspace = (name) => ({ version: 1, name, programs: [], datasets: [], runs: [], artifacts: [], evaluations: [] });
const account = () => `acct-${Math.random().toString(36).slice(2, 10)}`;

test("an account claims, reads back and revises its own workspace", { skip }, async (context) => {
  const store = new WorkspaceStore({ connectionString });
  context.after(() => store.close());
  const id = account();

  assert.equal(await store.read(id), null, "an account with no saved workspace reads as absent, not as empty");

  const claimed = await store.write(id, { email: "val@opencoven.ai", payload: workspace("The Coven"), baseRevision: 0 });
  assert.equal(claimed.revision, 1);
  const first = await store.read(id);
  assert.equal(first.revision, 1);
  assert.equal(first.payload.name, "The Coven");

  const revised = await store.write(id, { email: "val@opencoven.ai", payload: workspace("Renamed"), baseRevision: 1 });
  assert.equal(revised.revision, 2);
  assert.equal((await store.read(id)).payload.name, "Renamed");
});

test("a write based on a stale revision is refused and changes nothing", { skip }, async (context) => {
  const store = new WorkspaceStore({ connectionString });
  context.after(() => store.close());
  const id = account();
  await store.write(id, { email: "val@opencoven.ai", payload: workspace("original"), baseRevision: 0 });
  await store.write(id, { email: "val@opencoven.ai", payload: workspace("second browser"), baseRevision: 1 });

  // A tab that read revision 1 and saved after the other tab reached 2.
  const stale = await store.write(id, { email: "val@opencoven.ai", payload: workspace("stale overwrite"), baseRevision: 1 });
  assert.equal(stale.conflict, true);
  assert.equal(stale.revision, undefined);
  assert.equal(stale.stored.revision, 2);
  assert.equal((await store.read(id)).payload.name, "second browser", "the refused write must not have landed");
});

test("two first writes race and exactly one claims the account", { skip }, async (context) => {
  const store = new WorkspaceStore({ connectionString });
  context.after(() => store.close());
  const id = account();
  // Both browsers believe the account is empty. Last-write-wins would lose one of them silently.
  const [a, b] = await Promise.all([
    store.write(id, { email: "val@opencoven.ai", payload: workspace("browser A"), baseRevision: 0 }),
    store.write(id, { email: "val@opencoven.ai", payload: workspace("browser B"), baseRevision: 0 }),
  ]);
  const claimed = [a, b].filter((result) => !result.conflict);
  const refused = [a, b].filter((result) => result.conflict);
  assert.equal(claimed.length, 1, "exactly one claim may succeed");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].stored.revision, 1);
  assert.equal((await store.read(id)).revision, 1);
});

test("concurrent revisions never skip or reuse a revision number", { skip }, async (context) => {
  const store = new WorkspaceStore({ connectionString });
  context.after(() => store.close());
  const id = account();
  await store.write(id, { email: "val@opencoven.ai", payload: workspace("base"), baseRevision: 0 });
  // Ten tabs all saving from revision 1: one wins, nine are told to reload.
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    store.write(id, { email: "val@opencoven.ai", payload: workspace(`tab ${index}`), baseRevision: 1 })));
  assert.equal(results.filter((result) => !result.conflict).length, 1);
  assert.equal((await store.read(id)).revision, 2);
});

test("accounts cannot read or overwrite each other", { skip }, async (context) => {
  const store = new WorkspaceStore({ connectionString });
  context.after(() => store.close());
  const [one, two] = [account(), account()];
  await store.write(one, { email: "val@opencoven.ai", payload: workspace("val's coven"), baseRevision: 0 });
  await store.write(two, { email: "bunsthedev@gmail.com", payload: workspace("buns' coven"), baseRevision: 0 });
  assert.equal((await store.read(one)).payload.name, "val's coven");
  assert.equal((await store.read(two)).payload.name, "buns' coven");
  // Erasing one account leaves the other untouched.
  assert.equal((await store.erase(one, 1)).erased, true);
  assert.equal((await store.read(one)).payload, null);
  assert.equal((await store.read(two)).payload.name, "buns' coven");
});

test("a malformed base revision is rejected before any SQL runs", { skip }, async (context) => {
  const store = new WorkspaceStore({ connectionString });
  context.after(() => store.close());
  for (const baseRevision of [-1, 1.5, "1", null, undefined, NaN]) {
    await assert.rejects(() => store.write(account(), { email: "val@opencoven.ai", payload: workspace("x"), baseRevision }),
      /baseRevision/, String(baseRevision));
  }
});


test("erasing and recreating a snapshot cannot reuse a stale revision", { skip }, async (context) => {
  const store = new WorkspaceStore({ connectionString }); context.after(() => store.close());
  const id = account();
  await store.write(id, { email: "member@example.test", payload: workspace("old"), baseRevision: 0 });
  await store.erase(id, 1);
  const tombstone = await store.read(id);
  assert.equal(tombstone.payload, null);
  assert.equal(tombstone.revision, 2);
  await store.write(id, { email: "member@example.test", payload: workspace("new"), baseRevision: tombstone.revision });
  const stale = await store.write(id, { email: "member@example.test", payload: workspace("stale"), baseRevision: 1 });
  assert.equal(stale.conflict, true);
  assert.equal((await store.read(id)).payload.name, "new");
});


test("a transient first database failure can be retried without restarting", { skip }, async (context) => {
  const query = pg.Pool.prototype.query;
  let first = true;
  context.mock.method(pg.Pool.prototype, "query", function (...args) {
    if (first) { first = false; return Promise.reject(new Error("synthetic temporary outage")); }
    return query.apply(this, args);
  });
  const store = new WorkspaceStore({ connectionString }); context.after(() => store.close());
  await assert.rejects(store.read(account()), /temporary outage/);
  assert.equal(await store.read(account()), null);
});

test("a stale deletion preserves the newer snapshot", { skip }, async (context) => {
  const store = new WorkspaceStore({ connectionString }); context.after(() => store.close());
  const id = account();
  await store.write(id, { email: "member@example.test", payload: workspace("old"), baseRevision: 0 });
  await store.write(id, { email: "member@example.test", payload: workspace("new"), baseRevision: 1 });
  assert.equal((await store.erase(id, 1)).conflict, true);
  assert.equal((await store.read(id)).payload.name, "new");
  assert.equal((await store.erase(id, 2)).erased, true);
  assert.equal((await store.read(id)).revision, 3);
});

test("only exact loopback database hosts disable TLS verification", (context) => {
  const configurations = [];
  context.mock.method(pg, "Pool", function (options) { configurations.push(options); });
  for (const host of ["localhost", "127.0.0.1", "localhost.remote.example", "127.0.0.10", "db.example"]) {
    new WorkspaceStore({ connectionString: `postgresql://fixture@${host}/test` });
  }
  assert.deepEqual(configurations.map(({ ssl }) => ssl), [false, false,
    { rejectUnauthorized: true }, { rejectUnauthorized: true }, { rejectUnauthorized: true }]);
});
