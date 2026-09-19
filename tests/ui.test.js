import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { distillationArt, field, lossChart, table } from "../ui.js";

const luminance = (hex) => {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  const rgb = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
};
const contrast = (a, b) => {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
};

test("Cave-inspired themes keep neutral surfaces and accessible lavender accents", async () => {
  const stylesheet = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  for (const [mode, pattern] of [["light", /:root\s*\{([^}]+)\}/], ["dark", /:root\[data-theme="dark"\]\s*\{([^}]+)\}/]]) {
    const block = stylesheet.match(pattern)[1];
    const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]));
    assert.equal(tokens.page, mode === "dark" ? "#121214" : "#e9e9ee");
    assert.equal(tokens.surface, mode === "dark" ? "#1c1c1f" : "#f3f3f6");
    assert.match(tokens["glass-sheen"], /^linear-gradient/);
    assert.match(tokens["primary-shadow"], /inset/);
    for (const surface of ["page", "surface", "subtle"]) {
      assert.ok(contrast(tokens.ink, tokens[surface]) >= 7, `${mode}: main text on ${surface}`);
    }
    for (const surface of ["page", "surface", "subtle", "selected", "active-surface"]) {
      assert.ok(contrast(tokens.muted, tokens[surface]) >= 4.5, `${mode}: secondary text on ${surface}`);
    }
    assert.ok(contrast(tokens.primary, tokens["on-primary"]) >= 4.5, `${mode}: primary button text`);
    assert.ok(contrast(tokens.focus, tokens.page) >= 3, `${mode}: focus indicator`);
    assert.ok(contrast(tokens["field-border"], tokens["control-surface"]) >= 3, `${mode}: form boundaries`);
    for (const kind of ["success", "warning", "danger", "running", "neutral"]) {
      assert.ok(contrast(tokens[`${kind}-ink`], tokens[`${kind}-surface`]) >= 4.5, `${mode}: ${kind} label`);
    }
  }
});

test("glass hero remains accessible and self-contained", () => {
  const art = distillationArt();
  assert.match(art, /role="img" aria-labelledby="distillation-art-title distillation-art-description"/);
  assert.match(art, /<title id="distillation-art-title">Knowledge, distilled for the coven<\/title>/);
  assert.match(art, /<desc id="distillation-art-description">/);
  assert.match(art, /id="coven-glass-fill"/);
  assert.match(art, /id="coven-liquid-fill"/);
  assert.doesNotMatch(art, /<script|<image|https?:|<animate/);
});

test("form hints and table actions have explicit accessible associations", () => {
  const markup = field("Model", "model", "<local>", { hint: "Use a local model." });
  assert.match(markup, /aria-describedby="hint-model"/);
  assert.match(markup, /id="hint-model">Use a local model/);
  assert.match(markup, /value="&lt;local&gt;"/);
  assert.match(table(["Name", ""], [["Model", "Action"]], "Models"), /<span class="sr-only">Actions<\/span>/);
});

// Live regions are the only way a screen reader learns that something changed without focus moving:
// streamed training progress, filtered totals, plan readiness, comparison results. Dropping
// role/aria-live from one of these leaves the UI looking identical and silently stops announcing,
// which no visual test notices. Only regions that change in place belong here: a region rendered
// together with its text is new to assistive technology, not changed, and is never spoken -- which
// is why the two preview summaries are dialog descriptions below, not live regions.
const liveRegions = [
  ["live-progress-announcement", "role=\"status\"", "training progress and status, at each tenth of the way and on every status change"],
  ["run-count", "role=\"status\"", "filtered run totals"],
  ["recipe-readiness", "role=\"status\"", "plan readiness"],
  ["account-panel", "aria-live=\"polite\"", "account/auth phase"],
  ["comparison-result", "aria-live=\"polite\"", "evaluation comparison"],
];

