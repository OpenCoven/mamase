import { createAuthApi } from "./auth-api.mjs";
import { API_JSON_HEADERS, apiAccessRefusal, sendApiRefusal } from "./api-access.mjs";

/**
 * What a hosted deployment can report about local training: nothing runs here.
 * Served by a function rather than a static file so the same approval gate
 * covers it; the payload itself is identical for every approved visitor.
 */
export const HOSTED_CAPABILITIES = {
  enabled: false, available: false, hosted: true, backend: null,
  message: "This hosted workspace cannot run or monitor local training. Run Mamase on your Mac and use workspace export/import to move your saved recipes.",
};

export function createHostedCapabilities({ auth = createAuthApi() } = {}) {
  return async (request, response) => {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD", ...API_JSON_HEADERS })
        .end(JSON.stringify({ error: "Training capability endpoint method not allowed." }));
      return;
    }
    const refusal = await apiAccessRefusal(auth, request);
    if (refusal) {
      if (refusal.unexpected) console.error("Unable to check workspace access against the account service.");
      sendApiRefusal(response, refusal);
      return;
    }
    response.writeHead(200, API_JSON_HEADERS).end(request.method === "HEAD" ? undefined : JSON.stringify(HOSTED_CAPABILITIES));
  };
}
