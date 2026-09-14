import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const check = (condition, message, status) => { if (!condition) throw fail(message, status); };
const idPattern = /^job-[a-f0-9-]{36}$/;
const CONFIG_BYTES = 128 * 1024;
const OUTPUT_BYTES = 256 * 1024;
const missing = (error) => ["ENOENT", "ENOTDIR"].includes(error.code);
const contextKeys = ["max_position_embeddings", "n_positions", "max_seq_len", "max_sequence_length", "seq_length"];

export function validateGeneration(input) {
  check(object(input), "Generation request must be an object.");
  const fields = ["jobId", "variant", "messages", "temperature", "maxTokens", "seed"];
  check(Object.keys(input).length === fields.length && Object.keys(input).every((key) => fields.includes(key)), "Use only jobId, variant, messages, temperature, maxTokens and seed. Paths and tools are not supported.");
  check(typeof input.jobId === "string" && idPattern.test(input.jobId), "Choose a managed local jobId.");
  check(["adapter", "base"].includes(input.variant), "variant must be adapter or base.");
  check(Number.isFinite(input.temperature) && input.temperature >= 0 && input.temperature <= 2, "temperature must be between 0 and 2.");
  check(Number.isInteger(input.maxTokens) && input.maxTokens >= 1 && input.maxTokens <= 2048, "maxTokens must be an integer between 1 and 2048.");
  check(Number.isInteger(input.seed) && input.seed >= 0 && input.seed <= 0xffffffff, "seed must be a uint32 integer.");
  check(Array.isArray(input.messages) && input.messages.length >= 1 && input.messages.length <= 32, "Provide 1 to 32 conversation messages.");
  let expected = "user";
  let characters = 0;
  for (const [index, message] of input.messages.entries()) {
    check(object(message) && Object.keys(message).length === 2 && Object.keys(message).every((key) => ["role", "content"].includes(key)), "Messages support only role and text content.");
    check(typeof message.content === "string" && message.content.trim().length > 0 && message.content.isWellFormed(), "Every message must contain nonempty valid Unicode text.");
    characters += message.content.length;
    check(characters <= 32000, "Conversation text exceeds 32000 characters. Start a shorter conversation.");
    if (index === 0 && message.role === "system") continue;
    check(message.role === expected, "Use alternating user/assistant messages, with an optional system message only first.");
    expected = expected === "user" ? "assistant" : "user";
  }
  check(input.messages.at(-1).role === "user", "The final message must be a user message.");
  return structuredClone(input);
}

async function regularFile(path) {
  const info = await lstat(path);
  check(info.isFile() && info.size > 0, "Restore a nonempty regular file at the saved model/adapter path.", 409);
  return info;
}

async function readConfig(path) {
  await regularFile(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    check(info.isFile() && info.size > 0 && info.size <= CONFIG_BYTES, "Model/adapter configuration must be a nonempty JSON object of at most 128 KiB.", 409);
    const buffer = Buffer.alloc(CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    check(size <= CONFIG_BYTES, "Model/adapter configuration exceeds 128 KiB.", 409);
    let result;
    try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))); } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
      throw fail("Invalid model/adapter JSON configuration. Restore the saved local files.", 409);
    }
    check(object(result), "Model/adapter configuration must be a JSON object.", 409);
    return result;
  } finally { await handle.close(); }
}

