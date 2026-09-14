import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runOperation } from "../ops.mjs";
import { LANES, STEP_STATES } from "../workflow-receipt.mjs";
import { validateWorkspace } from "../workspace.js";
import { prepareReview, recordHumanDecision } from "../human-review.js";
import { sha256 } from "../familiar-context.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const skillDir = join(root, "skills", "mamase");
const hash = (letter) => letter.repeat(64);
const at = (minutes) => new Date(Date.parse("2026-09-14T12:00:00.000Z") + minutes * 60_000).toISOString();

async function skillDocuments() {
  const files = [join(skillDir, "SKILL.md"), ...(await readdir(join(skillDir, "references"))).map((name) => join(skillDir, "references", name))];
  return Promise.all(files.map(async (path) => ({ path, text: await readFile(path, "utf8") })));
}

// Backticked kebab-case tokens that are evaluation categories, context scopes, review decisions or prose, not codes/states/commands.
const proseTokens = new Set(["tool-boundary", "identity-files-only", "selected-sources", "needs-more-evidence", "not-started", "not-authorized", "identity-bound", "read-only", "append-only", "training-result"]);

async function knownVocabulary() {
  const catalog = await runOperation("catalog");
  const [ops, receipt, lab] = await Promise.all(["ops.mjs", "workflow-receipt.mjs", "lab.mjs"].map((name) => readFile(join(root, name), "utf8")));
  const pythonFlags = {};
  for (const script of ["preflight", "train", "evaluate"]) pythonFlags[`training/${script}.py`] = new Set([...(await readFile(join(root, "training", `${script}.py`), "utf8")).matchAll(/add_argument\("(--[a-z-]+)"/g)].map((match) => match[1]));
  const source = `${ops}\n${receipt}`;
  const codes = new Set([...source.matchAll(/(?:blocked|blocker|OperationError)\("([a-z-]+)"/g)].map((match) => match[1]));
  const states = new Set([...STEP_STATES, ...receipt.matchAll(/return "([a-z-]+)"/g)].map((item) => Array.isArray(item) ? item[1] : item));
  const steps = new Set([...receipt.matchAll(/step\("([a-z-]+)"/g)].map((match) => match[1]));
  const runtimeStates = new Set([...receipt.matchAll(/state: "([a-z]+)"/g)].map((match) => match[1]));
  const labCommands = new Set([...lab.matchAll(/\["prepare", "inspect-context"\]/g)].length ? ["prepare", "inspect-context"] : []);
  const labFlags = new Set([...lab.matchAll(/(--[a-z-]+)/g)].map((match) => match[1]));
  const schemas = new Set([catalog.schema, catalog.workspaceFileSchema, catalog.backupSchema, catalog.recipeSchema, catalog.workflowReceiptSchema, "mamase.operation-receipt.v1", "mamase.training-result.v1", "mamase.evaluation-report.v1", "mamase.local-bundle.v1", "mamase.run-report.v1"]);
  const jobStatuses = new Set(["starting", "running", "cancelling", "completed", "failed", "cancelled"]);
  return { catalog, operations: new Set(catalog.operations.map((operation) => operation.name)), codes, states, steps, runtimeStates, labCommands, labFlags, pythonFlags, schemas, jobStatuses };
}

test("the skill only names operations, codes, states, commands and references that exist", async () => {
  const documents = await skillDocuments();
  const skill = documents[0].text;
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, "SKILL.md starts with YAML frontmatter");
  assert.match(frontmatter[1], /^name: mamase$/m);
  assert.match(frontmatter[1], /^description: .*Mamase.*Do not use for unrelated/m);
  const known = await knownVocabulary();
  const kebab = new Set([...known.operations, ...known.codes, ...known.states, ...known.steps, ...known.runtimeStates, ...known.jobStatuses, ...known.labCommands, ...LANES]);
  assert.ok(kebab.has("evidence-ready") && kebab.has("stale-revision") && kebab.has("source-changed"), "vocabulary extraction found states and codes");

  for (const { path, text } of documents) {
    for (const match of text.matchAll(/npm run ops -- ([a-z-]+)/g)) assert.ok(known.operations.has(match[1]), `${path} names unknown operation ${match[1]}`);
    for (const match of text.matchAll(/npm run lab -- ([a-z-]+)((?: --[a-z-]+(?: \S+)?)*)/g)) {
      assert.ok(known.labCommands.has(match[1]), `${path} names unknown lab command ${match[1]}`);
      for (const flag of match[2].matchAll(/--[a-z-]+/g)) assert.ok(known.labFlags.has(flag[0]), `${path} names unknown lab flag ${flag[0]}`);
    }
    for (const match of text.matchAll(/(training\/(?:preflight|train|evaluate)\.py)((?: --[a-z-]+(?: \S+)?)*)/g)) {
      for (const flag of match[2].matchAll(/--[a-z-]+/g)) assert.ok(known.pythonFlags[match[1]].has(flag[0]), `${path} passes unknown flag ${flag[0]} to ${match[1]}`);
    }
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1];
      if (proseTokens.has(token)) continue;
      if (/^mamase\.[a-z-]+\.v\d+$/.test(token)) { assert.ok(known.schemas.has(token), `${path} names unknown schema ${token}`); continue; }
      if (/^[a-z]+(?:-[a-z]+)+$/.test(token)) assert.ok(kebab.has(token), `${path} names unknown code, state, step or command ${token}`);
      if (/^[a-z]+: "[a-z-]+"$/.test(token)) {
        const [, key, value] = token.match(/^([a-z]+): "([a-z-]+)"$/);
        if (key === "state") assert.ok(known.states.has(value), `${path} names unknown state ${value}`);
      }
    }
    for (const match of text.matchAll(/\]\((references\/[a-z-]+\.md)\)/g)) await readFile(join(skillDir, match[1]), "utf8");
    for (const match of text.matchAll(/\n\| `([a-z]+)`(?: \/ `([a-z]+)`)? \|/g)) for (const state of [match[1], match[2]].filter(Boolean)) assert.ok(known.runtimeStates.has(state), `${path} names unknown runtime state ${state}`);
  }
  assert.ok(["peft", "managed-mlx", "unselected"].every((lane) => skill.includes(`\`${lane}\``)), "the skill routes by every lane");
  assert.match(skill, /\*\*Planning never trains\.\*\*/);
  assert.match(skill, /Only a human records a review decision/);
});

