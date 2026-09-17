import pg from "pg";

/**
 * Per-account workspace storage.
 *
 * What is stored is the workspace *record*: programs, recipes, run history,
 * dataset fingerprints and provenance, artifact paths, evaluations and recorded
 * review decisions. What is NOT stored, because it never reaches the browser
 * workspace in the first place, is dataset contents, prompts, responses and
 * model weights. Those stay on the machine that holds them.
 *
 * Writes are revision-guarded rather than last-write-wins. Two browsers signed
 * into one account must not silently overwrite each other's recorded
 * observations, so a write states the revision it was based on and is refused
 * when the stored revision has moved on. The caller then reloads and retries,
 * which is the same conflict the app already handles between tabs.
 */

export const SCHEMA = `
  create table if not exists workspaces (
    account_id  text primary key,
    email       text not null,
    revision    bigint not null default 1,
    payload     jsonb not null,
    updated_at  timestamptz not null default now()
  );
`;

export class WorkspaceStore {
  #pool;
  #ready;

  constructor({ connectionString, ssl } = {}) {
    if (!connectionString) throw new Error("WorkspaceStore needs a connection string.");
    // Neon terminates TLS and its hostnames are public, so verify certificates there. A local
    // Postgres over loopback has no certificate to verify and must not be forced into one.
    const remote = !["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname);
    this.#pool = new pg.Pool({ connectionString, ssl: ssl ?? (remote ? { rejectUnauthorized: true } : false), max: 3 });
  }

  /** Create the table once per process, not once per request. */
  async ready() {
    this.#ready ??= this.#pool.query(SCHEMA).then(() => true).catch((error) => { this.#ready = undefined; throw error; });
    return this.#ready;
  }

  async close() { await this.#pool.end(); }

  /** The stored workspace for one account, or null when it has never saved one. */
  async read(accountId) {
    await this.ready();
    const { rows } = await this.#pool.query(
      "select revision, payload, updated_at from workspaces where account_id = $1", [accountId]);
    if (!rows.length) return null;
    return { revision: Number(rows[0].revision), payload: rows[0].payload, updatedAt: rows[0].updated_at.toISOString() };
  }

  /**
   * Store a workspace for one account.
   *
   * `baseRevision` is the revision the caller last read: 0 to claim an account
   * that has never saved. A mismatch returns `{ conflict: true }` with the
   * stored record, and nothing is written.
   */
  async write(accountId, { email, payload, baseRevision }) {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error("baseRevision must be a non-negative safe integer.");
    await this.ready();
    const serialized = JSON.stringify(payload);
    if (baseRevision === 0) {
      // Claim only if absent. A row already there means another browser got here first.
      const { rows } = await this.#pool.query(
        `insert into workspaces (account_id, email, revision, payload)
         values ($1, $2, 1, $3::jsonb)
         on conflict (account_id) do nothing
         returning revision, updated_at`, [accountId, email, serialized]);
      if (!rows.length) return { conflict: true, stored: await this.read(accountId) };
      return { revision: Number(rows[0].revision), updatedAt: rows[0].updated_at.toISOString() };
    }
    const { rows } = await this.#pool.query(
      `update workspaces set payload = $3::jsonb, email = $2, revision = revision + 1, updated_at = now()
       where account_id = $1 and revision = $4
       returning revision, updated_at`, [accountId, email, serialized, baseRevision]);
    if (!rows.length) return { conflict: true, stored: await this.read(accountId) };
    return { revision: Number(rows[0].revision), updatedAt: rows[0].updated_at.toISOString() };
  }

  /** Clear the snapshot but retain a revision tombstone so stale writes cannot match a later snapshot. */
  async erase(accountId, baseRevision) {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error("baseRevision must be a non-negative safe integer.");
    await this.ready();
    const { rows } = await this.#pool.query(
      `update workspaces set payload = 'null'::jsonb, revision = revision + 1, updated_at = now()
       where account_id = $1 and revision = $2 and payload <> 'null'::jsonb
       returning revision, updated_at`, [accountId, baseRevision]);
    if (rows.length) return { erased: true, revision: Number(rows[0].revision), updatedAt: rows[0].updated_at.toISOString() };
    const stored = await this.read(accountId);
    if ((stored?.revision || 0) !== baseRevision) return { conflict: true, stored };
    return { erased: false, revision: baseRevision, updatedAt: stored?.updatedAt || null };
  }

}

/** The store this deployment is configured for, or null when none is. */
export function createWorkspaceStore(env = process.env) {
  const connectionString = env.DATABASE_URL || env.POSTGRES_URL || "";
  return connectionString ? new WorkspaceStore({ connectionString }) : null;
}
