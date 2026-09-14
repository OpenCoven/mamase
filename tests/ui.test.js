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