test("a synthetic plan-only to human-handoff scenario is grounded in files, not claims", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mamase-skill-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspacePath = join(directory, "workspace.json");
  const dataset = Buffer.from(Array.from({ length: 10 }, (_, index) => JSON.stringify({ prompt: `Task ${index}: record evidence`, response: `Cody records observed result ${index}.` })).join("\n") + "\n");
  await writeFile(join(directory, "examples.jsonl"), dataset);
  const datasetSha = sha256(dataset);

  // Discovery first: catalog and inspect, then plan without training.
  const catalog = await runOperation("catalog");
  assert.equal(catalog.schema, "mamase.operation-catalog.v1");
  await runOperation("init", { workspace: workspacePath, name: "Skill scenario" });
  let revision = (await runOperation("inspect", { workspace: workspacePath })).revision.after;
  const added = await runOperation("add-dataset", { workspace: workspacePath, "expected-revision": revision, file: join(directory, "examples.jsonl"), name: "Synthetic", kind: "supervised", holdout: "20", provenance: "Synthetic fixture.", id: "dataset-1" });
  revision = added.revision.after;
  const recipe = { method: "lora", programId: "coven", datasetId: "dataset-1", student: "local-fixture", teacher: "", adapter: "lora", familiarId: "cody", instanceId: "test-coven", rank: 4, alpha: 8, learningRate: 0.001, epochs: 1, batchSize: 1, accumulation: 4, maxSequence: 512, outputPath: "./outputs/skill", objective: "Exercise the skill contract." };
  await writeFile(join(directory, "plan.json"), JSON.stringify({ id: "run-1", name: "Skill run", recipe }));
  const planned = await runOperation("create-recipe", { workspace: workspacePath, "expected-revision": revision, input: join(directory, "plan.json") });
  revision = planned.revision.after;
  const planOnly = await runOperation("receipt", { workspace: workspacePath, run: "run-1" });
  assert.deepEqual([planOnly.lane, planOnly.state, planOnly.nextAction.step, planOnly.nextAction.requiresApproval], ["peft", "planned", "prepare", false]);
  assert.equal(planOnly.run.status, "planned", "planning never starts training");

  // Stale revision and duplicate planning are visible outcomes, not silent writes.
  await assert.rejects(runOperation("create-recipe", { workspace: workspacePath, "expected-revision": hash("0"), input: join(directory, "plan.json") }), (error) => error.code === "stale-revision" && error.outcome === "blocked");
  assert.equal((await runOperation("create-recipe", { workspace: workspacePath, "expected-revision": revision, input: join(directory, "plan.json") })).outcome, "unchanged");

  // Changed input: a bundle prepared from different bytes is a blocker, never a quiet re-plan.
  const savedRecipe = (await runOperation("export-recipe", { workspace: workspacePath, run: "run-1" })).recipe ?? (await runOperation("inspect", { workspace: workspacePath, record: "run-1" })).record.recipe;
  const bundle = (extra = {}) => ({ schema: "mamase.local-bundle.v1", runId: "run-1", recipe: savedRecipe, dataset: { sha256: datasetSha }, split: { train: 8, holdout: 2 }, execution: "not-started", promotion: "not-authorized", ...extra });
  const bundleDir = join(directory, "bundle");
  await mkdir(bundleDir);
  await writeFile(join(bundleDir, "bundle.json"), JSON.stringify(bundle({ dataset: { sha256: hash("9") } })));
  const changed = await runOperation("receipt", { workspace: workspacePath, run: "run-1", bundle: bundleDir });
  assert.deepEqual([changed.state, changed.blockers.map((blocker) => blocker.code), changed.nextAction], ["blocked", ["source-changed"], null]);
  await writeFile(join(bundleDir, "bundle.json"), JSON.stringify(bundle()));
  const prepared = await runOperation("receipt", { workspace: workspacePath, run: "run-1", bundle: bundleDir });
  const bundleSha = sha256(await readFile(join(bundleDir, "bundle.json")));
  assert.deepEqual([prepared.state, prepared.fingerprints.bundle, prepared.nextAction.step], ["prepared", bundleSha, "preflight"]);

  // Synthetic evidence import (no real training): the train step requires approval and its evidence is the imported result.
  const result = { schema: "mamase.training-result.v1", runId: "run-1", bundleSha256: bundleSha, familiar: { familiarId: "cody", instanceId: "test-coven" }, baseModel: { label: "local-fixture", localPath: "/local/model", files: { "model.safetensors": hash("d") } }, adapter: { path: "/private/bundle/adapter", technique: "lora", files: { "adapter_model.safetensors": hash("f"), "adapter_config.json": hash("a") } }, datasetSha256: datasetSha, holdoutSha256: hash("d"), optimizerSteps: 2, evaluation: { metric: "completion-token-weighted-negative-log-likelihood", samples: 2, baseLoss: 2, adapterLoss: 1.5, delta: -0.5 }, trainableParameters: 100, totalParameters: 1000, promotion: "not-authorized" };
  const resultPath = join(directory, "result.json");
  await writeFile(resultPath, JSON.stringify(result));
  revision = (await runOperation("inspect", { workspace: workspacePath })).revision.after;
  await assert.rejects(runOperation("import-result", { workspace: workspacePath, "expected-revision": revision, file: resultPath }), /completed run report/, "a result without its journal is refused, not patched around");
  const progressPath = join(directory, "progress.json");
  const later = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
  const updates = [{ status: "running", step: 0, totalSteps: 2, loss: null, evalLoss: 2, note: "", recordedAt: later(1) }, { status: "completed", step: 2, totalSteps: 2, loss: 1, evalLoss: 1.5, note: "", recordedAt: later(2) }];
  await writeFile(progressPath, JSON.stringify({ schema: "mamase.run-report.v1", runId: "run-1", updates }));
  revision = (await runOperation("import-progress", { workspace: workspacePath, "expected-revision": revision, file: progressPath })).revision.after;
  assert.equal((await runOperation("import-progress", { workspace: workspacePath, "expected-revision": revision, file: progressPath })).outcome, "unchanged", "replayed journals are duplicates");
  await writeFile(progressPath, JSON.stringify({ schema: "mamase.run-report.v1", runId: "run-1", updates: [{ ...updates[1], loss: 0.5 }] }));
  await assert.rejects(runOperation("import-progress", { workspace: workspacePath, "expected-revision": revision, file: progressPath }), (error) => error.code === "progress-conflict" && error.outcome === "blocked", "an interrupted or divergent journal blocks instead of rewriting history");
  const imported = await runOperation("import-result", { workspace: workspacePath, "expected-revision": revision, file: resultPath });
  revision = imported.revision.after;
  assert.equal((await runOperation("import-result", { workspace: workspacePath, "expected-revision": revision, file: resultPath })).outcome, "unchanged", "duplicate imports are idempotent");
  const trained = await runOperation("receipt", { workspace: workspacePath, run: "run-1", bundle: bundleDir });
  assert.deepEqual([trained.state, trained.nextAction.step, trained.steps.find((step) => step.id === "train").requiresApproval], ["trained", "evaluate", true]);

  const resultSha = sha256(await readFile(resultPath));
  const report = { schema: "mamase.evaluation-report.v1", runId: "run-1", createdAt: at(5), resultSha256: resultSha, bundleSha256: bundleSha, datasetSha256: datasetSha, familiar: { familiarId: "cody", instanceId: "test-coven" }, adapterPath: "/private/bundle/adapter", suite: { name: "Synthetic regressions", version: "1", sha256: hash("f") }, decoding: { doSample: false, numBeams: 1, maxNewTokens: 16, seed: 42 }, device: "cpu", promotion: "not-authorized", cases: [
    { id: "task-1", category: "task", prompt: "PRIVATE-TASK-PROMPT", checks: [{ type: "equals", value: "pass" }], base: { response: "pass", passed: true }, adapter: { response: "pass", passed: true } },
    { id: "identity-1", category: "identity", prompt: "PRIVATE-IDENTITY-PROMPT", checks: [{ type: "contains", value: "Cody" }], base: { response: "unknown", passed: false }, adapter: { response: "I am Cody", passed: true } },
    { id: "consent-1", category: "consent", prompt: "PRIVATE-CONSENT-PROMPT", checks: [{ type: "not_contains", value: "forbidden" }], base: { response: "ok", passed: true }, adapter: { response: "ok", passed: true } },
    { id: "tool-1", category: "tool-boundary", prompt: "PRIVATE-TOOL-PROMPT", checks: [{ type: "equals", value: "approval" }], base: { response: "no", passed: false }, adapter: { response: "approval", passed: true } },
  ], summary: { samples: 4, basePassed: 2, adapterPassed: 4, regressions: 0 } };
  const reportPath = join(directory, "report.json");
  await writeFile(reportPath, JSON.stringify(report));
  const evaluated = await runOperation("import-evaluation", { workspace: workspacePath, "expected-revision": revision, file: reportPath });
  revision = evaluated.revision.after;
  const awaiting = await runOperation("receipt", { workspace: workspacePath, run: "run-1", bundle: bundleDir, out: join(directory, "receipt.json") });
  assert.deepEqual([awaiting.state, awaiting.nextAction.step, awaiting.nextAction.requiresApproval], ["awaiting-human-review", "human-review", true]);
  const backup = await runOperation("export-backup", { workspace: workspacePath, out: join(directory, "backup.json") });
  assert.equal(backup.backupSchema, "mamase.workspace-backup.v1");
  for (const file of ["receipt.json", "backup.json", "workspace.json"]) {
    const text = await readFile(join(directory, file), "utf8");
    assert.ok(!text.includes("PRIVATE-"), `${file} carries fingerprints and IDs, never case text`);
  }
  assert.ok(JSON.parse(await readFile(join(directory, "backup.json"), "utf8")).schema.startsWith("mamase.workspace-backup."));

  // The human decides in the UI; the agent only observes the recorded decision in the next backup.
  const stored = JSON.parse(await readFile(workspacePath, "utf8")).workspace;
  const reportSha = sha256(await readFile(reportPath));
  const review = await prepareReview(stored, stored.evaluations[0].id, report, reportSha);
  const unknown = { taskState: "unknown", responseJudgment: "unknown", executionEvidence: "unknown", receiptAdequacy: "not-applicable" };
  const reviewed = validateWorkspace(recordHumanDecision(stored, review, { id: "review-1", recordedAt: at(7), reviewer: "Human operator", decision: "needs-more-evidence", rationale: "Synthetic evidence only.", limitations: "Not candidate quality.", annotations: review.cases.map((item) => ({ caseId: item.id, caseSha256: item.sha256, base: unknown, adapter: unknown })) }));
  await writeFile(join(directory, "reviewed-backup.json"), JSON.stringify({ ...JSON.parse(await readFile(join(directory, "backup.json"), "utf8")), workspace: reviewed }));
  const restored = await runOperation("import-backup", { workspace: workspacePath, "expected-revision": revision, file: join(directory, "reviewed-backup.json") });
  assert.equal(restored.outcome, "changed");
  const done = await runOperation("receipt", { workspace: workspacePath, run: "run-1", bundle: bundleDir });
  assert.deepEqual([done.state, done.nextAction, done.steps.find((step) => step.id === "human-review").evidence[0].decisions], ["evidence-ready", null, 1]);
  assert.equal(done.run.status, "completed", "evidence-ready never changes run status, deployment or authorization");
});
