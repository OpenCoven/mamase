import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareBundle, prepareData, sha256 } from "../lab.mjs";
import { createWorkspace, createRun, exportRecipe, importEvaluationReport, importTrainingResult, parseDataset, recordProgress, validateWorkspace } from "../workspace.js";
import { syntheticSuiteTemplate } from "../evaluation-suites.js";
import { prepareReview, recordHumanDecision } from "../human-review.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.MAMASE_TRAINING_PYTHON || join(root, ".venv/bin/python");
const fixtureIdentity = { identity: "# IDENTITY.md - Cody\n- **Name:** Cody\n- **Role:** Code familiar.", soul: "# SOUL.md\nI am Cody. Preserve consent and never invent evidence." };
const source = Buffer.from(Array.from({ length: 6 }, (_, index) => JSON.stringify({ prompt: `Task ${index}: record evidence`, response: `Cody records observed result ${index}.` })).join("\n") + "\n");

function fixture(bytes = source, overrides = {}) {
  const workspace = createWorkspace();
  workspace.datasets.push({
    id: "dataset-1", name: "Synthetic fixture", filename: "fixture.jsonl", ...parseDataset(bytes.toString()),
    bytes: bytes.length, format: "prompt-response", kind: overrides.method === "distillation" ? "teacher" : "supervised", teacher: overrides.teacher || "",
    provenance: "Synthetic test data, not familiar memory.", holdout: 34,
    sha256: sha256(bytes), createdAt: new Date().toISOString(),
  });
  const run = createRun({
    id: "run-1", name: "Synthetic smoke", createdAt: new Date().toISOString(),
    recipe: {
      method: "lora", programId: "coven", datasetId: "dataset-1", student: "synthetic-local-fixture",
      teacher: "", adapter: "lora", familiarId: "cody", instanceId: "test-coven",
      rank: 4, alpha: 8, learningRate: 0.001, epochs: 1, batchSize: 1, accumulation: 2,
      maxSequence: 512, outputPath: "./outputs/unused-recipe-hint", objective: "Exercise training, not claim model quality.", ...overrides,
    },
  }, workspace);
  workspace.runs.push(run);
  return { workspace, run, manifest: exportRecipe(run, workspace) };
}

async function directory(context) {
  await mkdir(join(root, ".lab"), { recursive: true });
  const dir = await mkdtemp(join(root, ".lab/test-"));
  context.after(() => rm(dir, { recursive: true }));
  return dir;
}

async function prepareFiles(dir, adapter = "lora") {
  const { manifest, workspace } = fixture(source, adapter === "distillation" ? { adapter: "lora", method: "distillation", teacher: "synthetic-teacher" } : { adapter });
  const identityDir = join(dir, "cody");
  await mkdir(identityDir, { recursive: true });
  await writeFile(join(identityDir, "IDENTITY.md"), fixtureIdentity.identity);
  await writeFile(join(identityDir, "SOUL.md"), fixtureIdentity.soul);
  const recipePath = join(dir, `${adapter}-recipe.json`);
  const datasetPath = join(dir, "examples.jsonl");
  await writeFile(recipePath, JSON.stringify(manifest));
  await writeFile(datasetPath, source);
  return { workspace, options: { recipePath, datasetPath, identityDir, outputDir: join(dir, adapter) } };
}

function command(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", timeout: 120_000, env: { ...process.env, HF_HOME: join(root, ".cache/huggingface"), PYTHONDONTWRITEBYTECODE: "1", OMP_NUM_THREADS: "1" } });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  return result;
}

test("adapter options and familiar binding survive workspace restore; old recipes remain usable", () => {
  for (const adapter of ["lora", "qlora", "rslora", "dora"]) {
    const { workspace } = fixture(source, { adapter });
    assert.equal(validateWorkspace(workspace).runs[0].recipe.adapter, adapter);
  }
  const legacy = fixture().workspace;
  delete legacy.runs[0].recipe.adapter;
  delete legacy.runs[0].recipe.familiarId;
  delete legacy.runs[0].recipe.instanceId;
  const restored = validateWorkspace(legacy);
  assert.equal(restored.runs[0].recipe.adapter, "lora");
  assert.equal(restored.runs[0].recipe.familiarId, "");
  assert.throws(() => prepareData(exportRecipe(restored.runs[0], restored), source, fixtureIdentity), /Bind both/);
  assert.throws(() => fixture(source, { adapter: "unsupported" }), /supported adapter/);
  assert.throws(() => fixture(source, { familiarId: "" }), /both familiar/);
});