async function inspectJob(trainer, job) {
  const descriptor = {
    jobId: job.id, runId: job.run.id, artifactId: job.artifact.id,
    name: job.artifact.name, baseModel: job.modelPath, contextWindow: null,
    createdAt: job.artifact.createdAt, available: true, message: "Ready for local text generation.",
  };
  try {
    check(job.outputPath === join(trainer.root, job.id, "adapter") && job.artifact.path === job.outputPath &&
      job.artifact.id === `artifact-${job.id}` && isAbsolute(job.modelPath), "Stored artifact paths are inconsistent. Restore the original managed training directory.", 409);
    for (const directory of [job.modelPath, job.outputPath]) {
      check((await lstat(directory)).isDirectory(), "Restore the saved local model and managed adapter directories (not symlinks).", 409);
    }
    const config = await readConfig(join(job.modelPath, "config.json"));
    const limits = contextKeys.map((key) => config[key]).filter((value) => Number.isSafeInteger(value) && value > 0);
    descriptor.contextWindow = limits.length ? Math.min(...limits) : null;
    check(config.model_file == null && !config.auto_map && /^[a-z][a-z0-9_]*$/.test(config.model_type || "") &&
      !config.is_encoder_decoder && !config.vision_config && !config.audio_config,
    "Only standard text-only local MLX models without custom code are supported.", 409);
    const tokenizer = await readConfig(join(job.modelPath, "tokenizer_config.json"));
    check(!tokenizer.auto_map && !tokenizer.chat_template_type, "Use a standard tokenizer with an existing Jinja chat template, not custom Python code.", 409);
    if (Number.isSafeInteger(tokenizer.model_max_length) && tokenizer.model_max_length > 0 && tokenizer.model_max_length < 1_000_000_000) {
      limits.push(tokenizer.model_max_length);
      descriptor.contextWindow = Math.min(...limits);
    }
    const files = await readdir(job.modelPath);
    const weights = files.filter((name) => /^model.*\.safetensors$/.test(name));
    check(weights.length > 0, "Local model weights are missing. Restore model*.safetensors at the saved base model path.", 409);
    for (const name of weights) await regularFile(join(job.modelPath, name));
    const tokenizerFiles = files.filter((name) => ["tokenizer.json", "tokenizer.model", "vocab.json", "vocab.txt", "tiktoken.model"].includes(name) || name.endsWith(".tiktoken"));
    check(tokenizerFiles.length > 0, "Local tokenizer files are missing. Restore the original tokenizer.", 409);
    for (const name of tokenizerFiles) await regularFile(join(job.modelPath, name));
    if (files.includes("model.safetensors.index.json")) {
      const index = await readConfig(join(job.modelPath, "model.safetensors.index.json"));
      check(object(index.weight_map) && Object.keys(index.weight_map).length > 0 &&
        Object.values(index.weight_map).every((name) => typeof name === "string" && weights.includes(name)),
      "Model weight shards are missing or the weight index is invalid. Restore all original shards.", 409);
    }
    await regularFile(join(job.outputPath, "adapters.safetensors"));
    await readConfig(join(job.outputPath, "adapter_config.json"));
  } catch (error) {
    if (!missing(error) && error.status !== 409) throw error;
    descriptor.available = false;
    descriptor.message = missing(error) ? "Saved model or adapter files are missing. Restore the original local model and finalized adapter at their saved paths." : error.message;
  }
  return descriptor;
}

export class LocalInference {
  constructor(trainer, { runner = fileURLToPath(new URL("./training/mlx_infer.py", import.meta.url)), timeoutMs = 300000, killGraceMs = 2000 } = {}) {
    check(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300000, "timeoutMs must be 1..300000.");
    check(Number.isInteger(killGraceMs) && killGraceMs >= 1 && killGraceMs <= 5000, "killGraceMs must be 1..5000.");
    this.trainer = trainer;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.killGraceMs = killGraceMs;
    this.operations = new Set();
    this.closed = false;
  }

  async models() {
    if (this.closed) throw fail("Local inference is stopping.", 503);
    if (!this.trainer) return { models: [], busy: false };
    await this.trainer.initialize();
    const models = [];
    for (const job of this.trainer.jobs.values()) {
      if (job.status === "completed" && job.artifact?.kind === "adapter") models.push(await inspectJob(this.trainer, job));
    }
    return { models, busy: this.trainer.busy };
  }

