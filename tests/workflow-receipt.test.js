import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyCapability, detectLane, workflowReceipt, WORKFLOW_RECEIPT_SCHEMA, HANDOFF } from "../workflow-receipt.mjs";
import { createWorkspace, createRun, recordProgress, importTrainingResult, importEvaluationReport, validateWorkspace } from "../workspace.js";
import { trainingIdentity } from "../training-state.js";
import { prepareReview, recordHumanDecision } from "../human-review.js";
import { runOperation } from "../ops.mjs";
import { sha256 } from "../familiar-context.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (letter) => letter.repeat(64);
const at = (minutes) => new Date(Date.parse("2026-09-14T12:00:00.000Z") + minutes * 60_000).toISOString();
const recipe = {
  method: "lora", programId: "coven", datasetId: "dataset-1", student: "local-fixture", teacher: "", adapter: "lora", familiarId: "cody", instanceId: "test-coven",
  rank: 4, alpha: 8, learningRate: 0.001, epochs: 1, batchSize: 1, accumulation: 4, maxSequence: 512, outputPath: "./outputs/hint-only", objective: "Exercise receipts, not model quality.",
};

function fixture(overrides = {}) {
  const workspace = createWorkspace();
  workspace.datasets.push({ id: "dataset-1", name: "Synthetic", filename: "examples.jsonl", records: 10, bytes: 1000, format: "prompt-response", kind: "supervised", teacher: "", provenance: "Synthetic fixture.", holdout: 20, sha256: hash("a"), createdAt: at(0) });
  const run = createRun({ id: "run-1", name: "Receipt fixture", createdAt: at(0), recipe: { ...recipe, ...overrides } }, workspace);
  workspace.runs.push(run);
  return { workspace, run };
}
const bundleFor = (run, extra = {}) => ({ schema: "mamase.local-bundle.v1", runId: run.id, recipe: run.recipe, dataset: { sha256: hash("a") }, split: { train: 8, holdout: 2 }, execution: "not-started", promotion: "not-authorized", sha256: hash("b"), ...extra });
const result = (bundleSha256 = hash("b")) => ({
  schema: "mamase.training-result.v1", runId: "run-1", bundleSha256, familiar: { familiarId: "cody", instanceId: "test-coven" },
  baseModel: { label: "local-fixture", localPath: "/local/model", files: { "model.safetensors": hash("d") } },
  adapter: { path: "/private/bundle/adapter", technique: "lora", files: { "adapter_model.safetensors": hash("f"), "adapter_config.json": hash("a") } },
  datasetSha256: hash("a"), holdoutSha256: hash("d"), optimizerSteps: 2,
  evaluation: { metric: "completion-token-weighted-negative-log-likelihood", samples: 2, baseLoss: 2, adapterLoss: 1.5, delta: -0.5 },
  trainableParameters: 100, totalParameters: 1000, promotion: "not-authorized",
});
const report = (resultSha256) => ({
  schema: "mamase.evaluation-report.v1", runId: "run-1", createdAt: at(5), resultSha256, bundleSha256: hash("b"), datasetSha256: hash("a"),
  familiar: { familiarId: "cody", instanceId: "test-coven" }, adapterPath: "/private/bundle/adapter",
  suite: { name: "Synthetic regressions", version: "1", sha256: hash("f") }, decoding: { doSample: false, numBeams: 1, maxNewTokens: 16, seed: 42 }, device: "cpu", promotion: "not-authorized",
  cases: [
    { id: "task-1", category: "task", prompt: "private task", checks: [{ type: "equals", value: "pass" }], base: { response: "pass", passed: true }, adapter: { response: "pass", passed: true } },
    { id: "identity-1", category: "identity", prompt: "private identity", checks: [{ type: "contains", value: "Cody" }], base: { response: "unknown", passed: false }, adapter: { response: "I am Cody", passed: true } },
    { id: "consent-1", category: "consent", prompt: "private consent", checks: [{ type: "not_contains", value: "forbidden" }], base: { response: "ok", passed: true }, adapter: { response: "ok", passed: true } },
    { id: "tool-1", category: "tool-boundary", prompt: "private tool", checks: [{ type: "equals", value: "approval" }], base: { response: "no", passed: false }, adapter: { response: "approval", passed: true } },
  ],
  summary: { samples: 4, basePassed: 2, adapterPassed: 4, regressions: 0 },
});
const completeRun = (run) => recordProgress(recordProgress(run, { status: "running", step: 0, totalSteps: 2, loss: null, evalLoss: 2, note: "", recordedAt: at(1) }), { status: "completed", step: 2, totalSteps: 2, loss: 1, evalLoss: 1.5, note: "", recordedAt: at(2) });
const states = (receipt) => Object.fromEntries(receipt.steps.map((step) => [step.id, step.state]));
const codes = (receipt) => receipt.blockers.map((blocker) => blocker.code);

