import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { publicAssets } from "../public-assets.mjs";
import { TrainingClient } from "../training-client.js";
import { runGuidance } from "../training-guide.js";
import { createWorkspace, createRun, recordProgress } from "../workspace.js";
import { existsSync } from "node:fs";

test("hosted static files contain only public assets and functions are limited to accounts", async () => {
  execFileSync(process.execPath, ["scripts/build-hosted.mjs"]);
  const expected = [...new Set([...publicAssets.values()].map(([name]) => name)), "training-capabilities.json"].sort();
  assert.deepEqual((await readdir("dist")).sort(), expected);
  const html = await readFile("dist/index.html", "utf8");
  assert.match(html, /name="mamase-runtime" content="hosted"/);
  const capability = JSON.parse(await readFile("dist/training-capabilities.json", "utf8"));
  assert.equal(capability.hosted, true);
  assert.equal(capability.enabled, false);
  assert.equal(capability.available, false);
  const config = JSON.parse(await readFile("vercel.json", "utf8"));
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, "dist");
  assert.deepEqual(Object.keys(config.functions), ["api/auth/*.js"]);
  assert.ok(config.rewrites.some((item) => item.source === "/api/training/capabilities" && item.destination === "/training-capabilities.json"));
});

test("hosted clients never request job endpoints or issue training commands", async () => {
  const calls = [];
  const client = new TrainingClient({ onJob: () => assert.fail("No hosted job"), onStatus: () => {} });
  client.request = async (path) => {
    calls.push(path);
    assert.equal(path, "capabilities");
    return { enabled: false, available: false, hosted: true, message: "Use local Mamase to train." };
  };
  await client.watch({ id: "run", localJobId: "job" });
  assert.equal(client.loading.size, 0);
  assert.equal(client.errors.size, 0, "Expected hosted limitations are guidance, not failed training");
  await assert.rejects(client.launch({ workspace: { runs: [{ id: "run" }] } }), /local Mamase/);
  await assert.rejects(client.cancel("job"), /local Mamase/);
  assert.deepEqual(calls, ["capabilities"]);
});

test("disabled local trainers and failed hosted capability requests remain actionable errors", async () => {
  const client = new TrainingClient({ onJob: () => assert.fail("No job should be requested"), onStatus: () => {} });
  client.request = async () => ({ enabled: false, available: false, message: "Local training is not configured." });
  await client.watch({ id: "local" });
  assert.equal(client.errors.get("local"), "Local training is not configured.");
  client.request = async () => ({ enabled: false, available: false, hosted: true, message: "Use the local app to train." });
  await client.watch({ id: "hosted" }, true);
  assert.equal(client.errors.has("hosted"), false);
  client.request = async () => { throw new Error("Capabilities could not be loaded."); };
  await client.watch({ id: "hosted" }, true);
  assert.equal(client.errors.get("hosted"), "Capabilities could not be loaded.");
  assert.equal(client.loading.size, 0);
});

test("hosted recipes explain the local handoff instead of offering server installation or launch", () => {
  const guide = runGuidance({ status: "planned", recipe: { workflow: "managed" } }, { hosted: true, available: false });
  assert.equal(guide.phase, "hosted");
  assert.equal(guide.action, "backup");
  assert.match(guide.description, /export/i);
  assert.match(guide.description, /Restore backup/);
  assert.match(guide.description, /replaces/);
  const savedJob = runGuidance({ status: "running", localJobId: "job", recipe: {} }, { hosted: true });
  assert.equal(savedJob.phase, "hosted");
  assert.match(savedJob.title, /not a live connection/);
  assert.match(savedJob.description, /cannot monitor/);
});

