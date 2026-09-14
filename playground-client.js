import { assert } from "./workspace.js";

const JOB_ID = /^job-[a-f0-9-]{36}$/;
const MAX_STREAM_BYTES = 1024 * 1024;
const text = (value, maximum = 4000) => typeof value === "string" && value.length <= maximum;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

async function readJson(response) {
  assert(response.headers.get("content-type")?.includes("application/json"), "Local model API unavailable. Restart Mamas\u00e9 with npm run dev.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let result = "", bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert(bytes <= 2 * 1024 * 1024, "Local model API response is too large.");
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  let value;
  try { value = JSON.parse(result); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("Local model API returned invalid JSON.");
  }
  if (!response.ok) throw new Error(text(value?.error) && value.error ? value.error : `Local model request failed (${response.status}).`);
  return value;
}

function validateModel(model) {
  assert(model && JOB_ID.test(model.jobId) && text(model.runId, 80) && model.runId &&
    text(model.artifactId, 80) && model.artifactId && text(model.name, 200) && model.name &&
    text(model.baseModel, 4096) && model.baseModel && typeof model.available === "boolean" &&
    text(model.message) && text(model.createdAt, 80) && Number.isFinite(Date.parse(model.createdAt)) &&
    (model.contextWindow === null || (count(model.contextWindow) && model.contextWindow > 0)),
  "The local model index contains an invalid model.");
  return model;
}

function parseEvent(line, request) {
  let event;
  try { event = JSON.parse(line); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("The generation stream contains invalid JSON.");
  }
  assert(event && !Array.isArray(event), "Invalid generation stream event.");
  if (event.type === "status") assert(text(event.message) && event.message, "Invalid generation status.");
  else if (event.type === "token") assert(text(event.text, 65536), "Invalid generation token.");
  else if (event.type === "error") {
    assert(text(event.message) && event.message, "Invalid generation error.");
    throw new Error(event.message);
  } else if (event.type === "complete") {
    assert(event.jobId === request.jobId && event.variant === request.variant, "Generation completion does not match the selected model.");
    assert(["stop", "length"].includes(event.finishReason) && count(event.promptTokens) &&
      count(event.generatedTokens) && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0,
    "Invalid generation completion measurements.");
  } else throw new Error("Unknown generation stream event.");
  return event;
}

export class PlaygroundClient {
  constructor({ hosted = false, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.hosted = hosted;
    this.fetch = fetchImpl;
  }

  async load() {
    if (this.hosted) return { hosted: true, capability: { enabled: false, available: false }, models: [], busy: false };
    const capability = await readJson(await this.fetch("/api/training/capabilities", { cache: "no-store", signal: AbortSignal.timeout(35000) }));
    assert(typeof capability.enabled === "boolean" && typeof capability.available === "boolean", "Invalid local model capability response.");
    if (capability.hosted === true) {
      this.hosted = true;
      return { hosted: true, capability, models: [], busy: false };
    }
    if (!capability.enabled) return { hosted: false, capability, models: [], busy: false };
    assert(typeof capability.token === "string" && /^[a-f0-9]{64}$/.test(capability.token), "Local model capability is missing its command token.");
    this.token = capability.token;
    const result = await readJson(await this.fetch("/api/training/models", { cache: "no-store", signal: AbortSignal.timeout(35000) }));
    assert(Array.isArray(result.models) && typeof result.busy === "boolean", "Invalid local model index response.");
    const models = result.models.map(validateModel);
    assert(new Set(models.map((model) => model.jobId)).size === models.length, "Duplicate models in the local model index.");
    return { hosted: false, capability, models, busy: result.busy };
  }

  async generate(request, { signal, onEvent = () => {} } = {}) {
    assert(!this.hosted, "Model testing runs in the local Mamas\u00e9 app, not on this hosted site.");
    assert(this.token, "Refresh local models before sending a prompt.");
    const response = await this.fetch("/api/training/generate", {
      method: "POST", cache: "no-store", signal: signal || AbortSignal.timeout(330000),
      headers: { "Content-Type": "application/json", "X-Mamase-Token": this.token },
      body: JSON.stringify(request),
    });
    if (!response.ok) await readJson(response);
    assert(response.headers.get("content-type")?.includes("application/x-ndjson") && response.body, "The local model did not return a generation stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "", bytes = 0, completion = null;
    const accept = (line) => {
      if (!line.trim()) return;
      assert(!completion, "The generation stream continued after completion.");
      const event = parseEvent(line, request);
      if (event.type === "complete") completion = event;
      else onEvent(event);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        assert(bytes <= MAX_STREAM_BYTES, "The generation stream exceeded its size limit.");
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n")) !== -1) {
          assert(end <= 65536, "The generation stream contains an oversized event.");
          accept(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
        assert(buffer.length <= 65536, "The generation stream contains an oversized event.");
      }
      buffer += decoder.decode();
      if (buffer.trim()) accept(buffer);
      assert(completion, "The generation stream ended before completion. The reply is incomplete.");
      return completion;
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
}