test("preparation creates deterministic, disjoint splits and canonical identity prompts", () => {
  const { manifest } = fixture();
  const prepared = prepareData(manifest, source, fixtureIdentity);
  assert.deepEqual(prepared, prepareData(manifest, source, fixtureIdentity));
  assert.equal(prepared.train.length, 4);
  assert.equal(prepared.holdout.length, 2);
  assert.equal(new Set([...prepared.split.trainPromptHashes, ...prepared.split.holdoutPromptHashes]).size, 6);
  for (const row of [...prepared.train, ...prepared.holdout]) {
    assert.equal(row.prompt[0].role, "system");
    assert.match(row.prompt[0].content, /test-coven/);
    assert.match(row.prompt[0].content, /I am Cody/);
    assert.equal(row.completion[0].role, "assistant");
  }
});

test("wrong source, duplicate prompts, and competing system identities fail before output", () => {
  assert.throws(() => prepareData(fixture().manifest, source, { ...fixtureIdentity, identity: "- **Name:** Nova" }), /does not match/);
  assert.throws(() => prepareData(fixture().manifest, Buffer.concat([source, Buffer.from("\n")]), fixtureIdentity), /fingerprint/);
  const duplicates = Buffer.from('{"prompt":"same","response":"a"}\n{"prompt":"same","response":"b"}');
  assert.throws(() => prepareData(fixture(duplicates).manifest, duplicates, fixtureIdentity), /Duplicate prompt/);
  const conflicting = Buffer.from([0, 1].map((n) => JSON.stringify({ messages: [{ role: "system", content: "You are another familiar." }, { role: "user", content: String(n) }, { role: "assistant", content: "Answer" }] })).join("\n"));
  const manifest = fixture(conflicting).manifest;
  manifest.dataset.format = "messages";
  assert.throws(() => prepareData(manifest, conflicting, fixtureIdentity), /system messages/);
});

test("production CLI writes fingerprinted private bundles and refuses overwrite", async (context) => {
  const dir = await directory(context);
  const { options } = await prepareFiles(dir);
  command(process.execPath, ["lab.mjs", "prepare", "--recipe", options.recipePath, "--dataset", options.datasetPath, "--identity-dir", options.identityDir, "--out", options.outputDir]);
  const bundle = JSON.parse(await readFile(join(options.outputDir, "bundle.json")));
  assert.equal(bundle.execution, "not-started");
  assert.equal(bundle.promotion, "not-authorized");
  for (const [name, digest] of Object.entries(bundle.files)) assert.equal(sha256(await readFile(join(options.outputDir, name))), digest);
  await assert.rejects(prepareBundle(options), { code: "EEXIST" });
  const bad = { ...options, identityDir: dir, outputDir: join(dir, "bad") };
  await assert.rejects(prepareBundle(bad));
  await assert.rejects(access(bad.outputDir));
});

test("Python bundle validation rejects altered data and changed identity", async (context) => {
  const dir = await directory(context);
  const { options } = await prepareFiles(dir);
  await prepareBundle(options);
  const code = "from pathlib import Path; from training.train import load_bundle; import sys; load_bundle(Path(sys.argv[1]))";
  command("python3", ["-c", code, options.outputDir]);
  await writeFile(join(options.identityDir, "SOUL.md"), "Changed identity");
  const changed = spawnSync("python3", ["-c", code, options.outputDir], { cwd: root, encoding: "utf8" });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /Familiar identity changed/);
  await writeFile(join(options.identityDir, "SOUL.md"), fixtureIdentity.soul);
  await writeFile(join(options.outputDir, "train.jsonl"), "{}");
  const corrupt = spawnSync("python3", ["-c", code, options.outputDir], { cwd: root, encoding: "utf8" });
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /fingerprint mismatch/);
});