test("invalid browser JavaScript fails before replacing a previous hosted build", async () => {
  const root = await mkdtemp(join(tmpdir(), "mamase-build-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "dist"));
    for (const name of ["scripts/build-hosted.mjs", "public-assets.mjs", ...new Set([...publicAssets.values()].map(([name]) => name))]) {
      await copyFile(name, join(root, name));
    }
    await writeFile(join(root, "dist/previous.txt"), "Keep the last build.");
    await writeFile(join(root, "app.js"), `${"<".repeat(7)} conflict\n`);
    assert.throws(() => execFileSync(process.execPath, [join(root, "scripts/build-hosted.mjs")], { stdio: "pipe" }), /SyntaxError/);
    assert.equal(await readFile(join(root, "dist/previous.txt"), "utf8"), "Keep the last build.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prebuilt releases isolate four account functions from browser and training code", async () => {
  execFileSync(process.execPath, ["scripts/build-hosted.mjs", "--prebuilt"]);
  const functions = ".vercel/output/functions/api/auth";
  assert.equal(existsSync(functions), true, "The release needs explicit account functions.");
  assert.deepEqual((await readdir(functions)).sort(), ["callback.func", "login.func", "logout.func", "session.func"]);
  assert.equal(existsSync(".vercel/output/functions/index.func"), false);
  assert.equal(existsSync(".vercel/output/static/auth-api.mjs"), false);
  const isolated = await mkdtemp(join(tmpdir(), "mamase-auth-function-"));
  try {
    const { cp } = await import("node:fs/promises");
    await cp(`${functions}/session.func`, isolated, { recursive: true });
    const config = JSON.parse(await readFile(join(isolated, ".vc-config.json"), "utf8"));
    assert.equal(config.launcherType, "Nodejs");
    assert.equal(config.handler, "api/auth/session.js");
    for (const name of ["app.js", "playground.js", "server.mjs", "local-training.mjs", "local-inference.mjs", "training", ".mamase", ".env"]) {
      assert.equal(existsSync(join(isolated, name)), false, name);
    }
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import {createServer} from 'node:http';
      import {once} from 'node:events';
      import handler from './api/auth/session.js';
      import {createWorkOSProvider} from './workos-provider.mjs';
      const provider=createWorkOSProvider({apiKey:'sk_test_fixture',clientId:'client_fixture',cookiePassword:'synthetic-cookie-password-for-tests-only',redirectUri:'https://mamase.example/api/auth/callback',origin:'https://mamase.example'});
      if(new URL(provider.authorizationUrl({state:'fixture',codeChallenge:'fixture'})).searchParams.get('provider')!=='authkit') throw new Error('WorkOS SDK missing from the isolated bundle');
      const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
      try { const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/auth/session'); console.log(JSON.stringify({status:r.status,body:await r.json()})); }
      finally { await new Promise(resolve=>server.close(resolve)); }
    `], {
      cwd: isolated, encoding: "utf8",
      env: { ...process.env, WORKOS_API_KEY: "", WORKOS_CLIENT_ID: "", WORKOS_COOKIE_PASSWORD: "", WORKOS_REDIRECT_URI: "" },
    });
    const response = JSON.parse(result);
    assert.equal(response.status, 200);
    assert.equal(response.body.configured, false);
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});

test("the built hosted interface boots, explains the handoff and never calls job APIs", async () => {
  const files = new Map();
  for (const [path, [name, mime]] of publicAssets) files.set(path, [await readFile(`dist/${name}`), mime]);
  files.set("/api/training/capabilities", [await readFile("dist/training-capabilities.json"), "application/json"]);
  files.set("/api/auth/session", [JSON.stringify({ configured: false, authenticated: false, message: "WorkOS sign-in is not configured." }), "application/json"]);
  const config = JSON.parse(await readFile("vercel.json", "utf8"));
  const headers = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key, value]));
  const server = createServer((req, res) => {
    const file = files.get(req.url);
    res.writeHead(file ? 200 : 404, { ...headers, "Content-Type": file?.[1] || "text/plain" });
    res.end(file?.[0] || "Not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let browser;
  try {
    browser = await chromium.launch();
    const base = `http://127.0.0.1:${server.address().port}`;
    const workspace = createWorkspace();
    const createdAt = "2026-09-14T00:00:00.000Z";
    workspace.datasets.push({ id: "data", name: "Examples", filename: "data.jsonl", bytes: 100, records: 6, format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original", holdout: 20, sha256: "a".repeat(64), createdAt });
    workspace.runs.push(createRun({ id: "recipe", name: "Coven adapter", createdAt, recipe: { workflow: "managed", method: "lora", programId: "coven", datasetId: "data", student: "./models/local", teacher: "", rank: 4, alpha: 8, learningRate: .001, epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 128, objective: "Learn examples.", outputPath: "./outputs/local" } }, workspace));
    workspace.runs.push(recordProgress({ ...workspace.runs[0], id: "saved-job", localJobId: "job" }, { status: "running", step: 0, totalSteps: workspace.runs[0].totalSteps, loss: null, evalLoss: null, note: "Recorded locally.", recordedAt: createdAt }));
    const page = await browser.newPage();
    const errors = [], apiCalls = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("request", (request) => { if (request.url().includes("/api/")) apiCalls.push(new URL(request.url()).pathname); });
    await page.addInitScript((value) => localStorage.setItem("mamase.coven-lab.v1", JSON.stringify(value)), workspace);
    for (const theme of ["dark", "light"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of ["sessions/recipe", "sessions/saved-job", "playground", "testing", "settings"]) {
          await page.goto(`${base}/#/${path}`);
          await page.locator("#main h1").waitFor();
          if (path.startsWith("sessions/")) {
            await page.locator('#local-training-panel[data-phase="hosted"]').waitFor();
            assert.equal(await page.getByRole("button", { name: "Review & start training", exact: true }).count(), 0);
            assert.equal(await page.getByRole("button", { name: "Export workspace", exact: true }).count(), 1);
            assert.equal(await page.locator("#local-training-panel .run-warning").count(), 0);
          } else if (path === "testing") {
            await page.getByText("Model testing runs on your Mac.", { exact: true }).waitFor();
            assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true);
          } else await page.locator(path === "playground" ? "#recipe-form" : "#workspace-size").waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${theme} ${width} ${path}`);
          if (process.env.MAMASE_SCREENSHOTS && [1440, 390].includes(width)) {
            await mkdir(process.env.MAMASE_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: join(process.env.MAMASE_SCREENSHOTS, `hosted-${theme}-${width}-${path.replace("/", "-")}.png`), fullPage: true, animations: "disabled" });
          }
        }
      }
    }
    assert.ok(apiCalls.length);
    assert.ok(apiCalls.every((path) => ["/api/training/capabilities", "/api/auth/session"].includes(path)), JSON.stringify(apiCalls));
    assert.deepEqual(errors, []);
    for (const path of ["/server.mjs", "/local-inference.mjs", "/.mamase/training/owner.json", "/.env", "/training/mlx_runner.py", "/training/mlx_infer.py"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 404);
    }
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
