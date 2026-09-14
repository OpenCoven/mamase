import test from "node:test";
import assert from "node:assert/strict";
import { PlaygroundClient } from "../playground-client.js";

const jobId = "job-11111111-1111-4111-8111-111111111111";
const model = { jobId, runId: "run-one", artifactId: `artifact-${jobId}`, name: "Coven adapter", baseModel: "/models/base", contextWindow: 256, createdAt: "2026-09-14T12:00:00Z", available: true, message: "" };
const request = { jobId, variant: "adapter", messages: [{ role: "user", content: "Say blue." }], maxTokens: 16, temperature: 0, seed: 42 };
const complete = { type: "complete", jobId, variant: "adapter", finishReason: "length", generatedTokens: 3, promptTokens: 8, elapsedMs: 100 };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const stream = (events, fragment = false) => {
  const bytes = new TextEncoder().encode(events.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n") + "\n");
  return new Response(new ReadableStream({ start(controller) {
    if (fragment) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { "content-type": "application/x-ndjson" } });
};
function clientFor(generation, calls = []) {
  return new PlaygroundClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/capabilities")) return json({ enabled: true, available: true, token: "a".repeat(64), busy: false });
    if (url.endsWith("/models")) return json({ models: [model], busy: false });
    return generation();
  } });
}

test("hosted playground never contacts local model or generation endpoints", async () => {
  const client = new PlaygroundClient({ hosted: true, fetchImpl: () => { throw new Error("Unexpected request"); } });
  assert.equal((await client.load()).hosted, true);
  await assert.rejects(client.generate(request), /local/i);
});

test("playground discovers completed models and preserves fragmented Unicode replies", async () => {
  const calls = [], events = [];
  const client = clientFor(() => stream([{ type: "status", message: "Loading model" }, { type: "token", text: "caf\u00e9\n<script>not HTML</script>" }, complete], true), calls);
  assert.deepEqual((await client.load()).models, [model]);
  assert.deepEqual(await client.generate(request, { onEvent: (event) => events.push(event) }), complete);
  assert.equal(events.find((event) => event.type === "token").text, "caf\u00e9\n<script>not HTML</script>");
  assert.equal(calls.at(-1).options.headers["X-Mamase-Token"], "a".repeat(64));
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), request);
});

test("truncated, malformed and mismatched generation streams never look completed", async () => {
  for (const events of [
    [{ type: "token", text: "Partial" }],
    ["not json"],
    [{ ...complete, jobId: "other-job" }],
    [complete, { type: "token", text: "Too late" }],
    [{ type: "complete", ...complete, generatedTokens: -1 }],
  ]) {
    const client = clientFor(() => stream(events));
    await client.load();
    await assert.rejects(client.generate(request), /stream|generation|completion|model|token/i);
  }
});

test("worker and HTTP failures remain actionable rather than becoming empty replies", async () => {
  for (const response of [
    () => json({ error: "Another local operation is running." }, 409),
    () => stream([{ type: "error", message: "Input exceeds the model context window." }]),
  ]) {
    const client = clientFor(response);
    await client.load();
    await assert.rejects(client.generate(request), /running|context window/);
  }
});

test("model discovery rejects malformed metadata and does not silently pick a fallback", async () => {
  const client = new PlaygroundClient({ fetchImpl: async (url) => url.endsWith("/capabilities")
    ? json({ enabled: true, available: true, token: "a".repeat(64) })
    : json({ models: [{ ...model, available: "yes" }], busy: false }) });
  await assert.rejects(client.load(), /model/i);
});

test("generation cancellation propagates the caller's signal", async () => {
  const calls = [], abort = new AbortController();
  const client = clientFor(() => stream([complete]), calls);
  await client.load();
  await client.generate(request, { signal: abort.signal });
  assert.equal(calls.at(-1).options.signal, abort.signal);
});
