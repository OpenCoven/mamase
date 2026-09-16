import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentPrompt, handoffFilename } from "../agent-handoff.js";
import { exportWorkspaceBackup } from "../backups.js";
import { createWorkspace, createRun } from "../workspace.js";

const root = fileURLToPath(new URL("../", import.meta.url));

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

test("the ordinary case emits the working four-step sequence with unquoted, ~-expanding paths", () => {
  const prompt = agentPrompt({ filename: "coven-workspace-2026-09-16.json", run, lane: "peft" });
  const opsLines = prompt.split("\n").filter((l) => l.includes("npm run ops --"));
  assert.deepEqual(opsLines, [
    "  npm run ops -- init --workspace ~/Downloads/coven-ops-run-4f2a.json",
    "  npm run ops -- inspect --workspace ~/Downloads/coven-ops-run-4f2a.json",
    "  npm run ops -- import-backup --workspace ~/Downloads/coven-ops-run-4f2a.json --file ~/Downloads/coven-workspace-2026-09-16.json --expected-revision <revision-from-inspect>",
    "  npm run ops -- receipt --workspace ~/Downloads/coven-ops-run-4f2a.json --run run-4f2a",
  ]);
});

// This is the regression test for the shipped defect: every other test in this
// file asserts the prompt's TEXT, which is exactly how a prompt whose commands
// fail against ops.mjs's real --workspace loader shipped unnoticed. This test
// extracts the "npm run ops --" lines from the generated prompt itself (never
// hardcoding the sequence) and actually executes them, in order, against a
// real exported backup in a throwaway temp directory -- no network, no writes
// inside the repo.
test("the prompt's Start here commands are real: they run end to end against an exported backup", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mamase-handoff-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  // `~` in the prompt always resolves to Downloads; stand in a fake one so the
  // extracted commands are executable without a real shell's tilde expansion.
  const downloads = join(directory, "Downloads");
  await mkdir(downloads, { recursive: true });

  const workspace = createWorkspace();
  workspace.datasets.push({
    id: "data", name: "Examples", filename: "data.jsonl", bytes: 100, records: 6,
    format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original",
    holdout: 20, sha256: "a".repeat(64), createdAt: "2026-09-14T00:00:00.000Z",
  });
  const fixtureRun = createRun({
    id: "run-4f2a", name: "Coven adapter v3", createdAt: "2026-09-14T00:00:00.000Z",
    recipe: {
      workflow: "cli", method: "lora", programId: workspace.programs[0].id, datasetId: "data",
      student: "./models/local", teacher: "", rank: 4, alpha: 8, learningRate: 0.001,
      epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 128,
      objective: "Learn examples.", outputPath: "./outputs/local",
      familiarId: "fam", instanceId: "inst",
    },
  }, workspace);
  workspace.runs.push(fixtureRun);

  const filename = handoffFilename(new Date("2026-09-16T10:00:00Z"));
  await writeFile(join(downloads, filename), exportWorkspaceBackup(workspace, new Date().toISOString()));

  const prompt = agentPrompt({ filename, run: fixtureRun, lane: "peft" });
  const opsLines = prompt.split("\n").filter((line) => line.includes("npm run ops --"));
  assert.equal(opsLines.length, 4, "the working sequence is init, inspect, import-backup, receipt");

  // Same invocation ops.mjs's own "npm run ops" script resolves to (see
  // package.json), used directly to avoid npm's startup overhead in a test
  // that runs it four times; the flags below come only from the prompt text.
  const opsPath = join(root, "ops.mjs");
  const toArgs = (line) => line.trim().replace(/^npm run ops --\s*/, "").split(/\s+/)
    .map((token) => token.startsWith("~/") ? join(directory, token.slice(2)) : token);
  const run = (args) => {
    const result = spawnSync(process.execPath, [opsPath, ...args], { encoding: "utf8", cwd: root });
    assert.equal(result.stderr, "", result.stderr);
    return { code: result.status, output: JSON.parse(result.stdout) };
  };

  const init = run(toArgs(opsLines[0]));
  assert.equal(init.code, 0, JSON.stringify(init.output));
  assert.equal(init.output.outcome, "changed");

  const inspected = run(toArgs(opsLines[1]));
  assert.equal(inspected.code, 0, JSON.stringify(inspected.output));
  const revision = inspected.output.revision.after;
  assert.match(revision, /^[a-f0-9]{64}$/, "inspect must report the real workspace revision");

  // The one value the static prompt text cannot contain: substitute it for the
  // placeholder token, exactly as the prompt tells the agent to.
  const importArgs = toArgs(opsLines[2]).map((token) => (token === "<revision-from-inspect>" ? revision : token));
  assert.notDeepEqual(importArgs, toArgs(opsLines[2]), "the placeholder token must actually be present to substitute");
  const imported = run(importArgs);
  assert.equal(imported.code, 0, JSON.stringify(imported.output));
  assert.equal(imported.output.outcome, "changed");
  assert.equal(imported.output.format, "mamase.workspace-backup.v1");

  const receipt = run(toArgs(opsLines[3]));
  assert.equal(receipt.code, 0, JSON.stringify(receipt.output));
  assert.equal(receipt.output.schema, "mamase.workflow-receipt.v1");
  assert.equal(receipt.output.run.id, "run-4f2a");
  assert.equal(receipt.output.lane, "peft");
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