  async generate(value, response) {
    const input = validateGeneration(value);
    if (this.closed || !this.trainer) throw fail("Local inference is disabled or stopping.", 503);
    const operation = { child: null, exited: false, failure: null };
    operation.done = new Promise((resolveDone) => { operation.resolveDone = resolveDone; });
    operation.stop = (error = fail("Local generation cancelled because the server is stopping.", 503)) => {
      operation.failure ||= error;
      if (operation.reserved) void this.trainer.stopProbe(this.killGraceMs);
      if (!operation.child || operation.exited) return;
      operation.child.kill("SIGTERM");
      operation.killTimer ||= setTimeout(() => { if (!operation.exited) operation.child.kill("SIGKILL"); }, this.killGraceMs);
    };
    const disconnected = () => operation.stop(fail("Local generation cancelled: client disconnected.", 499));
    response.once("close", disconnected);
    this.operations.add(operation);
    const timer = setTimeout(() => operation.stop(fail("Local generation exceeded its time limit. Use a smaller model, a shorter conversation or fewer output tokens.", 504)), this.timeoutMs);
    const alive = () => {
      if (response.destroyed) disconnected();
      if (operation.failure) throw operation.failure;
    };
    let release;
    try {
      alive();
      release = await this.trainer.acquireInference(operation.stop);
      operation.reserved = true;
      alive();
      const job = await this.trainer.get(input.jobId);
      check(job.status === "completed" && job.artifact?.kind === "adapter", "Only completed managed MLX adapter jobs can generate.", 409);
      const descriptor = await inspectJob(this.trainer, job);
      check(descriptor.available, descriptor.message, 409);
      alive();
      const capability = await this.trainer.availability();
      alive();
      check(capability.available, capability.message, 503);
      response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.flushHeaders();
      await this.run(operation, { ...input, modelPath: job.modelPath, adapterPath: job.outputPath }, response);
    } finally {
      clearTimeout(timer);
      clearTimeout(operation.killTimer);
      response.off("close", disconnected);
      release?.();
      this.operations.delete(operation);
      operation.resolveDone();
    }
  }

