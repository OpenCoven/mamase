import { icon, button } from "./ui.js";
import { escapeHtml as esc } from "./workspace.js";

/**
 * What the browser may show for the current account state.
 * "open" is the workspace; every other value is the approval gate and nothing
 * behind it renders. Deployments without sign-in configured have no approved
 * list to check, so their local-only workspace stays open as before.
 */
export function accessPhase(state) {
  if (!state || state.phase === "loading") return "checking";
  if (state.phase === "unconfigured") return "open";
  if (state.phase === "signed-in") return state.approved === true ? "open" : "pending";
  if (state.phase === "signed-out") return "sign-in";
  return "error";
}

const FALLBACK = {
  pending: "Your account is not on the approved list for this deployment yet.",
  "sign-in": "Sign in with an approved account to use this workspace.",
  error: "The account service could not be reached. Try again.",
};

function body(phase, state, busy) {
  const message = esc(state?.message || FALLBACK[phase] || "");
  if (phase === "checking") {
    return `<h1>Checking your access</h1><p role="status">Confirming your account against the approved list.</p>`;
  }
  if (phase === "sign-in") {
    return `<h1>This lab is invitation only</h1><p>${message}</p>
      <div class="actions">${button("Sign in", "sign-in", "arrow", "primary")}</div>
      <p class="help">Sign-in alone does not grant access. The deployment owner must also add your address to the approved list.</p>`;
  }
  if (phase === "pending") {
    return `<h1>Waiting for approval</h1>
      ${state?.user ? `<div class="account-identity"><span class="avatar">${esc((state.user.email || "?").slice(0, 1).toUpperCase())}</span><div><strong>${esc([state.user.firstName, state.user.lastName].filter(Boolean).join(" ") || state.user.email)}</strong><p>${esc(state.user.email)}</p></div></div>` : ""}
      <p role="status">${message}</p>
      <div class="actions">${button("Check again", "auth-refresh", "arrow", "primary")}${button(busy ? "Signing out..." : "Sign out", "sign-out", "", "quiet", busy ? "disabled" : "")}</div>
      <p class="help">Nothing in this workspace opens until an owner approves this address. Records already saved in this browser are untouched.</p>`;
  }
  return `<h1>Access could not be confirmed</h1><p class="error-text" role="status">${message}</p>
    <div class="actions">${button("Try again", "auth-refresh", "arrow", "primary")}</div>
    <p class="help">The workspace stays closed until the account service confirms an approved account.</p>`;
}

/** The whole page for a gated visitor: no navigation, no workspace, no data. */
export function accessGateView(phase, state, { busy = false } = {}) {
  return `<div class="gate-shell">
    <main class="gate" id="main" tabindex="-1" data-access="${esc(phase)}">
      <section class="card gate-card">
        <span class="gate-mark">${icon("spark")}</span>
        <span class="eyebrow">mamasé · Coven Distillation Lab</span>
        ${body(phase, state, busy)}
      </section>
    </main></div>`;
}

export const GATE_TITLES = {
  checking: "Checking access",
  "sign-in": "Sign in required",
  pending: "Waiting for approval",
  error: "Access unavailable",
};