test("status regions keep the live-region announcement they depend on", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  for (const [id, attribute, why] of liveRegions) {
    // Every render path, not just the first: a second branch that rendered the same id without the
    // attribute would leave one of the two announcing and the other silent, which is the harder bug.
    const elements = [...app.matchAll(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*`, "g"))].map(([match]) => match);
    assert.ok(elements.length, `app.js no longer renders #${id} (${why})`);
    for (const element of elements) {
      assert.ok(element.includes(attribute), `#${id} (${why}) must keep ${attribute} or it stops announcing: ${element}`);
    }
  }
  // The progress bar is not a live region; it carries its own accessible name instead.
  assert.match(app, /<progress id="live-progress-bar" aria-label="[^"]+"/);
});

test("the step-by-step progress text is shown but not announced, and the announcement outlives the progress block", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  // #live-progress-text changes on every reported step. As a live region that queued one
  // announcement per flush -- up to five a second -- so a screen reader fell behind the run reading
  // a backlog. It must stay visible and stay silent; #live-progress-announcement carries the
  // announcement instead, and only when the tenth or the status changes.
  const visible = /<span id="live-progress-text"[^>]*>/.exec(app);
  assert.ok(visible, "app.js no longer renders the visible progress text");
  assert.doesNotMatch(visible[0], /role="status"|aria-live/,
    "the per-step text must not be a live region, or every step is announced again");
  // The region is rendered once with the run page, empty, outside the training panel. Inside the
  // panel it was rebuilt with its text on every state change, which assistive technology treats as
  // a new region rather than a changed one; and it vanished with the progress block, so the run
  // stopping -- the one status change that matters most -- was never announced.
  const detailStart = app.indexOf("function runDetail(");
  const detail = app.slice(detailStart, app.indexOf("\nfunction ", detailStart + 1));
  assert.match(detail, /<p id="live-progress-announcement" class="sr-only" role="status"><\/p>/,
    "the announcement region must be part of the run page, rendered empty");
  const block = /<div class="live-progress">.*?Percentage of learning updates, not time remaining\.<\/p><\/div>/s.exec(app);
  assert.ok(block, "app.js no longer renders the progress block");
  assert.doesNotMatch(block[0], /live-progress-announcement/, "the announcement region must not be rebuilt with the progress block");
  assert.match(app, /const announcement = document\.querySelector\("#live-progress-announcement"\)/);
  // The exact count must still be reachable on demand, which is what aria-valuetext is for.
  assert.match(app, /progress\.setAttribute\("aria-valuetext", value\)/);
  // The announcement is written only when the milestone changes, never on every update. How often
  // that is -- eleven times over a five-hundred-step run -- is pinned behaviourally against
  // trainingProgress() in tests/training-state.test.js, which is the stronger statement. What was
  // already true when the page opened is recorded as the baseline, not announced.
  assert.match(app, /if \(!announcement\.dataset\.milestone\) announcement\.dataset\.milestone = shown\.milestone;/);
  assert.match(app, /announcement\.dataset\.milestone !== shown\.milestone/);
  assert.match(app, /const text = shown\.announcement/);
  // tests/training-announcements.test.js exercises deferral behind dialogs and mobile navigation,
  // including a newer terminal update delivered before the queued dialog close event.
});

test("toasts are two always-present regions at a fixed politeness, so errors interrupt and the rest are heard", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const markup = await readFile(new URL("../index.html", import.meta.url), "utf8");
  // One region that was unhidden with its message, and switched between polite and assertive as it
  // was filled, looked right in the accessibility tree and was never spoken: a live region announces
  // a change to content it already exposes, and at the politeness it had when it was registered.
  assert.match(markup, /<div id="toast-status" role="status" aria-live="polite"><\/div>/);
  assert.match(markup, /<div id="toast-alert" class="error" role="alert" aria-live="assertive"><\/div>/);
  assert.doesNotMatch(/id="toast[^"]*"[^>]*hidden/.exec(markup)?.[0] || "", /hidden/, "a hidden region is not in the tree to announce from");
  assert.doesNotMatch(app, /toast\w*\.setAttribute\("(?:role|aria-live)"/, "politeness must not be switched per message");
  assert.doesNotMatch(app, /toast\w*\.hidden/, "the regions must never leave the accessibility tree");
  assert.match(app, /const region = error \? toastAlert : toastStatus;/);
  // A repeat of the same message is not a change; it is cleared and re-set so it is heard again.
  assert.match(app, /if \(region\.textContent === message\) \{/);
});

test("preview dialogs describe themselves by their summary, which is read on entering them", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  // The summaries are rendered with the dialog, so as live regions they would never be spoken; the
  // dialog's accessible description is what a screen reader reads after its name, before the
  // buttons. Both must be plain paragraphs the dialog points at, and nothing else may keep a
  // stale description from an earlier dialog.
  assert.match(app, /dialog\.removeAttribute\("aria-describedby"\);/);
  for (const id of ["report-summary", "restore-summary"]) {
    const element = new RegExp(`<p id="${id}"[^>]*>`).exec(app);
    assert.ok(element, `app.js no longer renders #${id}`);
    assert.doesNotMatch(element[0], /role=|aria-live/, `#${id} is described, not announced; a live role here promises what cannot happen`);
    assert.match(app, new RegExp(`dialog\\.setAttribute\\("aria-describedby", "dialog-${id}"\\)`));
  }
});

test("loss visualization includes validation-only records and real zeroes", () => {
  const chart = lossChart({ totalSteps: 10, history: [
    { step: 1, loss: null, evalLoss: 1.2, recordedAt: "2026-09-13T00:00:00Z" },
    { step: 2, loss: 0, evalLoss: null, recordedAt: "2026-09-13T01:00:00Z" },
  ] });
  assert.match(chart, /Validation, step 1: 1.2/);
  assert.match(chart, /Training, step 2: 0/);
  assert.match(chart, /View loss observations/);
  assert.match(chart, /Not recorded/);
  assert.doesNotMatch(chart, /Waiting for recorded loss|NaN/);
});
