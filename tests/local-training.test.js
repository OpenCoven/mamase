import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { LocalTrainer } from "../local-training.mjs";
import { createAppServer } from "../server.mjs";
import { createWorkspace, createRun, validateWorkspace } from "../workspace.js";

async function setup(context, name = "success") {
  const root = await mkdtemp(join(tmpdir(), "mamase-training-test-"));
  const model = join(root, "model");
  await mkdir(model);
  const source = Buffer.from('{"prompt":"one","response":"two"}\n{"prompt":"three","response":"four"}\n{"prompt":"five","response":"six"}');
  const workspace = createWorkspace();
  const createdAt = new Date().toISOString();
  workspace.datasets.push({ id: "data", name: "Examples", filename: "examples.jsonl", bytes: source.length, records: 3, format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original", holdout: 20, sha256: createHash("sha256").update(source).digest("hex"), createdAt });
  workspace.runs.push(createRun({ id: "test-run", name, createdAt, recipe: { method: "lora", programId: "coven", datasetId: "data", student: model, teacher: "", rank: 4, alpha: 8, learningRate: .001, epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 128, outputPath: "./never-overwrite", objective: "Exercise the lifecycle." } }, workspace));
  const options = { root: join(root, "jobs"), python: process.env.MAMASE_TEST_PYTHON || "python3", runner: resolve("tests/fixtures/training-worker.py"), probeArgs: ["-c", "print('Protocol fixture ready')"] };
  const trainer = new LocalTrainer(options);
  context.after(async () => { await trainer.close(); await rm(root, { recursive: true, force: true }); });
  return { root, options, trainer, payload: { workspace, datasetBase64: source.toString("base64"), confirmManagedOutput: true } };
}

async function settled(trainer, id) {
  const context = trainer.processes.get(id);
  if (context) await context.closed;
  return trainer.get(id);
}

test("job lifecycle validates content, streams observations and registers output after exit", async (context) => {
  const { trainer, payload } = await setup(context);
  const events = [];
  trainer.on("update", (_id, event) => events.push(event.type));
  const job = await trainer.launch(payload);
  assert.equal(job.artifact, null);
  const finished = await settled(trainer, job.id);
  assert.equal(finished.status, "completed");
  assert.equal(finished.run.step, finished.run.totalSteps);
  assert.ok(events.includes("progress"));
  assert.equal(finished.artifact.path, finished.outputPath);
  assert.ok((await readFile(join(finished.outputPath, "adapters.safetensors"))).length);
  const stored = JSON.parse(await readFile(join(trainer.root, job.id, "state.json")));
  assert.equal(stored.status, "completed");
  assert.equal(validateWorkspace({ ...payload.workspace, runs: [stored.run], artifacts: [stored.artifact] }).runs[0].localJobId, job.id);
  await assert.rejects(trainer.launch(payload), /already has a managed job/);
});

test("wrong datasets and missing local models never launch a process", async (context) => {
  const { trainer, payload } = await setup(context);
  await assert.rejects(trainer.launch({ ...payload, datasetBase64: Buffer.from("different").toString("base64") }), /does not match/);
  await assert.rejects(trainer.launch({ ...payload, confirmManagedOutput: false }), /Confirm/);
  payload.workspace.runs[0].recipe.student = "./a-model-that-does-not-exist";
  await assert.rejects(trainer.launch(payload), /existing local MLX model/);
  assert.equal(trainer.jobs.size, 0);
  assert.equal(trainer.processes.size, 0);
});

test("missing optional runtime is explicit and cannot create a pretend job", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "mamase-missing-runtime-"));
  const trainer = new LocalTrainer({ root: join(root, "jobs"), python: join(root, "missing-python") });
  context.after(async () => { await trainer.close(); await rm(root, { recursive: true, force: true }); });
  const status = await trainer.availability();
  assert.equal(status.available, false);
  assert.match(status.message, /unavailable/);
  await assert.rejects(trainer.launch({}), /unavailable/);
  assert.equal(trainer.jobs.size, 0);
});

for (const name of ["failure", "protocol", "missing-output"]) {
  test(`${name} cannot produce a successful job or artifact`, async (context) => {
    const { trainer, payload } = await setup(context, name);
    const job = await trainer.launch(payload);
    const finished = await settled(trainer, job.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.run.status, "failed");
    assert.equal(finished.artifact, null);
    assert.ok(finished.error);
  });
}

test("cancel terminates the owned worker and refuses concurrent launches", async (context) => {
  const { trainer, payload } = await setup(context, "cancel");
  const job = await trainer.launch(payload);
  await assert.rejects(trainer.launch(payload), /already running/);
  await trainer.cancel(job.id);
  const finished = await settled(trainer, job.id);
  assert.equal(finished.status, "cancelled");
  assert.equal(finished.artifact, null);
  assert.equal(trainer.processes.size, 0);
});

test("durable jobs reconnect after restart; interrupted records fail instead of inventing success", async (context) => {
  const { trainer, payload, options } = await setup(context);
  const job = await trainer.launch(payload);
  await settled(trainer, job.id);
  await trainer.close();
  const restored = new LocalTrainer(options);
  assert.equal((await restored.findRun("test-run")).status, "completed");
  await restored.close();
  const state = JSON.parse(await readFile(join(options.root, job.id, "state.json")));
  state.run.history.pop();
  const last = state.run.history.at(-1);
  Object.assign(state.run, { status: last.status, step: last.step, totalSteps: last.totalSteps, updatedAt: last.recordedAt });
  state.status = "running";
  state.artifact = null;
  await writeFile(join(options.root, job.id, "state.json"), JSON.stringify(state));
  const interrupted = new LocalTrainer(options);
  assert.equal((await interrupted.findRun("test-run")).status, "failed");
  assert.equal(interrupted.processes.size, 0);
  await interrupted.close();
});

test("loopback API requires matching origin and capability token for mutations", async (context) => {
  const { trainer, payload } = await setup(context);
  const server = createAppServer({ training: trainer });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => { server.closeTrainingConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const capability = await (await fetch(`${base}/api/training/capabilities`)).json();
  assert.equal(capability.available, true);
  const denied = await fetch(`${base}/api/training/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal(denied.status, 403);
  const cross = await fetch(`${base}/api/training/capabilities`, { headers: { Origin: "https://example.org" } });
  assert.equal(cross.status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/training/capabilities`, { headers: { Host: `not-local.test:${server.address().port}` } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(rebound, 403);
  const response = await fetch(`${base}/api/training/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, "X-Mamase-Token": capability.token }, body: JSON.stringify(payload) });
  assert.equal(response.status, 201);
  const { job } = await response.json();
  const streaming = await fetch(`${base}/api/training/jobs/${job.id}/events`);
  assert.match(streaming.headers.get("content-type"), /text\/event-stream/);
  const reader = streaming.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"type":"snapshot"/);
  await reader.cancel();
  await settled(trainer, job.id);
  const report = await (await fetch(`${base}/api/training/jobs/${job.id}/report`)).json();
  assert.equal(report.schema, "mamase.run-report.v1");
  assert.equal(report.updates.at(-1).status, "completed");
});
