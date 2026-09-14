import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, open, unlink, appendFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { assert, MAX_IMPORT_BYTES, parseDataset, validateWorkspace, validateArtifact, recordProgress } from "./workspace.js";
import { trainingIdentity } from "./training-state.js";

const project = fileURLToPath(new URL(".", import.meta.url));
const active = (job) => ["starting", "running", "cancelling"].includes(job.status);
const timestamp = (run) => new Date(Math.max(Date.now(), Date.parse(run.updatedAt))).toISOString();
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const environment = () => ({ ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" });

export class LocalTrainer extends EventEmitter {
  constructor({ root = resolve(project, ".mamase/training"), cwd = project, python = process.env.MAMASE_PYTHON || resolve(project, ".venv-training/bin/python"), runner = resolve(project, "training/mlx_runner.py"), probeArgs = ["-c", "import mlx.core as mx, mlx_lm; print('MLX-LM ready; Metal=' + str(mx.metal.is_available()))"] } = {}) {
    super();
    this.root = resolve(root);
    this.cwd = resolve(cwd);
    this.python = python;
    this.runner = runner;
    this.probeArgs = probeArgs;
    this.jobs = new Map();
    this.processes = new Map();
    this.closed = false;
    this.launching = false;
  }

  async initialize() {
    if (!this.initializing) this.initializing = this.load();
    return this.initializing;
  }

  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, "owner.json");
    this.owner = randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await open(lock, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, owner: this.owner }));
        await handle.close();
        this.ownsLock = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = JSON.parse(await readFile(lock, "utf8"));
        assert(Number.isSafeInteger(owner.pid) && owner.pid > 0, "Invalid training-directory owner record.");
        try { process.kill(owner.pid, 0); } catch (check) {
          if (check.code !== "ESRCH") throw check;
          await unlink(lock);
          continue;
        }
        throw problem("Another Mamase server owns this training directory. Stop it or choose a different MAMASE_TRAINING_DIR.", 409);
      }
    }
    assert(this.ownsLock, "Could not acquire the local training directory.");
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^job-[a-f0-9-]{36}$/.test(entry.name)) continue;
      const job = JSON.parse(await readFile(join(this.root, entry.name, "state.json"), "utf8"));
      assert(job.id === entry.name && typeof job.identity === "string", `Invalid stored local job ${entry.name}.`);
      assert(job.run.localJobId === job.id && Number.isSafeInteger(job.sequence) && job.sequence >= 0 &&
        ["starting", "running", "cancelling", "completed", "failed", "cancelled"].includes(job.status), `Invalid stored job state: ${entry.name}`);
      assert(job.outputPath === join(this.root, job.id, "adapter") && job.sourcePath === join(this.root, job.id, "original.jsonl"), "The training directory moved. Restore its original path before reconnecting jobs.");
      assert(active(job) ? job.run.status === "running" : job.run.status === job.status, "Stored job lifecycle is inconsistent.");
      const validated = validateWorkspace({ version: 1, name: "Job", programs: [job.program], datasets: [job.dataset], runs: [job.run], artifacts: [], evaluations: [] });
      assert(trainingIdentity(validated.runs[0], job.dataset) === job.identity, `Stored job identity mismatch: ${entry.name}`);
      this.jobs.set(job.id, job);
      if (active(job)) {
        job.status = "failed";
        job.error = "The training server stopped before this job finalized. Duplicate the recipe to start a new attempt.";
        job.run = recordProgress(job.run, { status: "failed", step: job.run.step, totalSteps: job.run.totalSteps, loss: null, evalLoss: null, note: job.error, recordedAt: timestamp(job.run) });
        await this.save(job);
      }
    }
  }

  async availability() {
    await this.initialize();
    if (!this.probing) this.probing = new Promise((resolveProbe) => {
      const child = spawn(this.python, this.probeArgs, { cwd: this.cwd, env: environment(), stdio: ["ignore", "pipe", "pipe"], shell: false });
      this.probeChild = child;
      let output = "";
      const collect = (chunk) => { output = (output + chunk.toString()).slice(-4000); };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolveProbe({ available: false, message: `Local Python runtime unavailable: ${error.message}`, python: this.python });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveProbe({ available: code === 0, message: code === 0 ? output.trim() : `Install the training requirements for ${this.python}. ${output.trim()}`, python: this.python });
      });
    });
    const result = await this.probing;
    if (!result.available) this.probing = null;
    return { ...result, enabled: true, backend: "mlx-lm", outputRoot: this.root, busy: this.launching || [...this.jobs.values()].some(active) };
  }

  async findRun(runId) {
    await this.initialize();
    return [...this.jobs.values()].find((job) => job.run.id === runId) || null;
  }

  async get(id) {
    await this.initialize();
    const job = this.jobs.get(id);
    if (!job) throw problem("Local job not found.", 404);
    return job;
  }

  async save(job) {
    const directory = join(this.root, job.id);
    const temporary = join(directory, "state.tmp");
    await writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
    await rename(temporary, join(directory, "state.json"));
  }

  async launch(input) {
    await this.initialize();
    if (this.closed) throw problem("The local training server is stopping.", 503);
    if (this.launching || [...this.jobs.values()].some(active)) throw problem("A local job is already running. Wait or cancel it before launching another.", 409);
    this.launching = true;
    try {
      const capability = await this.availability();
      if (!capability.available) throw problem(capability.message, 503);
      if (this.closed) throw problem("The local training server is stopping.", 503);
      assert(input?.confirmManagedOutput === true, "Confirm the managed output directory and local dataset copy.");
      const workspace = validateWorkspace(input.workspace);
      assert(workspace.runs.length === 1 && workspace.datasets.length === 1 && workspace.programs.length === 1 && workspace.artifacts.length === 0 && workspace.evaluations.length === 0, "Launch requires exactly one saved recipe, its dataset and its program.");
      const run = workspace.runs[0];
      const dataset = workspace.datasets[0];
      assert(run.status === "planned" && run.history.length === 0 && !run.localJobId, "Only an untouched planned run can be launched. Duplicate an existing attempt.");
      if ([...this.jobs.values()].some((job) => job.run.id === run.id)) throw problem("This run already has a managed job. Reconnect to it instead of launching twice.", 409);
      assert(typeof input.datasetBase64 === "string" && input.datasetBase64.length <= Math.ceil(MAX_IMPORT_BYTES / 3) * 4 && input.datasetBase64.length % 4 === 0, "Choose a valid JSONL file of at most 20 MB.");
      const source = Buffer.from(input.datasetBase64, "base64");
      assert(source.toString("base64") === input.datasetBase64, "Invalid dataset encoding.");
      assert(source.length === dataset.bytes && source.length <= MAX_IMPORT_BYTES, "The selected file size does not match the imported dataset.");
      assert(createHash("sha256").update(source).digest("hex") === dataset.sha256, "The selected JSONL file does not match this dataset's SHA-256 fingerprint.");
      const parsed = parseDataset(new TextDecoder("utf-8", { fatal: true }).decode(source));
      assert(parsed.records === dataset.records && parsed.format === dataset.format, "Dataset contents do not match the saved metadata.");
      let modelPath;
      try { modelPath = await realpath(resolve(this.cwd, run.recipe.student)); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        throw problem("The recipe's base/student model must be an existing local MLX model directory. Remote downloads are disabled; duplicate the recipe to update its model path.");
      }
      assert((await lstat(modelPath)).isDirectory(), "The local model path must be a directory.");
      const id = `job-${randomUUID()}`;
      const directory = join(this.root, id);
      const staging = join(this.root, `.preparing-${id}`);
      await mkdir(staging, { mode: 0o700 });
      const sourcePath = join(directory, "original.jsonl");
      const outputPath = join(directory, "adapter");
      const managed = { ...run, localJobId: id };
      const job = { version: 1, id, identity: trainingIdentity(run, dataset), program: workspace.programs[0], dataset, modelPath, outputPath, sourcePath, status: "starting", sequence: 0, logs: [], artifact: null, error: "", run: recordProgress(managed, { status: "running", step: 0, totalSteps: run.totalSteps, loss: null, evalLoss: null, note: "Starting the local MLX-LM trainer process.", recordedAt: timestamp(run) }) };
      try {
        await mkdir(join(staging, "adapter"), { mode: 0o700 });
        await writeFile(join(staging, "original.jsonl"), source, { mode: 0o600 });
        await writeFile(join(staging, "job.json"), JSON.stringify({ version: 1, jobId: id, run, dataset, sourcePath, modelPath, outputPath }), { mode: 0o600 });
        await writeFile(join(staging, "state.json"), JSON.stringify(job), { mode: 0o600 });
        await rename(staging, directory);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      this.jobs.set(id, job);
      this.start(job, join(directory, "job.json"));
      return job;
    } finally {
      this.launching = false;
    }
  }

  start(job, config) {
    const child = spawn(this.python, ["-u", this.runner, config], { cwd: this.cwd, env: environment(), stdio: ["pipe", "pipe", "pipe"], shell: false });
    const context = { child, queue: Promise.resolve(), complete: false, failure: "", cancel: false, exited: false, logBytes: 0 };
    context.closed = new Promise((resolveClosed) => { context.resolveClosed = resolveClosed; });
    this.processes.set(job.id, context);
    const enqueue = (operation) => {
      context.queue = context.queue.then(operation).catch(async (error) => {
        context.failure = error.message;
        this.terminate(context);
        try { await this.finish(job, context, false, error.message); } catch (saveError) {
          job.error = `Job persistence failed: ${saveError.message}`;
          this.emit("update", job.id, { type: "fatal", message: job.error });
          console.error(job.error);
        }
      });
    };
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => enqueue(async () => {
      if (!active(job)) return;
      if (line.startsWith("MAMASE_EVENT ")) {
        const event = JSON.parse(line.slice(13));
        if (event.type === "progress") {
          assert(!context.complete, "Trainer reported progress after completion.");
          assert(event.totalSteps === job.run.totalSteps, "Trainer optimizer-step count does not match the recipe.");
          assert(job.run.history.length < 9998, "Trainer exceeded the observation limit.");
          const update = { status: "running", step: event.step, totalSteps: event.totalSteps, loss: event.loss, evalLoss: event.evalLoss, note: typeof event.note === "string" ? event.note.slice(0, 2000) : "Measured by the local MLX-LM trainer.", recordedAt: timestamp(job.run) };
          job.run = recordProgress(job.run, update);
          if (!context.cancel) job.status = "running";
          job.sequence++;
          await this.save(job);
          this.emit("update", job.id, { type: "progress", sequence: job.sequence, status: job.status, update });
        } else if (event.type === "complete") {
          assert(!context.complete, "Duplicate trainer completion.");
          context.complete = true;
        } else if (event.type === "log") {
          assert(typeof event.message === "string", "Invalid trainer log record.");
          await this.log(job, context, event.message);
        } else throw new Error("Unknown trainer event.");
      } else await this.log(job, context, line);
    }));
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => enqueue(() => this.log(job, context, line)));
    child.on("error", (error) => { context.failure = error.message; });
    child.on("close", (code, signal) => {
      context.exited = true;
      clearTimeout(context.killTimer);
      enqueue(async () => {
        await this.finish(job, context, code === 0 && context.complete, context.failure || `Trainer exited ${signal || code}${code === 0 && !context.complete ? " without finalizing an adapter" : ""}. ${job.logs.at(-1)?.slice(-500) || "See trainer logs."}`);
      });
      context.queue.finally(() => { context.resolveClosed(); this.processes.delete(job.id); });
    });
  }

  terminate(context) {
    if (context.exited) return;
    context.child.kill("SIGTERM");
    if (!context.killTimer) context.killTimer = setTimeout(() => { if (!context.exited) context.child.kill("SIGKILL"); }, 5000);
  }

  async log(job, context, source) {
    if (context.logBytes >= 8 * 1024 * 1024) return;
    const message = source.slice(0, 8192);
    context.logBytes += Buffer.byteLength(message);
    const line = context.logBytes >= 8 * 1024 * 1024 ? "Trainer text log limit reached (8 MB). Progress observations continue to be recorded." : message;
    job.logs.push(line);
    if (job.logs.length > 150) job.logs.shift();
    await appendFile(join(this.root, job.id, "trainer.log"), `${line}\n`, { mode: 0o600 });
    this.emit("update", job.id, { type: "logs", logs: job.logs });
  }

  async finish(job, context, success, failure) {
    if (!active(job)) return;
    const finished = { ...job, artifact: null };
    if (context.cancel) {
      finished.status = "cancelled";
      finished.error = "Local training was cancelled. Partial files are not registered as a finished adapter.";
    } else if (success) {
      try {
        assert(job.run.step === job.run.totalSteps, "Trainer exited before reporting every optimizer step.");
        for (const filename of ["adapters.safetensors", "adapter_config.json"]) {
          const file = await lstat(join(job.outputPath, filename));
          assert(file.isFile() && file.size > 0, `Missing or invalid trainer output: ${filename}`);
        }
        const config = JSON.parse(await readFile(join(job.outputPath, "adapter_config.json"), "utf8"));
        assert(config && typeof config === "object" && !Array.isArray(config), "Invalid adapter configuration.");
        finished.status = "completed";
        finished.artifact = validateArtifact({ id: `artifact-${job.id}`, runId: job.run.id, name: `${job.run.name.slice(0, 85)} · MLX adapter`, kind: "adapter", path: job.outputPath, createdAt: timestamp(job.run), notes: `Automatically registered after successful MLX-LM training. Base model: ${job.modelPath}. Source SHA-256: ${job.dataset.sha256}.` }, { runs: [job.run] });
      } catch (error) { finished.status = "failed"; finished.error = `Adapter finalization failed: ${error.message}`; }
    } else { finished.status = "failed"; finished.error = failure; }
    finished.run = recordProgress(job.run, { status: finished.status, step: job.run.step, totalSteps: job.run.totalSteps, loss: null, evalLoss: null, note: finished.status === "completed" ? "Local training completed and adapter files were finalized." : finished.error.slice(0, 2000), recordedAt: timestamp(job.run) });
    finished.sequence++;
    await this.save(finished);
    Object.assign(job, finished);
    this.emit("update", job.id, { type: "snapshot", job });
  }

  async cancel(id) {
    const job = await this.get(id);
    const context = this.processes.get(id);
    if (!active(job) || !context) throw problem("This local job is no longer running.", 409);
    context.cancel = true;
    job.status = "cancelling";
    this.terminate(context);
    context.queue = context.queue.then(() => this.save(job));
    await context.queue;
    this.emit("update", job.id, { type: "snapshot", job });
    return job;
  }

  async close() {
    this.closed = true;
    if (this.initializing) {
      try { await this.initializing; } catch (error) {
        console.error(`Closing local training after initialization failure: ${error.message}`);
        if (!this.ownsLock) return;
      }
    }
    if (this.probeChild && this.probeChild.exitCode === null) this.probeChild.kill("SIGTERM");
    for (const [id, context] of this.processes) {
      context.cancel = true;
      this.terminate(context);
      await context.closed;
    }
    if (this.ownsLock) {
      const lock = join(this.root, "owner.json");
      const value = JSON.parse(await readFile(lock, "utf8"));
      if (value.owner === this.owner) await unlink(lock);
      this.ownsLock = false;
    }
  }
}
