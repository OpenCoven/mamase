import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { LocalTrainer } from "../local-training.mjs";
import { LocalInference, validateGeneration } from "../local-inference.mjs";
import { createAppServer } from "../server.mjs";
import { createWorkspace, createRun } from "../workspace.js";

const worker = resolve("tests/fixtures/inference-worker.py");
const bodyFor = (jobId) => ({ jobId, variant: "adapter", messages: [{ role: "user", content: "Hi" }], temperature: 0, maxTokens: 8, seed: 42 });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function fixture(context, mode = "success", knobs = {}) {
  const root = await mkdtemp(join(tmpdir(), "mamase-inference-test-"));
  const model = join(root, "model");
  await mkdir(model);
  await writeFile(join(model, "config.json"), JSON.stringify({ model_type: "llama", max_position_embeddings: 256 }));
  await writeFile(join(model, "tokenizer_config.json"), JSON.stringify({ chat_template: "fixture" }));
  await writeFile(join(model, "tokenizer.json"), "{}");
  await writeFile(join(model, "model.safetensors"), "Protocol fixture, not actual weights");
  await writeFile(join(model, "fixture.json"), JSON.stringify({ mode }));
  const source = Buffer.from('{"prompt":"a","response":"b"}\n{"prompt":"c","response":"d"}\n{"prompt":"e","response":"f"}\n');
  const workspace = createWorkspace();
  const createdAt = new Date().toISOString();
  workspace.datasets.push({ id: "data", name: "Examples", filename: "data.jsonl", bytes: source.length, records: 3, format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original", holdout: 20, sha256: createHash("sha256").update(source).digest("hex"), createdAt });
  workspace.runs.push(createRun({ id: "inference-run", name: "Inference fixture", createdAt, recipe: { method: "lora", programId: "coven", datasetId: "data", student: model, teacher: "", rank: 4, alpha: 8, learningRate: .001, epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 128, outputPath: "./unused", objective: "Backend protocol coverage." } }, workspace));
  const options = { root: join(root, "jobs"), python: process.env.MAMASE_TEST_PYTHON || "python3", runner: resolve("tests/fixtures/training-worker.py"), probeArgs: ["-c", "print('Protocol fixture ready')"] };
  const trainer = new LocalTrainer(options);
  const payload = { workspace, datasetBase64: source.toString("base64"), confirmManagedOutput: true };
  const job = await trainer.launch(payload);
  await trainer.processes.get(job.id).closed;
  assert.equal(job.status, "completed");
  const inference = new LocalInference(trainer, { runner: worker, killGraceMs: 100, ...knobs });
  const server = createAppServer({ training: trainer, inference });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const capability = await (await fetch(`${base}/api/training/capabilities`)).json();
  const headers = { Origin: base, "X-Mamase-Token": capability.token, "Content-Type": "application/json" };
  const post = (body = bodyFor(job.id), extra = {}) => fetch(`${base}/api/training/generate`, { method: "POST", headers, body: JSON.stringify(body), ...extra });
  context.after(async () => {
    await server.closeLocalRuntime();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  return { root, model, trainer, inference, job, payload, options, server, base, headers, post };
}

async function events(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/x-ndjson/);
  return (await response.text()).trimEnd().split("\n").map((line) => JSON.parse(line));
}

async function idle(inference) {
  await Promise.all([...inference.operations].map((operation) => operation.done));
  assert.equal(inference.operations.size, 0);
  assert.equal(inference.trainer.busy, false);
}

test("generation validation accepts only bounded text conversations and explicit controls", () => {
  const input = bodyFor("job-12345678-1234-1234-1234-123456789012");
  assert.deepEqual(validateGeneration(input), input);
  assert.notEqual(validateGeneration(input), input);
  const invalid = [
    null, [], {}, { ...input, modelPath: "/arbitrary" }, { ...input, tools: [] }, { ...input, jobId: "../bad" },
    { ...input, variant: "cloud" }, { ...input, temperature: "1" }, { ...input, temperature: NaN },
    { ...input, temperature: -1 }, { ...input, temperature: 2.1 }, { ...input, maxTokens: 0 },
    { ...input, maxTokens: 2049 }, { ...input, maxTokens: 1.5 }, { ...input, seed: -1 },
    { ...input, seed: 2 ** 32 }, { ...input, seed: 1.1 }, { ...input, messages: [] },
    { ...input, messages: [{ role: "user", content: " " }] },
    { ...input, messages: [{ role: "user", content: "\ud800" }] },
    { ...input, messages: [{ role: "user", content: [{ type: "image_url" }] }] },
    { ...input, messages: [{ role: "user", content: "Hi", name: "me" }] },
    { ...input, messages: [{ role: "system", content: "Only system" }] },
    { ...input, messages: [{ role: "assistant", content: "First" }] },
    { ...input, messages: [{ role: "user", content: "Hi" }, { role: "user", content: "Again" }] },
    { ...input, messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Last" }] },
    { ...input, messages: [{ role: "user", content: "Hi" }, { role: "system", content: "Late" }] },
    { ...input, messages: Array.from({ length: 33 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "x" })) },
    { ...input, messages: [{ role: "user", content: "x".repeat(32001) }] },
  ];
  for (const value of invalid) assert.throws(() => validateGeneration(value));
  assert.doesNotThrow(() => validateGeneration({ ...input, temperature: 2, seed: 0xffffffff, maxTokens: 2048, messages: [
    { role: "system", content: "Be brief" }, { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" }, { role: "user", content: "Next" },
  ] }));
});

test("models come from finalized durable jobs, retain missing files and survive restart", async (context) => {
  const { trainer, inference, job, model, options, base } = await fixture(context);
  const listing = await (await fetch(`${base}/api/training/models`)).json();
  assert.deepEqual(listing, { models: [{
    jobId: job.id, runId: job.run.id, artifactId: job.artifact.id, name: job.artifact.name,
    baseModel: job.modelPath, contextWindow: 256, createdAt: job.artifact.createdAt,
    available: true, message: "Ready for local text generation.",
  }], busy: false });
  await rm(join(job.outputPath, "adapters.safetensors"));
  const unavailable = (await inference.models()).models;
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].available, false);
  assert.match(unavailable[0].message, /Restore/);
  await trainer.close();
  const restored = new LocalTrainer(options);
  const second = new LocalInference(restored);
  try {
    assert.equal((await second.models()).models[0].available, false);
    assert.equal((await second.models()).models[0].artifactId, job.artifact.id);
    const restoredJob = await restored.get(job.id);
    restoredJob.status = "failed";
    assert.deepEqual((await second.models()).models, []);
    restoredJob.status = "completed";
    await writeFile(join(model, "config.json"), "{}".repeat(70000));
    assert.equal((await second.models()).models[0].available, false);
  } finally {
    await second.close();
    await restored.close();
  }
});

test("missing shards, unknown context, symlinks and invalid configs are explicit; unexpected I/O propagates", async (context) => {
  const { inference, model } = await fixture(context);
  await writeFile(join(model, "config.json"), JSON.stringify({ model_type: "llama" }));
  assert.equal((await inference.models()).models[0].contextWindow, null);
  await writeFile(join(model, "model.safetensors.index.json"), JSON.stringify({ weight_map: { layer: "model-absent.safetensors" } }));
  assert.match((await inference.models()).models[0].message, /shards/);
  await rm(join(model, "model.safetensors.index.json"));
  await rename(join(model, "tokenizer.json"), join(model, "tokenizer-backup.json"));
  assert.equal((await inference.models()).models[0].available, false);
  await symlink("tokenizer-backup.json", join(model, "tokenizer.json"));
  assert.equal((await inference.models()).models[0].available, false);
  await rm(join(model, "tokenizer.json"));
  await rename(join(model, "tokenizer-backup.json"), join(model, "tokenizer.json"));
  // A parent symlink cycle is a genuine I/O failure, not a missing-file fallback.
  const job = [...inference.trainer.jobs.values()][0];
  const originalPath = job.modelPath;
  await symlink("cycle/nested", join(model, "cycle"));
  job.modelPath = join(model, "cycle", "nested");
  try { await assert.rejects(inference.models(), { code: "ELOOP" }); }
  finally { job.modelPath = originalPath; await rm(join(model, "cycle")); }
});

test("generation reuses Host/Origin/Sec-Fetch-Site/token and bounded JSON protections", async (context) => {
  const { post, headers, base, server, job, inference } = await fixture(context);
  for (const changed of [
    { ...headers, Origin: "https://evil.example" }, { ...headers, Origin: "" },
    { ...headers, "X-Mamase-Token": "wrong" }, { ...headers, "Sec-Fetch-Site": "cross-site" },
  ]) assert.equal((await post(undefined, { headers: changed })).status, 403);
  assert.equal((await post(undefined, { headers: { ...headers, "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await post(undefined, { body: "{" })).status, 400);
  const raw = Buffer.from(JSON.stringify(bodyFor(job.id)));
  const textOffset = raw.indexOf("Hi");
  raw[textOffset] = 0xff;
  assert.equal((await post(undefined, { body: raw })).status, 400);
  assert.equal((await post({ ...bodyFor(job.id), messages: [{ role: "user", content: "x".repeat(132000) }] })).status, 413);
  assert.equal((await post({ ...bodyFor(job.id), maxTokens: 2049 })).status, 400);
  const rebound = await new Promise((done, reject) => {
    const request = httpRequest(`${base}/api/training/models`, { headers: { Host: `evil.test:${server.address().port}` } }, (response) => {
      response.resume();
      response.on("end", () => done(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(`${base}/api/training/models`, { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal(inference.operations.size, 0);
});

test("fragmented UTF-8 tokens roundtrip repeats and newlines, with real final metadata after exit", async (context) => {
  const { post, inference, job } = await fixture(context, "delayed-exit");
  for (const variant of ["base", "adapter"]) {
    const response = await post({ ...bodyFor(job.id), variant });
    const values = await events(response);
    assert.equal(values.filter((event) => event.type === "token").map((event) => event.text).join(""), "repeat\nrepeat\n\n\u00e9\ud83d\udc31");
    assert.deepEqual(values.slice(0, 2), [{ type: "status", message: "loading" }, { type: "status", message: "generating" }]);
    const complete = values.at(-1);
    assert.equal(complete.type, "complete");
    assert.equal(complete.jobId, job.id);
    assert.equal(complete.variant, variant);
    assert.equal(complete.promptTokens, 7);
    assert.equal(complete.generatedTokens, 8);
    assert.ok(complete.elapsedMs >= 500);
    await idle(inference);
  }
});

for (const mode of ["error", "stderr", "stderr-limit", "malformed", "utf8", "oversized", "output-limit", "missing", "partial", "counts", "after", "exit"]) {
  test(`worker ${mode} produces error, never complete, and releases the runtime`, async (context) => {
    const { post, inference } = await fixture(context, mode);
    const values = await events(await post());
    assert.equal(values.at(-1).type, "error");
    assert.equal(values.some((event) => event.type === "complete"), false);
    assert.doesNotMatch(JSON.stringify(values), /PRIVATE PROMPT|PRIVATE.*DIAGNOSTIC/);
    await idle(inference);
  });
}

test("response close kills even TERM-resistant children, retaining lease until exit", async (context) => {
  const { post, trainer, inference } = await fixture(context, "stubborn", { killGraceMs: 300 });
  const controller = new AbortController();
  const response = await post(undefined, { signal: controller.signal });
  const reader = response.body.getReader();
  let text = "";
  while (!text.includes("generating")) text += new TextDecoder().decode((await reader.read()).value);
  const operation = [...inference.operations][0];
  const pid = operation.child.pid;
  assert.equal(trainer.busy, true);
  controller.abort();
  await assert.rejects(reader.read(), /abort/i);
  await delay(30);
  assert.equal(trainer.busy, true);
  await idle(inference);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("wall timeout kills worker and releases lease before another operation", async (context) => {
  const { post, inference } = await fixture(context, "hang", { timeoutMs: 1500 });
  const values = await events(await post());
  assert.equal(values.at(-1).type, "error");
  assert.match(values.at(-1).message, /time limit/);
  await idle(inference);
});

test("cancel during an uncached runtime probe stops it before releasing the inference lease", async (context) => {
  const { trainer, inference, post, model } = await fixture(context);
  trainer.probing = null;
  trainer.probeArgs = ["-c", "import pathlib,signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); pathlib.Path(sys.argv[1]).write_text('ready'); time.sleep(60)", join(model, "probe-ready")];
  const pending = post();
  while (true) {
    try { await readFile(join(model, "probe-ready")); break; } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  const pid = trainer.probeChild.pid;
  const started = performance.now();
  await inference.close();
  assert.ok(performance.now() - started < 5000, "Probe should use bounded cancellation, not its 30s timeout");
  assert.equal((await pending).status, 503);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await idle(inference);
});

test("pre-stream missing, incomplete and unavailable jobs never spawn", async (context) => {
  const { trainer, inference, post, job, model } = await fixture(context);
  assert.equal((await post(bodyFor("job-00000000-0000-0000-0000-000000000000"))).status, 404);
  job.status = "failed";
  assert.equal((await post()).status, 409);
  job.status = "completed";
  await rm(join(job.outputPath, "adapters.safetensors"));
  const response = await post();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Restore/);
  assert.equal(trainer.busy, false);
  assert.equal(inference.operations.size, 0);
  await assert.rejects(readFile(join(model, "worker.pid")), { code: "ENOENT" });
});

test("worker spawn failure is surfaced without leaking the lease", async (context) => {
  const { trainer, post, inference, root } = await fixture(context);
  trainer.python = join(root, "missing-python");
  const values = await events(await post());
  assert.equal(values.at(-1).type, "error");
  assert.match(values.at(-1).message, /start.*worker|input unexpectedly/);
  await idle(inference);
});

test("training and inference reservations exclude each other around awaits", async (context) => {
  const { trainer, inference, post, payload, job } = await fixture(context, "hang");
  const response = await post();
  assert.equal((await trainer.availability()).busy, true);
  assert.equal((await inference.models()).busy, true);
  await assert.rejects(trainer.launch(payload), /already running|inference/);
  assert.equal((await post()).status, 409);
  await response.body.cancel();
  await idle(inference);
  let continueProbe;
  const availability = trainer.availability;
  trainer.availability = () => new Promise((done) => { continueProbe = () => done({ available: true }); });
  const launch = trainer.launch(payload);
  while (!continueProbe) await delay(5);
  await assert.rejects(trainer.acquireInference(() => {}), { status: 409 });
  continueProbe();
  await assert.rejects(launch, /already has a managed job/);
  trainer.availability = availability;
  job.status = "running";
  await assert.rejects(trainer.acquireInference(() => {}), { status: 409 });
  job.status = "completed";
});

test("disconnect and close during startup cannot create a process or orphan a lease", async (context) => {
  const { trainer, inference, post, model } = await fixture(context);
  const originalGet = trainer.get.bind(trainer);
  let finishGet;
  trainer.get = (id) => new Promise((done) => { finishGet = () => originalGet(id).then(done); });
  const controller = new AbortController();
  const pending = post(undefined, { signal: controller.signal });
  while (!finishGet) await delay(5);
  controller.abort();
  await assert.rejects(pending, /abort/i);
  const closed = inference.close();
  finishGet();
  await closed;
  await idle(inference);
  await assert.rejects(readFile(join(model, "worker.pid")), { code: "ENOENT" });
  assert.equal((await post()).status, 503);
});

test("trainer close stops inference before releasing directory ownership; closed managers cannot restart", async (context) => {
  const { trainer, inference, post, options, server } = await fixture(context, "stubborn", { killGraceMs: 300 });
  const response = await post();
  const reader = response.body.getReader();
  let text = "";
  while (!text.includes("generating")) text += new TextDecoder().decode((await reader.read()).value);
  const closing = trainer.close();
  await delay(20);
  assert.equal(trainer.ownsLock, true);
  await closing;
  assert.equal(trainer.ownsLock, false);
  await idle(inference);
  const fresh = new LocalTrainer(options);
  await fresh.initialize();
  await fresh.close();
  await reader.cancel();
  await assert.rejects(trainer.availability(), { status: 503 });
  await server.closeTrainingConnections();
  await assert.rejects(inference.models(), { status: 503 });
});

test("null trainer disables inference even if a manager is injected", async (context) => {
  let called = false;
  const server = createAppServer({ training: null, inference: {
    models() { called = true; }, generate() { called = true; }, close() {},
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/training/capabilities`)).json();
  assert.deepEqual(await (await fetch(`${base}/api/training/models`)).json(), { models: [], busy: false });
  const response = await fetch(`${base}/api/training/generate`, { method: "POST", headers: { Origin: base, "X-Mamase-Token": token, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 503);
  assert.equal(called, false);
});
