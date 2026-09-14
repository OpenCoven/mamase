import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  assert, createWorkspace, createRun, exportRecipe, importEvaluationReport, importTrainingResult, parseDataset,
  previewProgressReport, validateDataset, validateWorkspace, MAX_IMPORT_BYTES, MAX_WORKSPACE_BYTES,
} from "./workspace.js";
import { exportWorkspaceBackup, parseWorkspaceBackup, MAX_BACKUP_BYTES } from "./backups.js";
import { boundedRead, sha256 } from "./familiar-context.mjs";
import { mergeTrainingJob } from "./training-state.js";
import { workflowReceipt, WORKFLOW_RECEIPT_SCHEMA } from "./workflow-receipt.mjs";

export const CATALOG_SCHEMA = "mamase.operation-catalog.v1";
export const RECEIPT_SCHEMA = "mamase.operation-receipt.v1";
export const WORKSPACE_FILE_SCHEMA = "mamase.workspace-file.v1";
export const OUTCOMES = ["changed", "unchanged", "blocked", "failed"];
const MAX_INPUT_BYTES = 1024 * 1024;
const COLLECTIONS = ["programs", "datasets", "runs", "artifacts", "evaluations"];

export class OperationError extends Error {
  constructor(code, message, outcome = "failed") {
    super(message);
    this.code = code;
    this.outcome = outcome;
  }
}
const blocked = (code, message) => new OperationError(code, message, "blocked");

// Operation names, versioned input/output contracts and side effects. Agents read this instead of internal signatures.
export const OPERATIONS = Object.freeze({
  catalog: { mutates: false, workspace: false, input: {}, output: CATALOG_SCHEMA, description: "List supported operations and contract versions." },
  init: { mutates: true, workspace: "create", input: { name: "optional workspace name (1-80 characters)" }, output: RECEIPT_SCHEMA, description: "Create a new private workspace file. Fails if the file exists." },
  inspect: { mutates: false, workspace: "read", input: { record: "optional record ID from any collection" }, output: RECEIPT_SCHEMA, description: "Return the current revision, collection summaries, or one record." },
  "add-dataset": { mutates: true, workspace: "write", input: { file: "JSONL dataset path (bytes are hashed and counted, never stored)", name: "dataset name", kind: "supervised|teacher", holdout: "1-50", provenance: "text", teacher: "required for teacher kind", id: "optional stable dataset ID" }, output: RECEIPT_SCHEMA, description: "Register bounded dataset metadata and its SHA-256 through the shared validators." },
  "create-recipe": { mutates: true, workspace: "write", input: { input: "JSON file: { id?, name, recipe: <mamase recipe fields> }" }, output: RECEIPT_SCHEMA, description: "Save a planned run. Training does not start." },
  "export-recipe": { mutates: false, workspace: "read", input: { run: "run ID", out: "optional output path (exclusive create)" }, output: "mamase.training-recipe.v1", description: "Export the existing training-recipe contract for a run." },
  "import-progress": { mutates: true, workspace: "write", input: { file: "mamase.run-report.v1 JSON path" }, output: RECEIPT_SCHEMA, description: "Replay progress observations; duplicates are unchanged, conflicts are blocked without mutation." },
  "import-result": { mutates: true, workspace: "write", input: { file: "training result.json path", id: "optional stable artifact ID" }, output: RECEIPT_SCHEMA, description: "Import a CLI training result as an adapter artifact with lineage." },
  "import-evaluation": { mutates: true, workspace: "write", input: { file: "evaluation report.json path", id: "optional stable evaluation ID" }, output: RECEIPT_SCHEMA, description: "Import a paired evaluation report bound to an imported result." },
  "export-backup": { mutates: false, workspace: "read", input: { out: "backup file path (exclusive create)" }, output: "mamase.workspace-backup.v1", description: "Write the browser-compatible backup envelope for import into the UI." },
  receipt: { mutates: false, workspace: "read", input: { run: "run ID", bundle: "optional prepared PEFT bundle directory", server: "optional loopback Mamase URL such as http://127.0.0.1:3000 for managed capability/job lookup", out: "optional receipt path (exclusive create)" }, output: WORKFLOW_RECEIPT_SCHEMA, description: "Derive lane, fingerprints, executed steps, blockers and the next permitted action for a run. Launches nothing." },
  "import-job": { mutates: true, workspace: "write", input: { file: "JSON path holding { job } from GET /api/training/runs/<runId> or /api/training/jobs/<jobId>" }, output: RECEIPT_SCHEMA, description: "Reconcile a managed MLX job record into the run using the existing identity, history and artifact guards. Never relaunches." },
  "import-backup": { mutates: true, workspace: "write", input: { file: "mamase.workspace-backup.v1 or legacy workspace JSON path" }, output: RECEIPT_SCHEMA, description: "Replace the file workspace with an explicitly selected backup. Requires the expected revision." },
});

