import { API_JSON_HEADERS } from "./api-access.mjs";
import { MAX_BACKUP_BYTES } from "./backups.js";
import { accountWorkspace } from "./workspace-client.js";

/**
 * Per-account workspace endpoints.
 *
 * Authorize each request once, including the account approval check. The client
 * sends the account it prepared the operation for so a changed session cannot
 * redirect a pending write. Storage always uses the verified session's account.
 */

const json = (response, status, body) => response.writeHead(status, API_JSON_HEADERS).end(JSON.stringify(body));

async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  const append = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw Object.assign(new Error(`Workspace exceeds the ${Math.floor(limit / 1024 / 1024)} MB limit.`), { status: 413 });
    chunks.push(bytes);
  };
  try {
    // Hosted runtimes may consume the stream and expose a lazily parsed body.
    const body = request.body;
    if (body !== undefined) {
      append(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    } else {
      for await (const chunk of request) append(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.statusCode !== 400) throw error;
    throw Object.assign(new Error("Request body is not valid JSON. No changes were made."), { status: 400 });
  }
}

export function createWorkspaceApi({ store, auth }) {
  return async function handle(request, response, pathname) {
    if (pathname !== "/api/workspace") return false;
    if (!["GET", "PUT", "DELETE"].includes(request.method)) {
      json(response, 405, { error: "Workspace API method not allowed." });
      return true;
    }
    let verdict;
    try {
      verdict = await auth.authorize(request, response);
    } catch {
      json(response, 502, { error: "Account service unavailable. Try again." });
      return true;
    }
    const account = verdict.user;
    if (!verdict.authenticated || !account?.id) {
      json(response, 401, { error: "Sign in with an approved account to use workspace storage." });
      return true;
    }
    if (!verdict.approved) {
      json(response, 403, { error: "This account is not approved for workspace storage." });
      return true;
    }
    const expectedAccount = request.headers["x-mamase-account"];
    if (request.method !== "GET" && (!expectedAccount ||
        request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")) {
      json(response, 403, { error: "Use the workspace controls to save account data." });
      return true;
    }
    if (expectedAccount && expectedAccount !== account.id) {
      json(response, 409, { error: "Your account changed. Reload the account connection before continuing." });
      return true;
    }
    if (!store) {
      json(response, 503, { error: "This deployment has no account storage configured. Your workspace stays in this browser." });
      return true;
    }
    try {
      if (request.method === "GET") {
        const stored = await store.read(account.id);
        json(response, 200, stored ? { revision: stored.revision, payload: stored.payload, updatedAt: stored.updatedAt }
          : { revision: 0, payload: null, updatedAt: null });
        return true;
      }
      const body = await readJson(request, MAX_BACKUP_BYTES);
      if (!Number.isSafeInteger(body?.baseRevision) || body.baseRevision < 0) {
        json(response, 400, { error: "Send the revision this save was based on, or 0 to claim an empty account." });
        return true;
      }
      let result;
      if (request.method === "DELETE") {
        result = await store.erase(account.id, body.baseRevision);
      } else {
        if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
          json(response, 400, { error: "Send the workspace payload as an object." });
          return true;
        }
        let payload;
        try { payload = accountWorkspace(body.payload); }
        catch (error) { json(response, 400, { error: error.message }); return true; }
        result = await store.write(account.id, { email: account.email, payload, baseRevision: body.baseRevision });
      }
      if (result.conflict) {
        // 409, not a silent overwrite: another browser on this account saved first, and its
        // records are not this client's to discard.
        json(response, 409, { error: "This account's workspace changed elsewhere. Reload the latest data before saving.",
          revision: result.stored?.revision ?? 0, payload: result.stored?.payload ?? null, updatedAt: result.stored?.updatedAt ?? null });
        return true;
      }
      json(response, 200, result);
      return true;
    } catch (error) {
      if (Number.isInteger(error?.status)) { json(response, error.status, { error: error.message }); return true; }
      json(response, 502, { error: "Workspace storage is unavailable. Your workspace is still in this browser." });
      return true;
    }
  };
}