test("lane detection and capability classification are explicit", () => {
  assert.equal(detectLane(fixture().run).lane, "peft");
  assert.equal(detectLane(fixture({ workflow: "cli" }).run).lane, "peft");
  assert.equal(detectLane(fixture({ familiarId: "", instanceId: "", workflow: "managed" }).run).lane, "managed-mlx");
  assert.equal(detectLane(fixture({ familiarId: "", instanceId: "" }).run).lane, "unselected");
  assert.equal(classifyCapability(undefined).state, "unknown");
  assert.equal(classifyCapability(null).state, "unreachable");
  assert.equal(classifyCapability({ hosted: true, enabled: false, available: false }).state, "unsupported");
  assert.equal(classifyCapability({ enabled: false, available: false }).state, "disabled");
  assert.equal(classifyCapability({ enabled: true, available: false, message: "Install mlx" }).state, "unavailable");
  assert.equal(classifyCapability({ enabled: true, available: true, busy: true }).state, "busy");
  const available = classifyCapability({ enabled: true, available: true, busy: false, token: "a".repeat(64) });
  assert.equal(available.state, "available");
  assert.ok(!("token" in available));
  assert.match(available.message, /not proof/);
});

test("PEFT receipts move from plan to human handoff only on recorded evidence", async () => {
  let { workspace, run } = fixture();
  const planOnly = workflowReceipt(workspace, run, { revision: hash("9") });
  assert.equal(planOnly.schema, WORKFLOW_RECEIPT_SCHEMA);
  assert.deepEqual([planOnly.lane, planOnly.state, planOnly.nextAction.step, planOnly.nextAction.requiresApproval], ["peft", "planned", "prepare", false]);
  assert.equal(planOnly.familiarContext.scope, "unprepared");
  assert.equal(planOnly.workspace.revision, hash("9"));
  assert.equal(planOnly.handoff, HANDOFF);

  const missing = workflowReceipt(workspace, run, { bundle: null });
  assert.deepEqual([missing.state, codes(missing), missing.nextAction], ["blocked", ["bundle-missing"], null]);

  const prepared = workflowReceipt(workspace, run, { bundle: bundleFor(run) });
  assert.deepEqual([prepared.state, prepared.nextAction.step, prepared.familiarContext.scope, prepared.fingerprints.bundle], ["prepared", "preflight", "identity-files-only", hash("b")]);
  assert.match(prepared.nextAction.command, /preflight\.py/);
  const selected = workflowReceipt(workspace, run, { bundle: bundleFor(run, { schema: "mamase.local-bundle.v2", familiarContext: { sha256: hash("c") } }) });
  assert.deepEqual(selected.familiarContext, { scope: "selected-sources", sha256: hash("c") });

  const changedInput = workflowReceipt(workspace, run, { bundle: bundleFor(run, { dataset: { sha256: hash("e") } }) });
  assert.deepEqual([changedInput.state, codes(changedInput), states(changedInput).prepare], ["blocked", ["source-changed"], "blocked"]);
  const changedRecipe = workflowReceipt(workspace, run, { bundle: bundleFor(run, { recipe: { ...run.recipe, rank: 8 } }) });
  assert.deepEqual(codes(changedRecipe), ["recipe-changed"]);
  assert.deepEqual(codes(workflowReceipt(workspace, run, { bundle: bundleFor(run, { runId: "run-2" }) })), ["bundle-run-mismatch"]);
  assert.throws(() => workflowReceipt(workspace, run, { capability: { enabled: true, available: true } }), /managed MLX lane only/);

  workspace = validateWorkspace({ ...workspace, runs: [completeRun(run)] });
  run = workspace.runs[0];
  const trainedOnly = workflowReceipt(workspace, run, { bundle: bundleFor(run) });
  assert.equal(trainedOnly.state, "prepared", "a completed journal without an imported result is not trained evidence");
  const resultMetadata = { id: "artifact-1", sha256: hash("1"), createdAt: at(3) };
  workspace = importTrainingResult(workspace, result(), resultMetadata);
  const trained = workflowReceipt(workspace, run, { bundle: bundleFor(run) });
  assert.deepEqual([trained.state, trained.nextAction.step, trained.fingerprints.results], ["trained", "evaluate", [hash("1")]]);
  assert.equal(states(trained).train, "done");
  assert.equal(trained.steps.find((step) => step.id === "train").evidence[0].context, "identity-files-only");
  const otherBundle = workflowReceipt(workspace, run, { bundle: bundleFor(run, { sha256: hash("7") }) });
  assert.deepEqual(codes(otherBundle), ["bundle-changed"]);

  workspace = importEvaluationReport(workspace, report(hash("1")), { id: "evaluation-1", sha256: hash("2"), createdAt: at(6) });
  const evaluated = workflowReceipt(workspace, run, { bundle: bundleFor(run) });
  assert.deepEqual([evaluated.state, evaluated.nextAction.step, evaluated.nextAction.requiresApproval, evaluated.fingerprints.reports], ["awaiting-human-review", "human-review", true, [hash("2")]]);
  assert.ok(!JSON.stringify(evaluated).includes("I am Cody"), "receipts carry fingerprints, not case content");

  const reportBytes = Buffer.from(JSON.stringify(report(hash("1"))));
  workspace = importEvaluationReport(validateWorkspace({ ...workspace, evaluations: [] }), report(hash("1")), { id: "evaluation-1", sha256: sha256(reportBytes), createdAt: at(6) });
  const review = await prepareReview(workspace, "evaluation-1", report(hash("1")), sha256(reportBytes));
  const unknown = { taskState: "unknown", responseJudgment: "unknown", executionEvidence: "unknown", receiptAdequacy: "not-applicable" };
  workspace = validateWorkspace(recordHumanDecision(workspace, review, {
    id: "review-1", recordedAt: at(7), reviewer: "Synthetic operator", decision: "needs-more-evidence", rationale: "Synthetic evidence only.", limitations: "Not candidate quality.",
    annotations: review.cases.map((item) => ({ caseId: item.id, caseSha256: item.sha256, base: unknown, adapter: unknown })),
  }));
  const reviewed = workflowReceipt(workspace, run, { bundle: bundleFor(run) });
  assert.deepEqual([reviewed.state, reviewed.nextAction, reviewed.attempt], ["evidence-ready", null, { observations: 2, artifacts: 1, evaluations: 1 }]);
});

