const ADDRESS = /^[^\s@,;]{1,128}@[^\s@,;]{1,190}$/;
const DOMAIN = /^@[^\s@,;]{1,190}$/;

export const NO_APPROVED_ACCOUNTS = "This deployment has no approved accounts yet. Ask the deployment owner to add your address to MAMASE_ACCESS_LIST.";
export const NOT_APPROVED = "Your account is not on the approved list for this deployment. Ask the deployment owner to add it, then sign in again.";
export const SIGN_IN_REQUIRED = "Sign in with an approved account to use this workspace.";

/**
 * Parse MAMASE_ACCESS_LIST into the set of approved addresses and domains.
 * Entries are separated by commas, whitespace or newlines, and are either a
 * full address (`member@coven.example`) or a whole domain (`@coven.example`).
 * Malformed entries throw: a typo must be a loud configuration failure, never
 * a silently smaller allowlist. Entry values are never echoed in the error.
 */
export function parseAccessList(value) {
  if (value !== undefined && typeof value !== "string") throw new Error("MAMASE_ACCESS_LIST must be a string of approved addresses.");
  const addresses = new Set();
  const domains = new Set();
  const entries = (value || "").split(/[\s,;]+/).filter(Boolean);
  entries.forEach((entry, index) => {
    const normalized = entry.toLowerCase();
    if (DOMAIN.test(normalized)) domains.add(normalized.slice(1));
    else if (ADDRESS.test(normalized)) addresses.add(normalized);
    else throw new Error(`MAMASE_ACCESS_LIST entry ${index + 1} is not an email address or an @domain entry.`);
  });
  return { addresses, domains, configured: addresses.size > 0 || domains.size > 0 };
}

/** True only for an address this list names directly or through its domain. */
export function isApproved(list, email) {
  if (!list || typeof email !== "string") return false;
  const normalized = email.trim().toLowerCase();
  if (!ADDRESS.test(normalized)) return false;
  return list.addresses.has(normalized) || list.domains.has(normalized.slice(normalized.indexOf("@") + 1));
}

/** The reason an account cannot pass the gate, or "" when it is approved. */
export function accessRefusal(list, { authenticated, email }) {
  if (!list.configured) return NO_APPROVED_ACCOUNTS;
  if (!authenticated) return SIGN_IN_REQUIRED;
  return isApproved(list, email) ? "" : NOT_APPROVED;
}
