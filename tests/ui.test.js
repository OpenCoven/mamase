import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { distillationArt, field, lossChart, table } from "../ui.js";

test("dark surfaces use OpenCoven UI's canonical near-black palette", async () => {
  const stylesheet = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const dark = stylesheet.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/)[1];
  for (const [token, color] of Object.entries({
    page: "#050409", surface: "#0f0d14", subtle: "#17131e", hover: "#211a2b",
    ink: "#f7f3fa", primary: "#8e3dff", focus: "#c9a7ff",
  })) {
    assert.ok(dark.includes(`--${token}: ${color};`), token);
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
