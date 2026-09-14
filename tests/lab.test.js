import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareBundle, prepareData, sha256 } from "../lab.mjs";
import { createWorkspace, createRun, exportRecipe, importEvaluationReport, importTrainingResult, parseDataset, recordProgress, validateWorkspace } from "../workspace.js";

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

async function selectContext(options) {
  await writeFile(join(options.identityDir, "ROLE.md"), "- **Role:** Code familiar.\nUse only observed synthetic evidence.\n");
  const selection = {
    schema: "mamase.context-selection.v1", familiarId: "cody", instanceId: "test-coven",
    lane: "coding", role: "Code familiar.", coverage: "selected-sources",
    sources: [{ path: "IDENTITY.md", role: "identity" }, { path: "SOUL.md", role: "soul" }, { path: "ROLE.md", role: "role" }],
  };
  const contextManifestPath = join(options.identityDir, "context-selection.json");
  await writeFile(contextManifestPath, JSON.stringify(selection));
  const inspect = () => command(process.execPath, ["lab.mjs", "inspect-context", "--recipe", options.recipePath,
    "--identity-dir", options.identityDir, "--context-manifest", contextManifestPath]);
  const preview = JSON.parse(inspect().stdout);
  return { selection, inspect, preview, options: { ...options, contextManifestPath, contextSha256: preview.familiarContext.sha256 } };
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

test("explicit context preview binds ordered sources without rewriting legacy identity", async (context) => {
  const dir = await directory(context);
  const original = await prepareFiles(dir);
  const selected = await selectContext(original.options);
  await assert.rejects(access(original.options.outputDir));
  assert.deepEqual(selected.preview.sources.map(({ path, role }) => ({ path, role })), selected.selection.sources);
  assert.equal(selected.preview.familiarContext.scope, "selected-sources");
  await assert.rejects(prepareBundle({ ...selected.options, contextSha256: "0".repeat(64) }), /preview|review|fingerprint/i);
  await assert.rejects(access(original.options.outputDir));
  const prepared = await prepareBundle(selected.options);
  assert.equal(prepared.bundle.schema, "mamase.local-bundle.v2");
  assert.deepEqual(prepared.bundle.familiarContext, selected.preview.familiarContext);
  const code = "from pathlib import Path; from training.train import load_bundle; import sys; b, r = load_bundle(Path(sys.argv[1])); print(r['train'][0]['prompt'][0]['content'])";
  assert.match(command("python3", ["-B", "-c", code, selected.options.outputDir]).stdout, /Use only observed synthetic evidence/);
  const frozen = JSON.parse(await readFile(join(selected.options.outputDir, "context.json")));
  assert.equal(frozen.binding.promptSha256, selected.preview.familiarContext.promptSha256);
  assert.ok(!JSON.stringify(prepared.bundle.familiarContext).includes(dir));
  assert.ok(!JSON.stringify(prepared.bundle.familiarContext).includes("Use only observed"));
  await writeFile(join(original.options.identityDir, "ROLE.md"), "- **Role:** Code familiar.\nRecord a different synthetic rubric.\n");
  const changed = spawnSync("python3", ["-B", "-c", code, selected.options.outputDir], { cwd: root, encoding: "utf8" });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /context source changed/i);
  const newer = JSON.parse(selected.inspect().stdout);
  assert.notEqual(newer.familiarContext.sha256, selected.preview.familiarContext.sha256);
  await assert.rejects(prepareBundle({ ...selected.options, outputDir: join(dir, "stale") }), /preview|review|fingerprint/i);
  await writeFile(join(original.options.identityDir, "ROLE.md"), frozen.sources[2].content);
  await writeFile(selected.options.contextManifestPath, JSON.stringify({ ...selected.selection, sources: selected.selection.sources.toReversed() }));
  const reordered = spawnSync("python3", ["-B", "-c", code, selected.options.outputDir], { cwd: root, encoding: "utf8" });
  assert.notEqual(reordered.status, 0);
  assert.match(reordered.stderr, /Context selection changed/);
  await writeFile(selected.options.contextManifestPath, JSON.stringify(selected.selection));
  await rm(join(original.options.identityDir, "ROLE.md"));
  const missing = spawnSync("python3", ["-B", "-c", code, selected.options.outputDir], { cwd: root, encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ROLE.md|missing/i);
});

test("context sources and structured metadata fail closed before creating a bundle", async (context) => {
  const dir = await directory(context);
  const original = await prepareFiles(dir);
  const selected = await selectContext(original.options);
  for (const mutate of [
    (value) => { value.sources.reverse(); },
    (value) => { value.sources.push(value.sources[2]); },
    (value) => { value.sources[2].path = "../outside.md"; },
    (value) => { value.sources[2].path = "MEMORY.md"; },
    (value) => { value.sources[2].path = "USER.md"; },
    (value) => { value.sources[2].path = "skills/secrets.md"; },
    (value) => { value.familiarId = "another-familiar"; },
    (value) => { value.instanceId = "another-instance"; },
    (value) => { value.role = "A conflicting role"; },
    (value) => { value.coverage = "full-runtime-parity"; },
  ]) {
    const value = structuredClone(selected.selection);
    mutate(value);
    await writeFile(selected.options.contextManifestPath, JSON.stringify(value));
    await assert.rejects(prepareBundle(selected.options));
    await assert.rejects(access(original.options.outputDir));
  }
  await writeFile(selected.options.contextManifestPath, JSON.stringify(selected.selection));
  await rm(join(original.options.identityDir, "ROLE.md"));
  await writeFile(join(dir, "outside.md"), "Neighboring private fixture");
  await symlink(join(dir, "outside.md"), join(original.options.identityDir, "ROLE.md"));
  await assert.rejects(prepareBundle(selected.options), /selected familiar|escape|symlink/i);
  await rm(join(original.options.identityDir, "ROLE.md"));
  await assert.rejects(prepareBundle(selected.options), /ENOENT|missing/i);
  await writeFile(join(original.options.identityDir, "ROLE.md"), "x".repeat(128 * 1024 + 1));
  await assert.rejects(prepareBundle(selected.options), /exceeds|large/i);
  for (const content of ["- **Role:**\nUse observed evidence.\n", "- **Role:** Code familiar.\n- **Role:** Code familiar.\n"]) {
    await writeFile(join(original.options.identityDir, "ROLE.md"), content);
    await assert.rejects(prepareBundle(selected.options), /Structured Role|Duplicate structured Role/);
  }
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
      const fixture = await prepareFiles(dir, adapter);
      const workspace = fixture.workspace;
      const options = adapter === "lora" ? (await selectContext(fixture.options)).options : fixture.options;
      await prepareBundle(options);
      if (adapter === "lora") {
        const preflight = JSON.parse(command(python, ["training/preflight.py", "--bundle", options.outputDir, "--model", model, "--device", "cpu"]).stdout);
        assert.equal(preflight.ready, true);
        assert.equal(preflight.facts.bundle.familiarContext.sha256, options.contextSha256);
      }
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
        assert.equal(result.familiarContext.sha256, options.contextSha256);
        const contextSelection = JSON.parse(await readFile(options.contextManifestPath));
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
        assert.equal(first.promotion, "not-authorized");
        assert.deepEqual(first.familiarContext, result.familiarContext);
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
          [join(options.outputDir, "result.json"), JSON.stringify({ ...result, familiarContext: { ...result.familiarContext, sha256: "0".repeat(64) } }), /familiar context mismatch/i],
          [join(options.outputDir, "result.json"), JSON.stringify({ ...result, adapter: { ...result.adapter, path: model } }), /Adapter path/i],
          [join(options.outputDir, "run-report.json"), JSON.stringify({ ...report, updates: report.updates.slice(0, -1) }), /completed/i],
          [join(options.identityDir, "SOUL.md"), "Changed synthetic identity", /identity changed/i],
          [join(options.identityDir, "ROLE.md"), "Changed synthetic role", /context source changed/i],
          [options.contextManifestPath, JSON.stringify({ ...contextSelection, sources: contextSelection.sources.toReversed() }), /Context selection changed/i],
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
