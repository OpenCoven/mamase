import { validateWorkspace, MAX_WORKSPACE_BYTES } from "./workspace.js";

export function accountWorkspace(payload) {
  const workspace = validateWorkspace(payload);
  if (new TextEncoder().encode(JSON.stringify(workspace)).length > MAX_WORKSPACE_BYTES) {
    throw new Error("Workspace exceeds 4 MB. Export a backup before archiving older data.");
  }
  return workspace;
}

/** Explicit snapshots: reading never changes browser storage, and saving never retries a conflict. */
export class WorkspaceClient {
  constructor({ fetch: request = globalThis.fetch.bind(globalThis) } = {}) { this.fetch = request; }

  async request(accountId, options = {}) {
    const response = await this.fetch("/api/workspace", {
      credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15000), ...options,
      headers: { "Content-Type": "application/json", "X-Mamase-Account": accountId },
    });
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("Account storage is unavailable. Your browser workspace has not changed. Try again.");
    }
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(typeof value?.error === "string" ? value.error : "Account storage request failed. Try again."), { status: response.status });
    if (!Number.isSafeInteger(value?.revision) || value.revision < 0 ||
        (value.revision > 0 && !Number.isFinite(Date.parse(value.updatedAt)))) {
      throw new Error("Invalid account workspace response. Your browser workspace has not changed.");
    }
    return value;
  }

  async read(accountId) {
    const value = await this.request(accountId);
    if (value.payload !== null) value.payload = accountWorkspace(value.payload);
    return value;
  }

  async save(accountId, payload, baseRevision) {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error("Reload the account snapshot before saving.");
    return this.request(accountId, { method: "PUT", body: JSON.stringify({ payload: accountWorkspace(payload), baseRevision }) });
  }
}