test("managed MLX receipts stay honest about runtimes, lost responses and interrupted jobs", () => {
  const { workspace, run } = fixture({ familiarId: "", instanceId: "", workflow: "managed" });
  const unknown = workflowReceipt(workspace, run);
  assert.deepEqual([unknown.lane, unknown.state, unknown.nextAction.step, unknown.familiarContext.scope], ["managed-mlx", "planned", "capability", "not-applicable"]);
  assert.equal(workflowReceipt(workspace, run, { capability: null }).runtime.state, "unreachable");
  assert.deepEqual(codes(workflowReceipt(workspace, run, { capability: { hosted: true, enabled: false, available: false } })), ["hosted-disabled"]);
  assert.deepEqual(codes(workflowReceipt(workspace, run, { capability: { enabled: false, available: false } })), ["runtime-disabled"]);
  assert.deepEqual(codes(workflowReceipt(workspace, run, { capability: { enabled: true, available: false } })), ["runtime-unavailable"]);
  const busy = workflowReceipt(workspace, run, { capability: { enabled: true, available: true, busy: true } });
  assert.deepEqual([busy.state, busy.nextAction, states(busy).launch], ["planned", null, "pending"]);
  const ready = workflowReceipt(workspace, run, { capability: { enabled: true, available: true, busy: false, token: hash("f") }, job: null });
  assert.deepEqual([ready.nextAction.step, ready.nextAction.requiresApproval], ["launch", true]);
  assert.ok(!JSON.stringify(ready).includes(hash("f")), "tokens never enter receipts");
  assert.throws(() => workflowReceipt(workspace, run, { bundle: bundleFor(run) }), /PEFT lane only/);

  const jobId = "job-00000000-0000-4000-8000-000000000001";
  const launched = validateWorkspace({ ...workspace, runs: [{ ...run, localJobId: jobId }] });
  const lost = workflowReceipt(launched, launched.runs[0], { capability: null, job: null });
  assert.deepEqual([lost.state, lost.nextAction.step, states(lost).launch], ["training", "job", "done"]);
  assert.match(lost.steps.find((step) => step.id === "job").evidence.note, /never relaunch/);
  const missing = workflowReceipt(launched, launched.runs[0], { capability: { enabled: true, available: true, busy: false }, job: null });
  assert.deepEqual([missing.state, codes(missing)], ["blocked", ["job-missing"]]);
  const running = { id: jobId, status: "running", run: { ...launched.runs[0], status: "running", step: 1, totalSteps: 2 } };
  const active = workflowReceipt(launched, launched.runs[0], { capability: { enabled: true, available: true, busy: true }, job: running });
  assert.deepEqual([active.state, active.nextAction.step], ["training", "job"]);
  const interrupted = workflowReceipt(launched, launched.runs[0], { capability: { enabled: true, available: true, busy: false }, job: { ...running, status: "failed", run: { ...running.run, status: "failed" } } });
  assert.deepEqual([interrupted.state, codes(interrupted), interrupted.nextAction], ["blocked", ["job-failed"], null]);
  assert.match(interrupted.blockers[0].message, /does not resume/);
  assert.deepEqual(codes(workflowReceipt(launched, launched.runs[0], { job: { ...running, status: "cancelled" } })), ["job-cancelled"]);
  assert.deepEqual(codes(workflowReceipt(launched, launched.runs[0], { job: { ...running, id: "job-00000000-0000-4000-8000-000000000002" } })), ["job-mismatch"]);
  assert.throws(() => workflowReceipt(launched, launched.runs[0], { job: { ...running, run: { id: "run-9" } } }), /does not belong/);
  const completed = workflowReceipt(launched, launched.runs[0], { job: { ...running, status: "completed", run: { ...running.run, status: "completed", step: 2 } } });
  assert.deepEqual([completed.state, completed.nextAction.step], ["trained", "register"]);
  const failedRun = validateWorkspace({ ...launched, runs: [recordProgress(recordProgress(launched.runs[0], { status: "running", step: 0, totalSteps: 2, loss: null, evalLoss: null, note: "", recordedAt: at(1) }), { status: "failed", step: 1, totalSteps: 2, loss: null, evalLoss: null, note: "interrupted", recordedAt: at(2) })] });
  const recordedFailure = workflowReceipt(failedRun, failedRun.runs[0]);
  assert.deepEqual([recordedFailure.state, codes(recordedFailure)], ["failed", ["job-failed"]]);
});

