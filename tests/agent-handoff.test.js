import test from "node:test";
import assert from "node:assert/strict";
import { agentPrompt, handoffFilename } from "../agent-handoff.js";

const run = { id: "run-4f2a", name: "Coven adapter v3" };

test("the prompt names the exported file, the run and the lane", () => {
  const prompt = agentPrompt({ filename: "coven-workspace-2026-09-16.json", run, lane: "peft" });
  assert.match(prompt, /skills\/mamase\/SKILL\.md/);
  assert.match(prompt, /coven-workspace-2026-09-16\.json/);
  assert.match(prompt, /run-4f2a/);
  assert.match(prompt, /Coven adapter v3/);
  assert.match(prompt, /Lane\s*:\s*peft/);
  assert.match(prompt, /npm run ops -- inspect --workspace/);
  assert.match(prompt, /npm run ops -- receipt --workspace .* --run run-4f2a/);
  assert.match(prompt, /nextAction/);
  assert.match(prompt, /explicit go-ahead/i);
});

test("the prompt never carries secrets, workspace contents or invented paths", () => {
  const prompt = agentPrompt({
    filename: "coven-workspace-2026-09-16.json",
    run: { id: "run-1", name: "Adapter" }, lane: "peft",
    // A caller must not be able to leak these into the clipboard.
    capability: { token: "local-training-command-token", enabled: true },
    workspace: { name: "The Coven", datasets: [{ filename: "private-examples.jsonl" }] },
  });
  assert.ok(!prompt.includes("local-training-command-token"));
  assert.ok(!prompt.includes("private-examples.jsonl"));
  assert.ok(!/\/Users\//.test(prompt), "No absolute local path may be asserted");
  assert.match(prompt, /wherever your browser saved it/i);
});

test("run names cannot break the prompt's shape", () => {
  const prompt = agentPrompt({
    filename: "w.json", lane: "peft",
    run: { id: "run-1", name: "Bad\nname\r\nwith\x07control chars" },
  });
  const runLines = prompt.split("\n").filter((line) => line.startsWith("Run"));
  assert.equal(runLines.length, 1, "A run name must not inject extra lines");
  assert.match(runLines[0], /Bad name with control chars/);
  assert.ok(!/[\x00-\x1F\x7F]/.test(prompt.replace(/\n/g, "")), "No control characters survive");
});

test("an unselected lane asks for the lane instead of a next action", () => {
  const prompt = agentPrompt({ filename: "w.json", run, lane: "unselected" });
  assert.match(prompt, /lane is not selected/i);
  assert.ok(!prompt.includes("train.py"), "Nothing may suggest training before a lane exists");
});

test("the filename carries the date and stays a safe single segment", () => {
  assert.equal(handoffFilename(new Date("2026-09-16T10:20:30Z")), "coven-workspace-2026-09-16.json");
  assert.ok(!handoffFilename(new Date()).includes("/"));
});