  run(operation, input, response) {
    return new Promise((resolveRun) => {
      let pending = "", bytes = 0, sentBytes = 0, stderrBytes = 0, stderr = Buffer.alloc(0), final = null, generating = false, statuses = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const started = performance.now();
      const send = (event) => {
        if (response.destroyed || response.writableEnded) return;
        const line = `${JSON.stringify(event)}\n`;
        sentBytes += Buffer.byteLength(line);
        if (sentBytes > OUTPUT_BYTES || response.writableLength > OUTPUT_BYTES) throw fail("Generation output exceeded 256 KiB. Request fewer output tokens.", 502);
        response.write(line);
      };
      const protocol = (line) => {
        check(line.length > 0 && Buffer.byteLength(line) <= 64 * 1024, "Invalid or oversized inference worker event.", 502);
        let event;
        try { event = JSON.parse(line); } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          throw fail("Inference worker returned malformed JSON.", 502);
        }
        check(object(event) && !final, "Inference worker sent an invalid event or output after completion.", 502);
        if (event.type === "status") {
          check(["loading", "generating"].includes(event.message) && ++statuses <= 2 &&
            !generating && (event.message !== "loading" || statuses === 1), "Invalid inference worker status.", 502);
          generating = event.message === "generating";
          send({ type: "status", message: event.message });
        } else if (event.type === "token") {
          check(generating && typeof event.text === "string" && event.text.isWellFormed() && Buffer.byteLength(event.text) <= 16 * 1024, "Invalid inference token event.", 502);
          send({ type: "token", text: event.text });
        } else if (event.type === "complete") {
          check(generating && ["stop", "length"].includes(event.finishReason) &&
            Number.isInteger(event.promptTokens) && event.promptTokens > 0 && event.promptTokens <= 8192 &&
            Number.isInteger(event.generatedTokens) && event.generatedTokens >= 1 && event.generatedTokens <= input.maxTokens &&
            (event.finishReason !== "length" || event.generatedTokens === input.maxTokens),
          "Invalid inference completion counts or termination reason.", 502);
          final = { type: "complete", finishReason: event.finishReason, promptTokens: event.promptTokens, generatedTokens: event.generatedTokens };
        } else if (event.type === "error") {
          check(typeof event.message === "string" && event.message.length > 0 && event.message.length <= 2000, "Invalid inference worker error.", 502);
          throw fail(event.message, 502);
        } else throw fail("Unknown inference worker event.", 502);
      };
      const consume = (text) => {
        pending += text;
        let end;
        while ((end = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          protocol(line);
        }
        check(Buffer.byteLength(pending) <= 64 * 1024, "Inference worker event exceeded 64 KiB.", 502);
      };
      const env = { ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", TOKENIZERS_PARALLELISM: "false", MLXLM_USE_MODELSCOPE: "False" };
      let child;
      try {
        child = spawn(this.trainer.python, ["-u", this.runner], { cwd: this.trainer.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
      } catch {
        send({ type: "error", message: "Unable to start the local inference worker. Check the configured Python runtime." });
        response.end();
        resolveRun();
        return;
      }
      operation.child = child;
      child.stdout.on("data", (chunk) => {
        if (operation.failure) return;
        try {
          bytes += chunk.length;
          check(bytes <= OUTPUT_BYTES - 4096, "Generation output exceeded 256 KiB. Request fewer output tokens.", 502);
          consume(decoder.decode(chunk, { stream: true }));
        } catch (error) {
          operation.stop(error instanceof TypeError ? fail("Inference worker returned invalid UTF-8.", 502) : error);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        stderr = Buffer.concat([stderr, chunk.subarray(Math.max(0, chunk.length - 8192))]).subarray(-8192);
        if (stderrBytes > 64 * 1024) operation.stop(fail("Inference worker exceeded its diagnostic limit. Check local model compatibility.", 502));
      });
      child.on("error", () => operation.stop(fail("Unable to start the local inference worker. Check the configured Python runtime.", 503)));
      child.stdin.on("error", () => operation.stop(fail("The local inference worker closed its input unexpectedly.", 502)));
      child.on("close", (code, signal) => {
        operation.exited = true;
        clearTimeout(operation.killTimer);
        if (!operation.failure) {
          try {
            consume(decoder.decode());
            check(!pending, "Inference worker ended with an incomplete event.", 502);
            check(code === 0 && !signal, `Inference worker exited ${signal || code}. ${stderr.length ? "Worker diagnostics were received (content withheld for prompt privacy). " : ""}Check local model/runtime compatibility.`, 502);
            check(final, "Inference worker exited without a valid completion event.", 502);
          } catch (error) {
            operation.failure = error instanceof TypeError ? fail("Inference worker returned invalid UTF-8.", 502) : error;
          }
        }
        // Diagnostics may contain prompts: retain only a bounded in-memory tail, never log or return it.
        stderr = Buffer.alloc(0);
        try {
          if (stderrBytes) send({ type: "status", message: `Local worker emitted ${stderrBytes} bytes of diagnostics (content withheld for conversation privacy).` });
          if (operation.failure) send({ type: "error", message: operation.failure.message });
          else send({ ...final, elapsedMs: performance.now() - started, variant: input.variant, jobId: input.jobId });
        } catch {
          response.destroy();
        }
        response.end();
        resolveRun();
      });
      if (operation.failure || response.destroyed) operation.stop();
      else child.stdin.write(`${JSON.stringify(input)}\n`);
      // Keep stdin open: the worker's EOF monitor cancels if this parent dies.
    });
  }

  close() {
    this.closed = true;
    const operations = [...this.operations];
    for (const operation of operations) operation.stop();
    return Promise.all(operations.map((operation) => operation.done)).then(() => undefined);
  }
}
