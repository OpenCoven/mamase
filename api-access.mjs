export const API_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/**
 * Decide whether one workspace API request may proceed. Returns null when it
 * may, or the refusal to send. The local server and the hosted functions share
 * this single decision so neither can drift from the other.
 *
 * An auth handler without `authorize` (test and offline fixtures) states no
 * account policy, so nothing is gated.
 */
export async function apiAccessRefusal(auth, request) {
  if (typeof auth?.authorize !== "function") return null;
  let verdict;
  try {
    verdict = await auth.authorize(request);
  } catch (error) {
    if (Number.isInteger(error?.status)) return { status: error.status, error: error.message };
    return { status: 502, error: "Account service unavailable. Try again.", unexpected: true };
  }
  if (!verdict.gated || verdict.approved) return null;
  return { status: verdict.authenticated ? 403 : 401, error: verdict.refusal };
}

export function sendApiRefusal(response, refusal) {
  response.writeHead(refusal.status, API_JSON_HEADERS).end(JSON.stringify({ error: refusal.error }));
}