test("completion loss masks identity and prompts and refuses silent truncation", () => {
  command("python3", ["-c", `
from training.train import tokenize_rows
class Tokenizer:
    chat_template = "fixture"
    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        return "".join(m["role"] + ":" + m["content"] + ";" for m in messages) + ("assistant:" if add_generation_prompt else "")
    def encode(self, text, add_special_tokens=False):
        return list(text.encode())
row = {"prompt": [{"role": "system", "content": "identity"}, {"role": "user", "content": "question"}], "completion": [{"role": "assistant", "content": "OK"}]}
encoded = tokenize_rows([row], Tokenizer(), 1000)[0]
assert encoded["labels"][:-3] == [-100] * (len(encoded["labels"]) - 3)
assert encoded["labels"][-3:] == encoded["input_ids"][-3:]
try:
    tokenize_rows([row], Tokenizer(), 1)
except ValueError as error:
    assert "never silently truncated" in str(error)
else:
    raise AssertionError("Truncated training example was accepted")
`]);
});

let trainingAvailable = true;
try { await access(python); } catch (error) { if (error.code !== "ENOENT") throw error; trainingAvailable = false; }

test("real local PEFT training saves reloadable adapters and importable observed reports", { skip: !trainingAvailable && "Install training/requirements.txt in .venv for the real training smoke." }, async (context) => {
  const dir = await directory(context);
  const model = join(dir, "model");
  command(python, ["tests/training_fixture.py", "create", model]);
  for (const adapter of ["lora", "rslora", "dora", "distillation"]) {
    await context.test(adapter, async () => {
      const { workspace, options } = await prepareFiles(dir, adapter);
      await prepareBundle(options);
      command(python, ["training/train.py", "--bundle", options.outputDir, "--model", model]);
      const report = JSON.parse(await readFile(join(options.outputDir, "run-report.json")));
      for (const update of report.updates) workspace.runs[0] = recordProgress(workspace.runs[0], update);
      assert.equal(workspace.runs[0].status, "completed");
      assert.equal(workspace.runs[0].step, 2);
      assert.equal(validateWorkspace(workspace).runs[0].status, "completed");
      const result = JSON.parse(await readFile(join(options.outputDir, "result.json")));
      assert.equal(result.adapter.technique, adapter === "distillation" ? "lora" : adapter);
      assert.equal(result.evaluation.samples, 2);
      assert.ok(Number.isFinite(result.evaluation.baseLoss) && Number.isFinite(result.evaluation.adapterLoss));
      assert.equal(result.promotion, "not-authorized");
      assert.ok(result.trainableParameters > 0 && result.trainableParameters < result.totalParameters);
      command(python, ["tests/training_fixture.py", "verify", model, result.adapter.path]);
      if (adapter === "lora") {
        const suitePath = join(dir, "suite.json");
        const suite = {
          schema: "mamase.eval-suite.v1", name: "Independent synthetic pipeline fixture", version: "1",
          cases: ["task", "identity", "consent", "tool-boundary"].map((category) => ({
            id: category, category, prompt: `Independent fictional ${category} question`,
            checks: [{ type: "contains", value: "Cody" }, { type: "not_contains", value: "Cody" }],
          })),
        };
        await writeFile(suitePath, JSON.stringify(suite));
        const args = (out) => ["training/evaluate.py", "--bundle", options.outputDir, "--suite", suitePath, "--out", out, "--max-new-tokens", "8"];
        const firstOut = join(dir, "eval-first");
        command(python, ["tests/training_fixture.py", "evaluate-offline", model, ...args(firstOut).slice(1)]);
        const first = JSON.parse(await readFile(join(firstOut, "evaluation-report.json")));
        assert.deepEqual(first.summary, { samples: 4, basePassed: 0, adapterPassed: 0, regressions: 0 });
        assert.deepEqual(first.decoding, { doSample: false, numBeams: 1, maxNewTokens: 8, seed: 42 });
        assert.equal(first.resultSha256, sha256(await readFile(join(options.outputDir, "result.json"))));
        assert.equal(first.suite.sha256, sha256(await readFile(suitePath)));
        assert.equal(first.suite.governance.classification, "legacy-development");
        assert.equal(first.suite.governance.independence, "unverified");
        assert.equal(first.promotion, "not-authorized");
        assert.match(first.interpretation, /semantic|deployment/);
        assert.equal((await stat(firstOut)).mode & 0o777, 0o700);
        assert.equal((await stat(join(firstOut, "evaluation-report.json"))).mode & 0o777, 0o600);
        command(python, ["tests/training_fixture.py", "verify-evaluation", model, options.outputDir, join(firstOut, "evaluation-report.json")]);
        for (const item of first.cases) {
          for (const candidate of [item.base, item.adapter]) assert.ok(typeof candidate.response === "string" && candidate.response.length <= 64000);
        }
        const observed = first.cases[0].base.response;
        suite.version = "2";
        suite.cases[0].checks = observed.trim() && observed.length <= 2000
          ? [{ type: "equals", value: observed }]
          : [{ type: "not_contains", value: "never-generated-boundary-marker" }];
        suite.cases[2].checks = [{ type: "not_contains", value: "never-generated-boundary-marker" }];
        await writeFile(suitePath, JSON.stringify(suite));
        const out = join(dir, "eval-scored");
        command(python, args(out));
        const bytes = await readFile(join(out, "evaluation-report.json"));
        const paired = JSON.parse(bytes);
        assert.equal(paired.summary.basePassed, 2);
        for (const item of paired.cases) {
          for (const candidate of [item.base, item.adapter]) {
            const passed = item.checks.every(({ type, value }) => type === "equals" ? candidate.response === value : type === "contains" ? candidate.response.includes(value) : !candidate.response.includes(value));
            assert.equal(candidate.passed, passed);
          }
        }
        assert.equal(paired.summary.adapterPassed, paired.cases.filter((item) => item.adapter.passed).length);
        assert.equal(paired.summary.regressions, paired.cases.filter((item) => item.base.passed && !item.adapter.passed).length);
        const imported = importTrainingResult(workspace, result, { id: "artifact-paired", sha256: first.resultSha256, createdAt: new Date().toISOString() });
        const compared = importEvaluationReport(imported, paired, { id: "evaluation-paired", sha256: sha256(bytes), createdAt: new Date().toISOString() });
        assert.equal(compared.evaluations.length, 1);
        assert.equal(imported.evaluations.length, 0);
        assert.ok(!JSON.stringify(compared).includes(suite.cases[0].prompt));
        const repeatOut = join(dir, "eval-repeat");
        command(python, args(repeatOut));
        const repeated = JSON.parse(await readFile(join(repeatOut, "evaluation-report.json")));
        assert.deepEqual(repeated.cases, paired.cases);
        assert.deepEqual(repeated.summary, paired.summary);

        const governedPath = join(dir, "synthetic-suite-v2.json");
        const historyPath = join(dir, "evaluation-history.json");
        const inventoryPath = join(dir, "task-lineage.json");
        const governed = syntheticSuiteTemplate();
        governed.intendedUse = "tuning";
        governed.cases[1].familyId = governed.cases[2].familyId;
        await writeFile(governedPath, JSON.stringify(governed));
        await writeFile(inventoryPath, JSON.stringify({
          schema: "mamase.task-lineage.v1", bundleSha256: result.bundleSha256, datasetSha256: result.datasetSha256,
          coverage: "complete-declared", provenance: "Synthetic optional inventory; no parser-supplied lineage claim.",
          groups: [{ familyId: "fixture-alpha", use: "training", source: "Synthetic declared training task family." }],
        }));
        const governedArgs = (output) => ["training/evaluate.py", "--bundle", options.outputDir, "--suite", governedPath,
          "--history", historyPath, "--task-lineage", inventoryPath, "--out", output, "--max-new-tokens", "8"];
        command(python, governedArgs(join(dir, "eval-v2-tuning")));
        governed.name = "Renamed synthetic suite";
        governed.version = "3";
        governed.intendedUse = "final";
        await writeFile(governedPath, JSON.stringify(governed));
        const governedOut = join(dir, "eval-v2-renamed-final");
        command(python, governedArgs(governedOut));
        const governedBytes = await readFile(join(governedOut, "evaluation-report.json"));
        const governedReport = JSON.parse(governedBytes);
        assert.equal(governedReport.suite.sha256, sha256(await readFile(governedPath)));
        assert.equal(governedReport.suite.historySha256, sha256(await readFile(historyPath)));
        assert.equal(governedReport.suite.governance.trainingLineage.sha256, sha256(await readFile(inventoryPath)));
        assert.equal(governedReport.suite.governance.independence, "known-exposure");
        assert.equal(governedReport.suite.governance.caseCount, 4);
        assert.equal(governedReport.suite.governance.groupCount, 3);
        assert.ok(governedReport.suite.governance.history.events.some((event) => event.use === "tuning"));
        assert.ok(governedReport.suite.governance.history.events.some((event) => event.use === "training"));
        assert.deepEqual(governedReport.cases.map((row) => row.familyId), governed.cases.map((row) => row.familyId));
        const governedWorkspace = importEvaluationReport(imported, governedReport, {
          id: "evaluation-governed", sha256: sha256(governedBytes), createdAt: new Date().toISOString(),
        });
        const localReview = await prepareReview(governedWorkspace, "evaluation-governed", governedReport, sha256(governedBytes));
        const unknown = { taskState: "unknown", responseJudgment: "unknown", executionEvidence: "unknown", receiptAdequacy: "not-applicable" };
        const reviewed = validateWorkspace(recordHumanDecision(governedWorkspace, localReview, {
          id: "tiny-model-review", recordedAt: new Date().toISOString(), reviewer: "Synthetic smoke operator",
          decision: "needs-more-evidence", rationale: "Actual tiny-model output exercises evidence binding only.",
          limitations: "Not candidate quality or a production benchmark; text-only evidence.",
          annotations: localReview.cases.map((item) => ({ caseId: item.id, caseSha256: item.sha256, base: unknown, adapter: unknown })),
        }));
        assert.deepEqual(reviewed.evaluations[0].comparison, governedWorkspace.evaluations[0].comparison);
        assert.ok(!JSON.stringify(reviewed).includes(governed.cases[0].prompt));

        async function fails(expected, output = join(dir, "eval-error"), extra = []) {
          const failed = spawnSync(python, [...args(output), ...extra], { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
          assert.notEqual(failed.status, 0);
          assert.match(failed.stderr, expected);
          if (output !== out) await assert.rejects(access(output));
        }
        await fails(/exist|overwrite/i, out);
        assert.deepEqual(await readFile(join(out, "evaluation-report.json")), bytes);
        await fails(/parent|No such file/, join(dir, "missing", "eval"));
        for (const tokens of ["0", "513", "-1", "1.5"]) await fails(/max.new.tokens|integer/i, undefined, ["--max-new-tokens", tokens]);
        await fails(/maxSequence|context/, undefined, ["--max-new-tokens", "512"]);
        for (const split of ["train", "holdout"]) {
          const row = JSON.parse((await readFile(join(options.outputDir, `${split}.jsonl`), "utf8")).trim().split("\n")[0]);
          const leaked = structuredClone(suite);
          leaked.cases[0].prompt = ` \n${row.prompt.find((message) => message.role === "user").content}  `;
          await writeFile(suitePath, JSON.stringify(leaked));
          await fails(/overlaps/);
        }
        await writeFile(suitePath, JSON.stringify(suite));
        for (const [path, replacement, expected] of [
          [join(options.outputDir, "result.json"), JSON.stringify({ ...result, datasetSha256: "0".repeat(64) }), /dataset/i],
          [join(options.outputDir, "result.json"), JSON.stringify({ ...result, bundleSha256: "0".repeat(64) }), /bundle fingerprint/i],
          [join(options.outputDir, "result.json"), JSON.stringify({ ...result, holdoutSha256: "0".repeat(64) }), /holdout fingerprint/i],
          [join(options.outputDir, "result.json"), JSON.stringify({ ...result, runId: "another-run" }), /run ID/i],
          [join(options.outputDir, "result.json"), JSON.stringify({ ...result, familiar: { ...result.familiar, instanceId: "other-instance" } }), /identity mismatch/i],
          [join(options.outputDir, "result.json"), JSON.stringify({ ...result, adapter: { ...result.adapter, path: model } }), /Adapter path/i],
          [join(options.outputDir, "run-report.json"), JSON.stringify({ ...report, updates: report.updates.slice(0, -1) }), /completed/i],
          [join(options.identityDir, "SOUL.md"), "Changed synthetic identity", /identity changed/i],
          [join(model, "config.json"), "{}", /Base.model.*fingerprint/i],
          [join(result.adapter.path, "adapter_model.safetensors"), "changed", /Adapter.*fingerprint/i],
          [join(options.outputDir, "holdout.jsonl"), "{}", /fingerprint/i],
        ]) {
          const original = await readFile(path);
          try {
            await writeFile(path, replacement);
            await fails(expected);
          } finally {
            await writeFile(path, original);
          }
        }
        for (const [path, expected] of [
          [join(options.outputDir, "training.lock"), /completed and unlocked/],
          [join(model, "unrecorded.bin"), /Base.model.*fingerprint/i],
          [join(result.adapter.path, "unrecorded.bin"), /Adapter.*fingerprint/i],
        ]) {
          try {
            await writeFile(path, "unexpected", { flag: "wx" });
            await fails(expected);
          } finally {
            await rm(path);
          }
        }
        const suiteBytes = await readFile(suitePath);
        const changedOut = join(dir, "eval-changed-during-inference");
        try {
          const changed = spawnSync(python, ["tests/training_fixture.py", "change-during-evaluation", model, options.outputDir, suitePath, changedOut], { cwd: root, encoding: "utf8", timeout: 120_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", OMP_NUM_THREADS: "1" } });
          assert.notEqual(changed.status, 0);
          assert.match(changed.stderr, /Suite changed during evaluation/);
          await assert.rejects(access(join(changedOut, "evaluation-report.json")));
        } finally {
          await writeFile(suitePath, suiteBytes);
        }
      }
      const repeat = spawnSync(python, ["training/train.py", "--bundle", options.outputDir, "--model", model], { cwd: root, encoding: "utf8" });
      assert.notEqual(repeat.status, 0);
      assert.match(repeat.stderr, /already has a run/);
    });
  }
  const { options } = await prepareFiles(dir, "qlora");
  await prepareBundle(options);
  const unsupported = spawnSync(python, ["training/train.py", "--bundle", options.outputDir, "--model", model], { cwd: root, encoding: "utf8" });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /requires CUDA/);
  await assert.rejects(access(join(options.outputDir, "run-report.json")));
  const failedDir = join(dir, "failed-attempt");
  await mkdir(failedDir);
  const failed = await prepareFiles(failedDir);
  await prepareBundle(failed.options);
  const invalidModel = join(failedDir, "invalid-model");
  await mkdir(invalidModel);
  await writeFile(join(invalidModel, "config.json"), '{"model_type":"unrecognized-test-model"}');
  // Retain the valid tokenizer so the failure occurs after the training journal starts.
  for (const name of ["tokenizer.json", "tokenizer_config.json", "chat_template.jinja"]) {
    await writeFile(join(invalidModel, name), await readFile(join(model, name)));
  }
  await writeFile(join(invalidModel, "model.safetensors"), "not weights");
  const failure = spawnSync(python, ["training/train.py", "--bundle", failed.options.outputDir, "--model", invalidModel], { cwd: root, encoding: "utf8" });
  assert.notEqual(failure.status, 0);
  const failedReport = JSON.parse(await readFile(join(failed.options.outputDir, "run-report.json")));
  for (const update of failedReport.updates) failed.workspace.runs[0] = recordProgress(failed.workspace.runs[0], update);
  assert.equal(failed.workspace.runs[0].status, "failed");
  await assert.rejects(access(join(failed.options.outputDir, "result.json")));
  await assert.rejects(access(join(failed.options.outputDir, "training.lock")));
});