export function catalog() {
  return {
    schema: CATALOG_SCHEMA,
    workspaceFileSchema: WORKSPACE_FILE_SCHEMA,
    backupSchema: "mamase.workspace-backup.v1",
    recipeSchema: "mamase.training-recipe.v1",
    workflowReceiptSchema: WORKFLOW_RECEIPT_SCHEMA,
    outcomes: OUTCOMES,
    exitCodes: { changed: 0, unchanged: 0, blocked: 2, failed: 1 },
    revision: "SHA-256 of the workspace file bytes; every mutating operation requires --expected-revision.",
    operations: Object.entries(OPERATIONS).map(([name, operation]) => ({ name, ...operation })),
  };
}

const revisionOf = (bytes) => sha256(bytes);
const parseJson = (bytes, label) => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    throw new OperationError("invalid-json", `${label} is not valid UTF-8 JSON. No changes were made.`);
  }
};

export async function readWorkspaceFile(path) {
  let bytes;
  try {
    bytes = await boundedRead(path, MAX_WORKSPACE_BYTES + 1024);
  } catch (error) {
    if (error.code === "ENOENT") throw new OperationError("workspace-missing", "The workspace file does not exist. Run init first.");
    throw error;
  }
  const file = parseJson(bytes, "Workspace file");
  assert(file && typeof file === "object" && file.schema === WORKSPACE_FILE_SCHEMA && Object.keys(file).every((key) => ["schema", "workspace"].includes(key)),
    "Unsupported workspace file. Expected mamase.workspace-file.v1.");
  return { workspace: validateWorkspace(file.workspace), revision: revisionOf(bytes) };
}

function serializeWorkspace(workspace) {
  const valid = validateWorkspace(workspace);
  assert(Buffer.byteLength(JSON.stringify(valid)) <= MAX_WORKSPACE_BYTES, "Workspace exceeds 4 MB. Export a backup before archiving older data.");
  // Compact serialization keeps the written file inside the bound that readWorkspaceFile enforces.
  const bytes = Buffer.from(`${JSON.stringify({ schema: WORKSPACE_FILE_SCHEMA, workspace: valid })}\n`);
  assert(bytes.length <= MAX_WORKSPACE_BYTES + 1024, "Workspace file exceeds its storage limit.");
  return bytes;
}

