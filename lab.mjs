import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { assert, createWorkspace, parseDataset, validateDataset, validateRecipe, splitCounts, MAX_IMPORT_BYTES } from "./workspace.js";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

async function boundedRead(path, limit) {
  assert((await stat(path)).size <= limit, `File exceeds ${limit} bytes: ${path}`);
  const bytes = await readFile(path);
  assert(bytes.length <= limit, `File exceeds ${limit} bytes: ${path}`);
  return bytes;
}

export function prepareData(manifest, source, identity) {
  assert(manifest?.schema === "mamase.training-recipe.v1", "Expected a mamase.training-recipe.v1 export.");
  assert(typeof manifest.runId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(manifest.runId), "Invalid run ID.");
  const dataset = validateDataset(manifest.dataset);
  const workspace = createWorkspace();
  workspace.programs = [{ id: manifest.recipe?.programId }];
  workspace.datasets = [dataset];
  const recipe = validateRecipe(manifest.recipe, workspace);
  assert(recipe.familiarId && recipe.instanceId, "Bind both familiarId and instanceId in a new recipe before preparing training.");
  const declaredName = identity.identity.match(/^\s*(?:-\s*)?(?:\*\*)?Name:(?:\*\*)?\s*(.+?)\s*$/mi)?.[1];
  assert(declaredName, "IDENTITY.md must declare its familiar on a Name: line.");
  assert(declaredName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") === recipe.familiarId.toLowerCase(), "The name declared in IDENTITY.md does not match this recipe's familiar ID.");
  assert(dataset.sha256 === sha256(source), "Dataset fingerprint mismatch. Supply the exact imported file.");
  assert(dataset.bytes === source.length, "Dataset byte count mismatch.");
  const parsed = parseDataset(source.toString("utf8"));
  assert(parsed.records === dataset.records && parsed.format === dataset.format, "Dataset metadata does not match its source.");
  assert(manifest.dataset.splitSeed === 42, "Unsupported split seed; export the recipe again.");
  const identityPrompt = `Coven instance: ${recipe.instanceId}\nFamiliar ID: ${recipe.familiarId}\n\n${identity.identity}\n\n${identity.soul}`;
  const seen = new Set();
  const entries = source.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const row = JSON.parse(line);
    const messages = row.messages ?? [{ role: "user", content: row.prompt }, { role: "assistant", content: row.response }];
    assert(!messages.some((message) => message.role === "system"), "Dataset system messages can override familiar identity. Remove them and review the examples before import.");
    assert(messages.every((message, index) => message.role === (index % 2 ? "assistant" : "user")), "Training conversations must alternate user and assistant messages.");
    const prompt = messages.slice(0, -1).map(({ role, content }) => ({ role, content: content.trim() }));
    const key = sha256(JSON.stringify(prompt));
    assert(!seen.has(key), "Duplicate prompt detected. Deduplicate or curate prompt groups before importing to prevent holdout leakage.");
    seen.add(key);
    return {
      key,
      order: sha256(`42:${key}`),
      row: {
        prompt: [{ role: "system", content: identityPrompt }, ...messages.slice(0, -1)],
        completion: [messages.at(-1)],
      },
    };
  }).sort((a, b) => a.order.localeCompare(b.order));
  const counts = splitCounts(dataset);
  return {
    recipe, dataset, identityPrompt,
    train: entries.slice(counts.holdout).map((entry) => entry.row),
    holdout: entries.slice(0, counts.holdout).map((entry) => entry.row),
    split: {
      algorithm: "sha256-prompt-order-v1", seed: 42, ...counts,
      trainPromptHashes: entries.slice(counts.holdout).map((entry) => entry.key),
      holdoutPromptHashes: entries.slice(0, counts.holdout).map((entry) => entry.key),
    },
  };
}

export async function prepareBundle({ recipePath, datasetPath, identityDir, outputDir }) {
  const manifest = JSON.parse(await boundedRead(resolve(recipePath), 1024 * 1024));
  const directory = await realpath(resolve(identityDir));
  const files = {};
  for (const name of ["IDENTITY.md", "SOUL.md"]) {
    const path = await realpath(join(directory, name));
    assert(dirname(path) === directory, `${name} must belong to the selected familiar workspace, not a symlink to another workspace.`);
    const content = await boundedRead(path, 128 * 1024);
    assert(content.toString("utf8").trim(), `${name} must not be empty.`);
    files[name] = { path, sha256: sha256(content), content: content.toString("utf8") };
  }
  const source = await boundedRead(resolve(datasetPath), MAX_IMPORT_BYTES);
  const prepared = prepareData(manifest, source, { identity: files["IDENTITY.md"].content, soul: files["SOUL.md"].content });
  assert(basename(directory) === prepared.recipe.familiarId, "Familiar ID must match the selected workspace directory name.");
  const payloads = {
    "train.jsonl": jsonl(prepared.train),
    "holdout.jsonl": jsonl(prepared.holdout),
    "identity.json": json({ familiarId: prepared.recipe.familiarId, instanceId: prepared.recipe.instanceId, files }),
    "recipe.json": json(manifest),
  };
  const bundle = {
    schema: "mamase.local-bundle.v1",
    runId: manifest.runId,
    preparedAt: new Date().toISOString(),
    recipe: prepared.recipe,
    dataset: prepared.dataset,
    identity: { familiarId: prepared.recipe.familiarId, instanceId: prepared.recipe.instanceId, workspace: directory },
    split: prepared.split,
    files: Object.fromEntries(Object.entries(payloads).map(([name, content]) => [name, sha256(content)])),
    execution: "not-started",
    promotion: "not-authorized",
  };
  const out = resolve(outputDir);
  // Exclusive directory creation prevents replacing an experiment or its private data.
  await mkdir(out, { mode: 0o700 });
  for (const [name, content] of Object.entries(payloads)) await writeFile(join(out, name), content, { flag: "wx", mode: 0o600 });
  await writeFile(join(out, "bundle.json"), json(bundle), { flag: "wx", mode: 0o600 });
  return { path: out, bundle };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      recipe: { type: "string" }, dataset: { type: "string" },
      "identity-dir": { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
    },
  });
  if (values.help || !positionals.length) {
    console.log("Usage: npm run lab -- prepare --recipe recipe.json --dataset examples.jsonl --identity-dir /path/familiar --out .lab/experiment\nCreate the output parent first. Preparation never downloads models or starts training.\nUse the PEFT environment (training/requirements.txt), not managed MLX. Check readiness without loading weights or writing reports:\n.venv/bin/python training/preflight.py --bundle .lab/experiment --model /path/local-model --device cpu\nRead its JSON errors/warnings/facts; exit 1 means blocked. A ready preflight is not an OOM guarantee or a run report. Then explicitly train with the same model/device:\n.venv/bin/python training/train.py --bundle .lab/experiment --model /path/local-model --device cpu");
    return;
  }
  assert(positionals.length === 1 && positionals[0] === "prepare", "Only the prepare command is supported.");
  for (const key of ["recipe", "dataset", "identity-dir", "out"]) assert(values[key], `Missing --${key}.`);
  const result = await prepareBundle({ recipePath: values.recipe, datasetPath: values.dataset, identityDir: values["identity-dir"], outputDir: values.out });
  console.log(`Prepared ${result.path}\n${result.bundle.split.train} train / ${result.bundle.split.holdout} holdout. No training started.\nBefore training, run training/preflight.py with --bundle, --model and an explicit --device in your PEFT environment. It emits readiness JSON, not a training report.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Mamase preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
