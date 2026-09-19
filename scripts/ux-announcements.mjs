// Whether a screen reader speaks a change nobody focused is decided by a rule the accessibility
// tree does not show. A live region is read when its content *changes* after the region is already
// exposed to assistive technology. A region inserted together with its text, or unhidden in the
// same tick its text is set, is indistinguishable in the tree and in every aria snapshot from one
// that was announced -- and says nothing. MDN, "ARIA live regions": the region "must first be
// present (and usually empty), so the browser and assistive technologies are aware of it". The one
// exception is role="alert", which browsers announce on appearance because it is defined to
// interrupt.
//
// The four accessibility passes before this one asserted what the tree contained at each moment.
// This recorder applies the rule above to every live-region change in the page and logs whether
// it would have been spoken, with the reason when it would not. scripts/verify-ux.mjs and
// scripts/verify-training.mjs assert on that log at the moments the review protocol asks about;
// tests/ux-announcements.test.js proves the rule against pages built to contain each shape.
//
// It is a model of what assistive technology does, not a screen reader. It can say an outcome was
// handed to one; it cannot say how it sounds, and it does not close the human pass in #44.

function recorder() {
  const selector = '[role="status"], [role="alert"], [role="log"], [aria-live]';
  const registry = new Map();
  const log = [];
  window.mamaseAnnouncements = log;
  const text = (element) => (element.textContent || "").replace(/\s+/g, " ").trim();
  const politenessOf = (element) => {
    const live = (element.getAttribute("aria-live") || "").trim().toLowerCase();
    if (live) return live;
    const role = (element.getAttribute("role") || "").trim().toLowerCase();
    return role === "alert" ? "assertive" : role === "status" || role === "log" ? "polite" : "off";
  };
  // display:none (which the hidden attribute and a closed <dialog> both are), visibility:hidden and
  // an aria-hidden ancestor remove a region from the tree; a clipped .sr-only region stays in it.
  const exposed = (element) => element.isConnected && element.checkVisibility() && !element.closest('[aria-hidden="true"]');
  // Inert content is in the tree but nothing it does reaches assistive technology: a change made
  // behind an open modal dialog is dropped, not held until the dialog closes.
  const inert = (element) => {
    if (element.closest("[inert]")) return true;
    const modal = document.querySelector("dialog:modal");
    return Boolean(modal) && !modal.contains(element);
  };
  const describe = (element) => {
    const classes = typeof element.className === "string" && element.className.trim();
    return `<${element.tagName.toLowerCase()}${element.id ? ` id="${element.id}"` : ""}${classes ? ` class="${classes}"` : ""}>`;
  };
  const snapshot = (element) => ({ text: text(element), exposed: exposed(element), politeness: politenessOf(element) });
  // Runs once per mutation batch, i.e. after the synchronous script that made the changes has
  // finished -- which is also the earliest point assistive technology sees any of them.
  const observe = () => {
    const seen = new Set();
    for (const element of document.querySelectorAll(selector)) {
      seen.add(element);
      const before = registry.get(element);
      const now = snapshot(element);
      registry.set(element, now);
      if (!now.text || !now.exposed || inert(element) || (before && before.text === now.text)) continue;
      const alert = (element.getAttribute("role") || "").trim().toLowerCase() === "alert";
      const reason = !before ? "inserted with its content" : !before.exposed ? "shown with its content" : "changed";
      // Politeness is what the region had when assistive technology registered it, not what it was
      // switched to alongside the content: a region made assertive in the same tick it is filled
      // is queued at the politeness it already had.
      const spoken = reason === "changed" ? before.politeness !== "off" : alert;
      log.push({
        element: describe(element), id: element.id, text: now.text, reason, spoken,
        politeness: spoken ? (reason === "changed" ? before.politeness : "assertive") : now.politeness,
        at: Math.round(performance.now()),
      });
    }
    for (const element of registry.keys()) if (!seen.has(element)) registry.delete(element);
  };
  new MutationObserver(observe).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
}

export const installAnnouncementRecorder = (target) => target.addInitScript(recorder);

// Everything logged since the last drain, spoken or not, in the order it happened.
export const drainAnnouncements = (page) => page.evaluate(() => window.mamaseAnnouncements.splice(0));

export const spokenAnnouncements = async (page) => (await drainAnnouncements(page)).filter((entry) => entry.spoken);

// Resolves with the first entry matching `pattern` that would be spoken, failing with what was
// logged instead, so a silent outcome is reported as the finding it is.
export async function waitForAnnouncement(page, pattern, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  const history = [];
  while (Date.now() < deadline) {
    const entries = await drainAnnouncements(page);
    history.push(...entries);
    const hit = entries.find((entry) => entry.spoken && pattern.test(entry.text));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Nothing matching ${pattern} would have been spoken. Live-region changes seen:\n${
    history.map((entry) => `  ${entry.spoken ? "spoken" : "silent"} ${entry.politeness} ${entry.element} ${entry.reason}: ${JSON.stringify(entry.text)}`).join("\n") || "  (none)"}`);
}