test("receipt and import-job operations recover finished managed jobs through the existing guards", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mamase-receipt-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspacePath = join(directory, "workspace.json");
  const { workspace, run } = fixture({ familiarId: "", instanceId: "", workflow: "managed" });
  const jobId = "job-00000000-0000-4000-8000-000000000001";
  const dataset = workspace.datasets[0];
  const managedRun = recordProgress(recordProgress({ ...run, localJobId: jobId }, { status: "running", step: 0, totalSteps: 2, loss: null, evalLoss: null, note: "Starting.", recordedAt: at(1) }), { status: "completed", step: 2, totalSteps: 2, loss: null, evalLoss: null, note: "Finalized.", recordedAt: at(2) });
  const job = { id: jobId, status: "completed", identity: trainingIdentity(run, dataset), run: managedRun, dataset, artifact: { id: `artifact-${jobId}`, runId: run.id, name: "Managed adapter", kind: "adapter", path: "/private/.mamase/training/job/adapter", notes: "", createdAt: at(2) } };
  const state = { capability: { enabled: true, available: true, busy: false, backend: "mlx-lm", token: hash("f") }, job: null, hosted: false };
  const server = createServer((request, response) => {
    const json = (value, code = 200) => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.url === "/api/training/capabilities") return json(state.hosted ? { hosted: true, enabled: false, available: false, message: "Hosted." } : state.capability);
    if (request.url === `/api/training/runs/${run.id}`) return json({ job: state.job });
    json({ error: "Local job endpoint not found." }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((done) => server.close(done)));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;

  await writeFile(workspacePath, JSON.stringify({ schema: "mamase.workspace-file.v1", workspace }));
  let revision = (await runOperation("inspect", { workspace: workspacePath })).revision.after;
  const catalog = await runOperation("catalog");
  assert.equal(catalog.workflowReceiptSchema, WORKFLOW_RECEIPT_SCHEMA);
  assert.ok(catalog.operations.some((operation) => operation.name === "receipt" && operation.mutates === false));

  const offline = await runOperation("receipt", { workspace: workspacePath, run: run.id });
  assert.deepEqual([offline.state, offline.runtime.state, offline.workspace.revision], ["planned", "unknown", revision]);
  const ready = await runOperation("receipt", { workspace: workspacePath, run: run.id, server: serverUrl, out: join(directory, "receipt.json") });
  assert.deepEqual([ready.runtime.state, ready.nextAction.step, ready.nextAction.requiresApproval], ["available", "launch", true]);
  assert.ok(!(await readFile(join(directory, "receipt.json"), "utf8")).includes(hash("f")), "written receipts exclude the command token");
  state.hosted = true;
  assert.deepEqual((await runOperation("receipt", { workspace: workspacePath, run: run.id, server: serverUrl })).blockers.map((blocker) => blocker.code), ["hosted-disabled"]);
  state.hosted = false;
  await assert.rejects(runOperation("receipt", { workspace: workspacePath, run: run.id, server: "http://example.com" }), /loopback/);
  await assert.rejects(runOperation("receipt", { workspace: workspacePath, run: run.id, server: "not a url" }), /loopback/);
  const unreachable = await runOperation("receipt", { workspace: workspacePath, run: run.id, server: "http://127.0.0.1:9" });
  assert.equal(unreachable.runtime.state, "unreachable");

  state.job = job;
  const lostResponse = await runOperation("receipt", { workspace: workspacePath, run: run.id, server: serverUrl });
  assert.deepEqual([lostResponse.state, lostResponse.nextAction.step, lostResponse.fingerprints.job], ["trained", "register", jobId]);
  assert.equal(lostResponse.steps.find((step) => step.id === "launch").evidence.recordedInWorkspace, false);

  const jobPath = join(directory, "job.json");
  await writeFile(jobPath, JSON.stringify({ job: { ...job, status: "running" } }));
  await assert.rejects(runOperation("import-job", { workspace: workspacePath, "expected-revision": revision, file: jobPath }), /still active/);
  await writeFile(jobPath, JSON.stringify({ job }));
  const imported = await runOperation("import-job", { workspace: workspacePath, "expected-revision": revision, file: jobPath });
  assert.deepEqual([imported.outcome, imported.run, imported.job, imported.artifact], ["changed", run.id, jobId, `artifact-${jobId}`]);
  revision = imported.revision.after;
  const replay = await runOperation("import-job", { workspace: workspacePath, "expected-revision": revision, file: jobPath });
  assert.equal(replay.outcome, "unchanged");
  await writeFile(jobPath, JSON.stringify({ job: { ...job, id: "job-00000000-0000-4000-8000-000000000002", run: { ...managedRun, localJobId: "job-00000000-0000-4000-8000-000000000002" } } }));
  await assert.rejects(runOperation("import-job", { workspace: workspacePath, "expected-revision": revision, file: jobPath }), /another local job/);

  const registered = await runOperation("receipt", { workspace: workspacePath, run: run.id, server: serverUrl });
  assert.deepEqual([registered.state, registered.run.localJobId, registered.nextAction.step], ["trained", jobId, "test"]);
  assert.equal(registered.steps.find((step) => step.id === "register").evidence.artifactId, `artifact-${jobId}`);
  assert.equal(registered.steps.find((step) => step.id === "human-review").state, "pending");

  const bundleDir = join(directory, "bundle");
  await mkdir(bundleDir);
  const peft = fixture();
  const peftPath = join(directory, "peft.json");
  await writeFile(peftPath, JSON.stringify({ schema: "mamase.workspace-file.v1", workspace: peft.workspace }));
  const unprepared = await runOperation("receipt", { workspace: peftPath, run: "run-1", bundle: bundleDir });
  assert.deepEqual(unprepared.blockers.map((blocker) => blocker.code), ["bundle-missing"]);
  await writeFile(join(bundleDir, "bundle.json"), JSON.stringify({ ...bundleFor(peft.run), sha256: undefined }));
  const prepared = await runOperation("receipt", { workspace: peftPath, run: "run-1", bundle: bundleDir });
  assert.deepEqual([prepared.state, prepared.fingerprints.bundle], ["prepared", sha256(await readFile(join(bundleDir, "bundle.json")))]);
  const cli = spawnSync(process.execPath, [join(root, "ops.mjs"), "receipt", "--workspace", peftPath, "--run", "run-1", "--bundle", bundleDir], { encoding: "utf8" });
  assert.equal(cli.status, 0);
  assert.equal(JSON.parse(cli.stdout).schema, WORKFLOW_RECEIPT_SCHEMA);
});
