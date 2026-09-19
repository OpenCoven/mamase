import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { publicAssets } from "../public-assets.mjs";
import { createWorkspace, STORAGE_KEY } from "../workspace.js";
import { installAnnouncementRecorder, drainAnnouncements, waitForAnnouncement } from "../scripts/ux-announcements.mjs";

const jobId = "job-00000000-0000-4000-8000-000000000001";
const model = {
  jobId, runId: "run-fixture", artifactId: `artifact-${jobId}`, name: "Coven instruction adapter",
  baseModel: "/local/models/coven-base", contextWindow: 4096, createdAt: "2026-09-14T00:00:00.000Z",
  available: true, message: "",
};
// The browser closes an aborted fetch socket asynchronously, so server-side close is observed by polling.
async function waitUntil(condition, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const answer = 'A local reply.\n\n<script>window.injected = true</script>\nCaf\u00e9 \ud83d\udc08';

test("model playground supports honest, private local conversations across layouts", async (context) => {
  const files = new Map();
  for (const [path, [name, mime]] of publicAssets) files.set(path, [await readFile(name), mime]);
  const state = { mode: "success", models: [model], busy: false, requests: [], closed: 0 };
  const server = createServer(async (request, response) => {
    const json = (value, code = 200) => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.url === "/api/auth/session") return json({ configured: false, authenticated: false, message: "Local UI fixture" });
    if (request.url === "/api/training/capabilities") return json({ enabled: true, available: true, token: "a".repeat(64) });
    if (request.url === "/api/training/models") return state.mode === "offline" ? json({ error: "Model index is unavailable. Restart the local server." }, 503) : json({ models: state.models, busy: state.busy });
    if (request.url === "/api/training/generate") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      state.requests.push(input);
      assert.equal(request.headers["x-mamase-token"], "a".repeat(64));
      response.on("close", () => state.closed++);
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const emit = (value) => response.write(`${JSON.stringify(value)}\n`);
      emit({ type: "status", message: "loading" });
      emit({ type: "token", text: state.mode === "hold" ? "Partial local reply" : answer });
      if (state.mode === "hold") return;
      if (state.mode === "failure") emit({ type: "error", message: "Prompt plus output exceeds this model's context. Reduce max new tokens." });
      else emit({ type: "complete", jobId: input.jobId, variant: input.variant, promptTokens: 24, generatedTokens: 16, elapsedMs: 750, finishReason: "stop" });
      response.end();
      return;
    }
    const file = files.get(request.url);
    response.writeHead(file ? 200 : 404, { "Content-Type": file?.[1] || "text/plain" });
    response.end(file?.[0] || "Not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const browser = await chromium.launch();
  context.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  const pageFor = async (options = {}) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", ...options });
    page.on("pageerror", (error) => errors.push(error.message));
    await installAnnouncementRecorder(page);
    await page.addInitScript(({ workspace, key }) => localStorage.setItem(key, JSON.stringify(workspace)), { workspace: createWorkspace(), key: STORAGE_KEY });
    return page;
  };
  const ready = async (page, suffix = "") => {
    await page.goto(`${base}/#/testing${suffix}`);
    await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
    await page.getByText("Checking the local model runtime...", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), false, await page.locator("#main").innerText());
  };
  const send = async (page, message) => {
    await page.getByLabel("Message to the model", { exact: true }).fill(message);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
  };
  const completed = (page) => page.locator("#pg-status").getByText(/Reply complete/).waitFor();
  const clear = async (page) => {
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.getByRole("button", { name: "Clear & start new", exact: true }).click();
  };
  const capture = async (page, name) => {
    if (!process.env.MAMASE_SCREENSHOTS) return;
    await page.evaluate(() => window.scrollTo(0, 0));
    await mkdir(process.env.MAMASE_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.MAMASE_SCREENSHOTS, `${name}.png`), fullPage: true, animations: "disabled" });
  };

  await context.test("model identity, settings, context, escaping and explicit transcript export", async () => {
    const page = await pageFor();
    await ready(page, `/${model.artifactId}`);
    assert.equal(await page.locator(".sidebar .brand").innerText(), "mamas\u00e9.");
    assert.match(await page.title(), /Mamas\u00e9$/);
    assert.equal(await page.getByRole("group", { name: "Appearance mode" }).count(), 0);
    const before = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    await page.getByLabel("System prompt", { exact: true }).fill("Use short, clear replies.");
    await page.getByLabel("Temperature", { exact: true }).fill("0");
    await page.getByLabel("Max new tokens", { exact: true }).fill("64");
    await capture(page, "playground-dark-empty");
    await send(page, "Explain local inference.");
    await completed(page);
    assert.equal(await page.locator('[data-pg-reply="0"]').innerText(), answer);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator("#pg-model").isDisabled(), true);
    assert.equal(await page.getByLabel("System prompt", { exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Base model", exact: true }).isDisabled(), true);
    assert.deepEqual(state.requests.at(-1), { jobId, variant: "adapter", messages: [{ role: "system", content: "Use short, clear replies." }, { role: "user", content: "Explain local inference." }], temperature: 0, maxTokens: 64, seed: 42 });
    await send(page, "What changes with an adapter?");
    await completed(page);
    assert.deepEqual(state.requests.at(-1).messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
    await capture(page, "playground-dark-conversation");
    state.models = [];
    await page.getByRole("button", { name: "Refresh local models", exact: true }).click();
    await page.getByText("No completed local models yet.", { exact: true }).waitFor();
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export transcript", exact: true }).click();
    const download = await pending;
    const exported = JSON.parse(await readFile(await download.path(), "utf8"));
    assert.equal(exported.schema, "mamase.playground-transcript.v1");
    assert.equal(exported.model.jobId, jobId);
    assert.equal(exported.turns[0].jobId, jobId);
    assert.equal(exported.turns[0].baseModel, model.baseModel);
    assert.equal(exported.turns.length, 2);
    assert.equal(exported.turns[0].reply, answer);
    state.models = [model];
    await page.getByRole("button", { name: "Refresh local models", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#pg-composer button[type="submit"]').disabled);
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.getByRole("button", { name: "Keep conversation", exact: true }).click();
    assert.equal(await page.locator(".pg-turn").count(), 2);
    await clear(page);
    await page.getByRole("button", { name: "Base model", exact: true }).click();
    await send(page, "Explain local inference.");
    await completed(page);
    assert.equal(state.requests.at(-1).variant, "base");
    assert.equal(state.requests.at(-1).messages.length, 2);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY), before);
    await page.close();
  });

  await context.test("stream cancellation and errors remain incomplete and out of subsequent context", async () => {
    const page = await pageFor();
    await ready(page);
    state.mode = "hold";
    const closed = state.closed;
    await send(page, "Please stop this reply.");
    await page.locator('[data-pg-reply="0"]').getByText("Partial local reply", { exact: true }).waitFor();
    await drainAnnouncements(page);
    await page.getByRole("button", { name: "Stop generation", exact: true }).click();
    await page.locator("#pg-status").getByText("Generation stopped.", { exact: true }).waitFor();
    assert.equal((await waitForAnnouncement(page, /^Generation stopped\.$/)).id, "pg-status");
    await waitUntil(() => state.closed > closed, "Stopping closes the streaming response");
    assert.match(await page.locator(".pg-reply-meta").innerText(), /partial reply is not used/);
    await page.getByRole("button", { name: "Restore prompt", exact: true }).click();
    assert.equal(await page.getByLabel("Message to the model", { exact: true }).inputValue(), "Please stop this reply.");
    state.mode = "failure";
    await drainAnnouncements(page);
    await send(page, "This should fail.");
    await page.locator("#pg-status").getByText(/Generation failed/).waitFor();
    assert.equal((await waitForAnnouncement(page, /^Generation failed: Prompt plus output exceeds/)).id, "pg-status");
    assert.match(await page.locator(".pg-reply-meta").last().innerText(), /Reply failed/);
    state.mode = "success";
    await send(page, "A fresh attempt.");
    await completed(page);
    assert.deepEqual(state.requests.at(-1).messages, [{ role: "user", content: "A fresh attempt." }]);
    await clear(page);
    state.mode = "hold";
    await send(page, "Leave while generating.");
    await page.getByRole("button", { name: "Stop generation", exact: true }).waitFor();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await page.waitForURL("**/#/home");
    await page.locator('.sidebar a[href="#/testing"]').click();
    await page.locator("#pg-status").getByText("Generation stopped.", { exact: true }).waitFor();
    assert.equal(await page.locator(".pg-turn").count(), 1);
    state.mode = "success";
    await page.reload();
    await page.getByRole("heading", { name: "Put your model to the test.", exact: true }).waitFor();
    assert.equal(await page.locator(".pg-turn").count(), 0);
    await page.close();
  });

  await context.test("unknown artifacts never silently select a replacement and unavailable states explain the next action", async () => {
    const page = await pageFor();
    await page.goto(`${base}/#/testing/artifact-not-on-this-server`);
    await page.getByText(/no substitute has been selected/).waitFor();
    assert.equal(await page.locator("#pg-model").inputValue(), "");
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true);
    await page.locator("#pg-model").selectOption(jobId);
    await page.waitForURL(`**/#/testing/${model.artifactId}`);
    await page.getByLabel("Max new tokens", { exact: true }).fill("0");
    const calls = state.requests.length;
    await send(page, "Invalid budget");
    assert.equal(state.requests.length, calls);
    assert.equal(await page.locator("#pg-maxTokens").evaluate((input) => input.validity.valid), false);
    state.models = [{ ...model, available: false, message: "Restore the saved model weights." }];
    await page.getByRole("button", { name: "Refresh local models", exact: true }).click();
    await page.getByText("Restore the saved model weights.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true);
    state.models = [];
    await page.getByRole("button", { name: "Refresh local models", exact: true }).click();
    await page.getByText("No completed local models yet.", { exact: true }).waitFor();
    state.mode = "offline";
    await page.getByRole("button", { name: "Refresh local models", exact: true }).click();
    await page.getByText("Local model runtime needs attention.", { exact: true }).waitFor();
    state.mode = "success";
    state.models = [model];
    await page.getByRole("button", { name: "Refresh local models", exact: true }).first().click();
    await page.waitForFunction(() => !document.querySelector('#pg-composer button[type="submit"]').disabled);
    state.busy = true;
    await page.getByRole("button", { name: "Refresh local models", exact: true }).click();
    await page.getByText(/The local runtime is in use/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true);
    state.busy = false;
    await page.close();
  });

  await context.test("another artifact requires confirmation before replacing a conversation", async () => {
    const nextId = "job-00000000-0000-4000-8000-000000000002";
    const nextModel = { ...model, jobId: nextId, artifactId: `artifact-${nextId}`, name: "Another local adapter" };
    state.models = [model, nextModel];
    const page = await pageFor();
    await ready(page, `/${model.artifactId}`);
    await send(page, "Keep this conversation.");
    await completed(page);
    await page.evaluate((id) => { location.hash = `#/testing/${id}`; }, nextModel.artifactId);
    await page.getByRole("button", { name: "Keep conversation", exact: true }).waitFor();
    assert.equal(await page.locator(".pg-turn").count(), 1);
    assert.equal(await page.locator("#pg-model").inputValue(), jobId);
    await page.getByRole("button", { name: "Keep conversation", exact: true }).click();
    await page.waitForURL(`**/#/testing/${model.artifactId}`);
    await page.evaluate((id) => { location.hash = `#/testing/${id}`; }, nextModel.artifactId);
    await page.getByRole("button", { name: "Clear & start new", exact: true }).click();
    await page.waitForFunction((id) => document.querySelector("#pg-model").value === id, nextId);
    assert.equal(await page.locator(".pg-turn").count(), 0);
    await send(page, "A different model.");
    await completed(page);
    assert.equal(state.requests.at(-1).jobId, nextId);
    assert.deepEqual(state.requests.at(-1).messages, [{ role: "user", content: "A different model." }]);
    state.models = [model];
    await page.close();
  });

  await context.test("mobile, tablet, desktop and both palettes keep controls inside the viewport", async () => {
    for (const theme of ["dark", "light"]) {
      for (const width of [320, 390, 768, 1440]) {
        const page = await pageFor({ viewport: { width, height: 900 }, colorScheme: theme, hasTouch: width < 800 });
        await ready(page);
        if (width <= 1100) {
          assert.equal(await page.locator("#pg-settings").evaluate((element) => element.open), false);
          if (width <= 1100) await page.locator("#pg-settings > summary").click();
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${theme} ${width} settings`);
        if (width < 800) assert.ok((await page.getByRole("button", { name: "Base model", exact: true }).boundingBox()).height >= 44);
        await page.locator("#pg-settings > summary").click();
        await send(page, `A ${theme} ${width}px example.`);
        await completed(page);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${theme} ${width} conversation`);
        assert.ok((await page.getByRole("button", { name: "Send message", exact: true }).boundingBox()).width < width);
        await capture(page, `playground-${theme}-${width}`);
        await page.close();
      }
    }
  });
  assert.deepEqual(errors, []);
});