// Exclusive lock, re-read under lock, compare with the expected revision, then atomic rename. Stale or concurrent edits never mutate.
async function writeWorkspaceFile(path, workspace, expectedRevision, { create = false, snapshot = null } = {}) {
  const target = resolve(path);
  const lockPath = `${target}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw blocked("workspace-locked", "Another operation holds the workspace lock. Retry after it finishes, or remove a stale .lock file by hand.");
  }
  try {
    let before = null;
    if (create) {
      try { await stat(target); throw blocked("workspace-exists", "A workspace file already exists at this path. Choose another path or inspect it."); } catch (error) { if (error.code !== "ENOENT") throw error; }
    } else {
      const current = await readWorkspaceFile(target);
      before = current.revision;
      assert(typeof expectedRevision === "string" && /^[a-f0-9]{64}$/.test(expectedRevision), "--expected-revision must be the SHA-256 revision reported by inspect.");
      if (before !== expectedRevision || (snapshot !== null && before !== snapshot)) throw blocked("stale-revision", "The workspace changed since it was inspected. Inspect again and retry with the current revision.");
    }
    const bytes = serializeWorkspace(workspace);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { before, after: revisionOf(bytes) };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

const receipt = (operation, outcome, revision, details = {}) => ({ schema: RECEIPT_SCHEMA, operation, outcome, revision, ...details });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${randomUUID()}`;

function summarize(workspace) {
  return Object.fromEntries(COLLECTIONS.map((name) => [name, workspace[name].map((item) => ({ id: item.id, ...(item.name ? { name: item.name } : {}), ...(item.status ? { status: item.status, step: item.step, totalSteps: item.totalSteps } : {}), ...(item.sha256 ? { sha256: item.sha256 } : {}) }))]));
}

async function readInputJson(path, label, limit = MAX_INPUT_BYTES) {
  assert(typeof path === "string" && path.trim(), `--file must name the ${label}.`);
  const bytes = await boundedRead(resolve(path), limit);
  return { value: parseJson(bytes, label), sha256: sha256(bytes), bytes: bytes.length };
}

async function exclusiveWrite(path, content) {
  assert(typeof path === "string" && path.trim(), "--out must name a new file.");
  await writeFile(resolve(path), content, { flag: "wx", mode: 0o600 });
}

// Loopback-only GET lookups. The capability token in the response is dropped before anything is returned or written.
async function lookupManaged(server, runId) {
  let url;
  try { url = new URL(server); } catch { throw new OperationError("invalid-server", "--server must be a loopback URL such as http://127.0.0.1:3000."); }
  assert(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/" && !url.search, "--server must be a loopback URL such as http://127.0.0.1:3000.");
  // Returns undefined for transport failures (unreachable, redirect, non-JSON) so callers can tell "no answer" from "answered null".
  const get = async (pathname) => {
    let response;
    try {
      response = await fetch(new URL(pathname, url), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(35000) });
    } catch { return undefined; }
    const body = await response.text();
    assert(body.length <= MAX_INPUT_BYTES, "The local server response is too large.");
    if (!response.headers.get("content-type")?.includes("application/json")) return undefined;
    const value = parseJson(Buffer.from(body), "Local server response");
    if (!response.ok) throw new OperationError("server-error", typeof value?.error === "string" ? value.error.slice(0, 500) : `Local server request failed (${response.status}).`);
    return value;
  };
  const capability = await get("/api/training/capabilities");
  if (capability === undefined || capability === null) return { capability: null };
  const { token, ...safe } = capability;
  const lookup = await get(`/api/training/runs/${runId}`);
  if (lookup === undefined) return { capability: safe };
  return { capability: safe, job: lookup?.job ?? null };
}

export async function runOperation(name, options = {}) {
  const operation = OPERATIONS[name];
  if (!operation) throw new OperationError("unknown-operation", "Unknown operation. Run catalog for the supported list.");
  if (name === "catalog") return catalog();
  const path = options.workspace;
  assert(typeof path === "string" && path.trim(), "--workspace must name the private workspace file.");

  if (name === "init") {
    const workspace = createWorkspace();
    if (options.name !== undefined) workspace.name = options.name;
    await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    const revision = await writeWorkspaceFile(path, workspace, null, { create: true });
    return receipt(name, "changed", revision, { workspace: summarize(validateWorkspace(workspace)) });
  }

  const { workspace, revision } = await readWorkspaceFile(path);
  const expected = options["expected-revision"];
  if (operation.mutates) {
    assert(typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected), "--expected-revision must be the SHA-256 revision reported by inspect.");
    // Reject stale expectations before reading inputs, and pin the commit to the snapshot this operation was computed from.
    if (expected !== revision) throw blocked("stale-revision", "The workspace changed since it was inspected. Inspect again and retry with the current revision.");
  }
  const commit = async (next, details) => {
    const written = await writeWorkspaceFile(path, next, expected, { snapshot: revision });
    return receipt(name, "changed", written, details);
  };
  const unchanged = (details) => receipt(name, "unchanged", { before: revision, after: revision }, details);

  if (name === "inspect") {
    if (options.record !== undefined) {
      for (const collection of COLLECTIONS) {
        const record = workspace[collection].find((item) => item.id === options.record);
        if (record) return receipt(name, "unchanged", { before: revision, after: revision }, { collection, record });
      }
      throw blocked("record-missing", "No record with that ID exists in this workspace.");
    }
    return unchanged({ name: workspace.name, workspace: summarize(workspace) });
  }

  if (name === "export-recipe") {
    const run = workspace.runs.find((item) => item.id === options.run);
    if (!run) throw blocked("record-missing", "No run with that ID exists in this workspace.");
    const recipe = exportRecipe(run, workspace);
    if (options.out) await exclusiveWrite(options.out, `${JSON.stringify(recipe, null, 2)}\n`);
    return recipe;
  }

  if (name === "export-backup") {
    await exclusiveWrite(options.out, exportWorkspaceBackup(workspace, now()));
    return unchanged({ out: resolve(options.out), backupSchema: "mamase.workspace-backup.v1" });
  }

  if (name === "add-dataset") {
    assert(typeof options.file === "string" && options.file.trim(), "--file must name the JSONL dataset. Bytes are read only from this explicitly selected file.");
    const bytes = await boundedRead(resolve(options.file), MAX_IMPORT_BYTES);
    const digest = sha256(bytes);
    const parsed = parseDataset(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    const holdout = Number(options.holdout);
    const input = {
      id: options.id ?? newId("dataset"), name: options.name, filename: basename(options.file), records: parsed.records, bytes: bytes.length,
      format: parsed.format, kind: options.kind, teacher: options.teacher ?? "", provenance: options.provenance, holdout, sha256: digest, createdAt: now(),
    };
    const existing = workspace.datasets.find((item) => item.sha256 === digest || item.id === input.id);
    if (existing) {
      // Replays are identified by bytes and declared metadata; the original filename and registration time are kept.
      const candidate = validateDataset({ ...input, id: existing.id, filename: existing.filename, createdAt: existing.createdAt });
      if (options.id !== undefined && existing.id !== options.id) throw Object.assign(blocked("dataset-conflict", "This exact dataset is already registered under a different ID."), { details: { dataset: existing.id } });
      if (existing.sha256 === digest && same(existing, candidate)) return unchanged({ dataset: existing.id, duplicate: "identical dataset already registered" });
      throw blocked("dataset-conflict", existing.sha256 === digest ? "This exact dataset is already registered with different metadata. Existing evidence will not be overwritten." : "A dataset with this ID already exists with different contents.");
    }
    const dataset = validateDataset(input);
    return commit({ ...workspace, datasets: [...workspace.datasets, dataset] }, { dataset: dataset.id, records: dataset.records, format: dataset.format, sha256: dataset.sha256 });
  }

  if (name === "create-recipe") {
    const { value } = await readInputJson(options.input, "recipe input");
    assert(value && typeof value === "object" && !Array.isArray(value) && value.recipe && typeof value.recipe === "object", "Recipe input must be an object with name and recipe fields.");
    const id = value.id ?? newId("run");
    const createdAt = now();
    const run = createRun({ id, name: value.name, recipe: value.recipe, createdAt }, workspace);
    const existing = workspace.runs.find((item) => item.id === id);
    if (existing) {
      const plan = (item) => ({ id: item.id, name: item.name, recipe: item.recipe, totalSteps: item.totalSteps, localJobId: item.localJobId });
      if (same(plan(existing), plan(run))) return unchanged({ run: existing.id, status: existing.status, duplicate: "identical planned run already exists" });
      throw blocked("run-conflict", "A run with this ID already exists with different contents. Existing evidence will not be overwritten.");
    }
    return commit({ ...workspace, runs: [...workspace.runs, run] }, { run: run.id, status: run.status, totalSteps: run.totalSteps });
  }

  if (name === "import-progress") {
    const { value: report } = await readInputJson(options.file, "progress report", 4 * 1024 * 1024);
    const run = workspace.runs.find((item) => item.id === report?.runId);
    if (!run) throw blocked("record-missing", "Progress report must reference an existing run.");
    const preview = previewProgressReport(run, report);
    const counts = { additions: preview.additions.length, duplicates: preview.duplicates.length, conflicts: preview.conflicts.length };
    if (preview.conflicts.length) throw Object.assign(blocked("progress-conflict", "Progress observations conflict with the recorded journal. Existing evidence will not be overwritten."), { details: { run: run.id, ...counts, conflicts: preview.conflicts.map(({ index, message }) => ({ observation: index + 1, message })) } });
    if (!preview.additions.length) return unchanged({ run: run.id, ...counts, duplicate: "all observations already recorded" });
    return commit({ ...workspace, runs: workspace.runs.map((item) => item.id === run.id ? preview.run : item) }, { run: run.id, ...counts, status: preview.run.status, step: preview.run.step });
  }

  if (name === "import-result" || name === "import-evaluation") {
    const { value: report, sha256: digest } = await readInputJson(options.file, name === "import-result" ? "training result" : "evaluation report", 4 * 1024 * 1024);
    const collection = name === "import-result" ? "artifacts" : "evaluations";
    const existing = workspace[collection].find((item) => (name === "import-result" ? item.lineage?.resultSha256 : item.comparison?.reportSha256) === digest);
    if (existing) return unchanged({ [collection.slice(0, -1)]: existing.id, sha256: digest, duplicate: "this file is already imported" });
    const metadata = { id: options.id ?? newId(name === "import-result" ? "artifact" : "evaluation"), sha256: digest, createdAt: now() };
    if (workspace[collection].some((item) => item.id === metadata.id)) throw blocked("record-conflict", "A record with this ID already exists with different contents.");
    const next = name === "import-result" ? importTrainingResult(workspace, report, metadata) : importEvaluationReport(workspace, report, metadata);
    return commit(next, { [collection.slice(0, -1)]: metadata.id, sha256: digest });
  }

  if (name === "receipt") {
    const run = workspace.runs.find((item) => item.id === options.run);
    if (!run) throw blocked("record-missing", "No run with that ID exists in this workspace.");
    const context = { revision };
    if (options.bundle !== undefined) {
      assert(typeof options.bundle === "string" && options.bundle.trim(), "--bundle must name the prepared bundle directory.");
      try {
        const bytes = await boundedRead(resolve(options.bundle, "bundle.json"), MAX_INPUT_BYTES);
        context.bundle = { ...parseJson(bytes, "bundle.json"), sha256: sha256(bytes) };
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        context.bundle = null;
      }
    }
    if (options.server !== undefined) Object.assign(context, await lookupManaged(options.server, run.id));
    const result = workflowReceipt(workspace, run, context);
    if (options.out) await exclusiveWrite(options.out, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  if (name === "import-job") {
    const { value } = await readInputJson(options.file, "job record", 4 * 1024 * 1024);
    const job = value?.job ?? value;
    assert(job && typeof job === "object" && typeof job.id === "string" && job.run && typeof job.run === "object", "Expected a managed job record with id and run.");
    if (["starting", "running", "cancelling"].includes(job.status)) throw blocked("job-active", "The job is still active. Reconcile after it finishes; nothing is cancelled or relaunched here.");
    if (!workspace.runs.some((run) => run.id === job.run.id)) throw blocked("record-missing", "The job's run is not in this workspace.");
    let next;
    try { next = mergeTrainingJob(workspace, job); } catch (error) {
      if (error instanceof OperationError) throw error;
      throw blocked("job-conflict", `The job record does not fit the recorded run. ${error instanceof Error ? error.message : ""}`.trim());
    }
    const details = { run: job.run.id, job: job.id, status: job.status, ...(job.artifact ? { artifact: `artifact-${job.id}` } : {}) };
    if (same(next, workspace)) return unchanged({ ...details, duplicate: "the job record is already reflected in this workspace" });
    return commit(next, details);
  }

  if (name === "import-backup") {
    assert(typeof options.file === "string" && options.file.trim(), "--file must name the backup to restore.");
    const bytes = await boundedRead(resolve(options.file), MAX_BACKUP_BYTES);
    const backup = parseWorkspaceBackup(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (same(backup.workspace, workspace)) return unchanged({ format: backup.format, duplicate: "the backup matches the current workspace" });
    return commit(backup.workspace, { format: backup.format, migration: backup.migration, workspace: summarize(backup.workspace) });
  }
  throw new OperationError("unknown-operation", "Unknown operation.");
}

const usage = `Usage: npm run ops -- <operation> [--workspace file.json] [--expected-revision sha256] [options]
Operations: ${Object.keys(OPERATIONS).join(", ")}
Run catalog for the versioned contract. Output is always one JSON document. Exit 0 = changed/unchanged, 2 = blocked, 1 = failed.
Nothing here starts training, reads browser storage, or synchronizes with the UI; hand off through export-backup / import-backup.`;

export async function main(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv, allowPositionals: true,
      options: {
        workspace: { type: "string" }, "expected-revision": { type: "string" }, file: { type: "string" }, input: { type: "string" },
        out: { type: "string" }, run: { type: "string" }, record: { type: "string" }, id: { type: "string" }, name: { type: "string" },
        kind: { type: "string" }, holdout: { type: "string" }, provenance: { type: "string" }, teacher: { type: "string" }, help: { type: "boolean" },
      bundle: { type: "string" }, server: { type: "string" },
      },
    }));
  } catch (error) {
    if (!error.code?.startsWith("ERR_PARSE_ARGS")) throw error;
    console.log(JSON.stringify(receipt(argv.find((value) => !value.startsWith("--")) ?? null, "failed", null, { error: { code: "invalid-arguments", message: "Unrecognized or malformed command-line option. Run --help for usage." } }), null, 2));
    return 1;
  }
  if (values.help || positionals.length !== 1) {
    console.log(usage);
    return values.help ? 0 : 1;
  }
  try {
    const result = await runOperation(positionals[0], values);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    const outcome = error instanceof OperationError ? error.outcome : "failed";
    const code = error instanceof OperationError ? error.code : error instanceof SyntaxError ? "invalid-json" : "validation";
    console.log(JSON.stringify(receipt(positionals[0], outcome, null, { error: { code, message: error.message }, ...(error.details ? { details: error.details } : {}) }), null, 2));
    return outcome === "blocked" ? 2 : 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
