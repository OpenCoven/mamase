import test from "node:test";
import assert from "node:assert/strict";
import { agentPrompt, handoffFilename } from "../agent-handoff.js";

const run = { id: "run-4f2a", name: "Coven adapter v3" };

// One line whose text starts with `prefix`, asserting there is exactly one.
function fieldLine(prompt, prefix) {
  const lines = prompt.split("\n").filter((line) => line.startsWith(prefix));
  assert.equal(lines.length, 1, `expected exactly one "${prefix}" line, got ${lines.length}`);
  return lines[0];
}

test("the prompt is structurally well-formed: one line per field, two well-formed commands, and the skill path", () => {
  const prompt = agentPrompt({ filename: "coven-workspace-2026-09-16.json", run, lane: "peft" });

  assert.equal((prompt.match(/skills\/mamase\/SKILL\.md/g) || []).length, 1);

  const workspaceLine = fieldLine(prompt, "Workspace");
  const runLine = fieldLine(prompt, "Run");
  const laneLine = fieldLine(prompt, "Lane");
  assert.match(workspaceLine, /coven-workspace-2026-09-16\.json/);
  assert.match(runLine, /run-4f2a/);
  assert.match(runLine, /Coven adapter v3/);
  assert.match(laneLine, /Lane\s*:\s*peft\s*$/);

  const inspectLine = prompt.split("\n").find((l) => l.includes("inspect --workspace"));
  const receiptLine = prompt.split("\n").find((l) => l.includes("receipt --workspace"));
  assert.match(inspectLine, /^ {2}npm run ops -- inspect --workspace ~\/Downloads\/[A-Za-z0-9._-]+$/);
  assert.match(receiptLine, /^ {2}npm run ops -- receipt --workspace ~\/Downloads\/[A-Za-z0-9._-]+ --run run-4f2a$/);
});

test("the prompt never carries secrets, workspace contents, or any other caller-supplied field", () => {
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

test("a run name cannot inject lines, forge the Lane line, or reverse the prompt with a bidi override", () => {
  const clean = agentPrompt({ filename: "w.json", lane: "peft", run: { id: "run-1", name: "Clean name" } });
  const hostile = agentPrompt({
    filename: "w.json", lane: "peft",
    run: { id: "run-1", name: "Bad\nname\r\nwith\x07control\u202Echars" },
  });
  assert.equal(hostile.split("\n").length, clean.split("\n").length, "A run name must not change the line count");
  fieldLine(hostile, "Run"); // exactly one Run line, or this throws
  assert.equal(fieldLine(hostile, "Lane"), fieldLine(clean, "Lane"), "A run name must not forge the Lane line");
  assert.ok(!hostile.includes("\u202E"), "A bidi override must not survive into the prompt");
});

test("the run name is quoted in the Run line", () => {
  const prompt = agentPrompt({ filename: "w.json", lane: "peft", run: { id: "run-1", name: "Adapter v3" } });
  assert.match(fieldLine(prompt, "Run"), /^Run\s+:\s+run-1\s+"Adapter v3"$/);
});

test("an unselected, unknown, empty, or missing lane always takes the cautious branch", () => {
  for (const lane of [undefined, null, "", "unselected", "Unselected", "banana", "unselected\n", " unselected "]) {
    const prompt = agentPrompt({ filename: "w.json", run, lane });
    assert.ok(!prompt.includes("train.py"), `lane ${JSON.stringify(lane)} must not fail open into the training branch`);
  }
});

test("only the two action lanes reach the train.py caution", () => {
  for (const lane of ["peft", "managed-mlx"]) {
    const prompt = agentPrompt({ filename: "w.json", run, lane });
    assert.ok(prompt.includes("train.py"), `lane ${JSON.stringify(lane)} should surface the training caution`);
  }
});

test("a missing filename or run id falls back to an obvious placeholder, never a blank command argument", () => {
  for (const filename of ["", undefined]) {
    const prompt = agentPrompt({ filename, run, lane: "peft" });
    assert.match(prompt, /coven-workspace\.json/);
  }
  for (const badRun of [{}, undefined]) {
    const prompt = agentPrompt({ filename: "w.json", run: badRun, lane: "peft" });
    const receiptLine = prompt.split("\n").find((l) => l.includes("receipt --workspace"));
    assert.match(receiptLine, /--run \S+$/, "the --run flag must always carry a non-blank token");
    assert.ok(!receiptLine.endsWith("--run"), "the --run flag must never be emitted empty");
  }
});

test("the ordinary case emits an unquoted workspace path so ~ expands, and legitimate values pass through unchanged", () => {
  const prompt = agentPrompt({ filename: "coven-workspace-2026-09-16.json", run, lane: "peft" });
  const inspectLine = prompt.split("\n").find((l) => l.includes("inspect --workspace"));
  const receiptLine = prompt.split("\n").find((l) => l.includes("receipt --workspace"));
  assert.equal(inspectLine, "  npm run ops -- inspect --workspace ~/Downloads/coven-workspace-2026-09-16.json");
  assert.equal(receiptLine, "  npm run ops -- receipt --workspace ~/Downloads/coven-workspace-2026-09-16.json --run run-4f2a");
});

test("a filename that could become more than one shell argument is rejected and falls back", () => {
  const hostileFilenames = [
    "my file.json",
    'x".json',
    "$(whoami).json",
    "`whoami`.json",
    "../../.ssh/id_rsa",
  ];
  for (const filename of hostileFilenames) {
    const prompt = agentPrompt({ filename, run, lane: "peft" });
    assert.ok(!prompt.includes(filename), `hostile filename ${JSON.stringify(filename)} must not reach the output`);
    assert.match(prompt, /coven-workspace\.json/, `hostile filename ${JSON.stringify(filename)} must fall back`);
  }
});

test("a run id that could become more than one shell argument is rejected and falls back", () => {
  const hostileIds = ["run 1", "$(whoami)", 'run"1', "run;rm -rf ~"];
  for (const id of hostileIds) {
    const prompt = agentPrompt({ filename: "w.json", run: { id, name: "X" }, lane: "peft" });
    assert.ok(!prompt.includes(id), `hostile run id ${JSON.stringify(id)} must not reach the output`);
    assert.match(prompt, /MISSING-RUN-ID/, `hostile run id ${JSON.stringify(id)} must fall back`);
  }
});

test("a long run name is clamped and slicing never leaves a trailing space inside the quotes", () => {
  // The 120th character is a space, so a naive trim-before-slice would cut
  // right after it and leave a dangling space before the closing quote.
  const name = `${"x".repeat(119)} ${"y".repeat(50)}`;
  const prompt = agentPrompt({ filename: "w.json", run: { id: "run-1", name }, lane: "peft" });
  const runLine = fieldLine(prompt, "Run");
  assert.match(runLine, /^Run\s+:\s+run-1\s+"[^"\s][^"]*[^"\s]"$/);
  const captured = runLine.match(/"([^"]*)"$/)[1];
  assert.equal(captured.length, 119, "the clamp must trim after slicing, not before");
});

test("handoffFilename produces a dated, single-segment name", () => {
  assert.equal(handoffFilename(new Date("2026-09-16T10:20:30Z")), "coven-workspace-2026-09-16.json");
});
