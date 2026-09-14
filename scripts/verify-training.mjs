import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { LocalTrainer } from "../local-training.mjs";
import { createAppServer } from "../server.mjs";
import { STORAGE_KEY, validateWorkspace } from "../workspace.js";

const protocol = process.argv.includes("--protocol-fixture");
const keepOutput = Boolean(process.env.MAMASE_TRAINING_OUTPUT);
const root = keepOutput ? resolve(process.env.MAMASE_TRAINING_OUTPUT) : await mkdtemp(join(tmpdir(), "mamase-real-training-"));
if (keepOutput) await mkdir(root, { mode: 0o700 });
const python = protocol ? process.env.MAMASE_TEST_PYTHON || "python3" : process.env.MAMASE_PYTHON || resolve(".venv-training/bin/python");
let browser;
let server;
let trainer;
try {
  let fixture;
  if (protocol) {
    const modelPath = join(root, "model");
    const datasetPath = join(root, "examples.jsonl");
    await mkdir(modelPath);
    await writeFile(datasetPath, Array.from({ length: 8 }, (_, index) => JSON.stringify({ prompt: `Example ${index}`, response: `Answer ${index}` })).join("\n"));
    fixture = { modelPath, datasetPath };
  } else {
    fixture = JSON.parse(execFileSync(python, [resolve("training/create_smoke_fixture.py"), join(root, "fixture")], {
      encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    }).trim());
  }
  trainer = new LocalTrainer({
    root: join(root, "jobs"), python,
    ...(protocol ? { runner: resolve("tests/fixtures/training-worker.py"), probeArgs: ["-c", "print('Protocol fixture ready')"] } : {}),
  });
  server = createAppServer({ training: trainer });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  await context.addInitScript(() => {
    window.trainerMessages = [];
    const Original = window.EventSource;
    window.EventSource = class extends Original {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => window.trainerMessages.push(JSON.parse(event.data).type));
      }
    };
  });
  let page = await context.newPage();
  const errors = [];
  const watch = (page) => {
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => errors.push(error.message));
  };
  watch(page);
  await page.goto(`${base}/#/datasets`);
  await page.getByRole("button", { name: "Import JSONL", exact: true }).click();
  let modal = page.locator("#dialog");
  await modal.getByLabel("Dataset name", { exact: true }).fill("Local training diagnostic examples");
  await modal.getByLabel("JSONL file", { exact: true }).setInputFiles(fixture.datasetPath);
  await modal.getByLabel("Provenance & permission", { exact: true }).fill("Original synthetic diagnostic examples; no private data.");
  await modal.getByLabel("Holdout percentage", { exact: true }).fill("25");
  await modal.getByRole("button", { name: "Import dataset", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
  const datasetId = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).datasets[0].id, STORAGE_KEY);
  await page.goto(`${base}/#/playground`);
  assert.equal(await page.getByLabel("Base model", { exact: true }).inputValue(), "");
  assert.equal(await page.locator("#recipe-advanced").evaluate((element) => element.open), false);
  await page.getByLabel("Run name", { exact: true }).fill("Local training diagnostic");
  await page.getByLabel("Familiar ID", { exact: true }).fill("fixture");
  await page.getByLabel("Coven instance ID", { exact: true }).fill("diagnostic-coven");
  await page.getByLabel("Training objective", { exact: true }).fill("Verify real LoRA optimization and artifact registration, not model quality.");
  await page.getByLabel("Base model", { exact: true }).fill(fixture.modelPath);
  await page.getByLabel("Training dataset", { exact: true }).selectOption(datasetId);
  await page.locator("#recipe-advanced > summary").click();
  await page.getByLabel("Rank", { exact: true }).selectOption("4");
  await page.getByLabel("Alpha", { exact: true }).fill("8");
  await page.getByLabel("Learning rate", { exact: true }).fill("0.001");
  await page.getByLabel("Epochs", { exact: true }).fill("2");
  await page.getByLabel("Micro batch", { exact: true }).fill("2");
  await page.getByLabel("Gradient accumulation", { exact: true }).fill("2");
  await page.getByLabel("Max sequence length", { exact: true }).fill("128");
  await page.getByRole("button", { name: "Save recipe & review", exact: true }).click();
  await page.waitForURL(/sessions\/run-/);
  const runUrl = page.url();
  const runId = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).runs[0].id, STORAGE_KEY);
  await page.getByRole("heading", { name: "Recipe saved. Training has not started.", exact: true }).waitFor({ timeout: 45000 });
  assert.equal(await page.locator("#run-measurements").isVisible(), false);
  await page.getByRole("button", { name: "Review & start training", exact: true }).click();
  assert.equal(trainer.jobs.size, 0, "Opening review must not launch a job");
  if (protocol) {
    await modal.getByLabel("Original JSONL file", { exact: true }).setInputFiles({ name: "wrong.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from('{"prompt":"different","response":"data"}') });
    await modal.getByRole("checkbox").check();
    await modal.getByRole("button", { name: "Start training", exact: true }).click();
    await modal.locator(".form-error").getByText(/does not match/).waitFor();
    assert.equal(trainer.jobs.size, 0, "Mismatched files must leave the recipe unstarted");
  }
  await modal.getByLabel("Original JSONL file", { exact: true }).setInputFiles(fixture.datasetPath);
  await modal.getByRole("checkbox").check();
  await modal.getByRole("button", { name: "Start training", exact: true }).click();
  await modal.waitFor({ state: "hidden", timeout: 45000 });
  assert.ok((await trainer.findRun(runId)).id);

  // Reopen the run in the same browser storage: the server, not the tab, owns the job.
  await page.close();
  page = await context.newPage();
  watch(page);
  await page.goto(runUrl);
  await page.waitForFunction((key) => ["completed", "failed", "cancelled"].includes(JSON.parse(localStorage.getItem(key)).runs[0].status), STORAGE_KEY, { timeout: 180000 });
  const workspace = validateWorkspace(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY));
  const job = await trainer.findRun(runId);
  assert.equal(job.status, "completed", `${job.error}\n${job.logs.slice(-20).join("\n")}`);
  assert.equal(workspace.runs[0].localJobId, job.id);
  assert.equal(workspace.runs[0].recipe.workflow, "managed");
  assert.equal(workspace.runs[0].recipe.familiarId, "");
  assert.equal(workspace.runs[0].step, workspace.runs[0].totalSteps);
  assert.ok(workspace.runs[0].history.some((event) => Number.isFinite(event.loss)));
  if (!protocol) assert.ok(workspace.runs[0].history.some((event) => Number.isFinite(event.evalLoss)));
  assert.equal(workspace.artifacts.length, 1);
  assert.equal(workspace.artifacts[0].path, job.outputPath);
  assert.ok(await page.locator("#run-artifacts").getByRole("link", { name: /MLX adapter/ }).isVisible());
  const messages = await page.evaluate(() => window.trainerMessages);
  assert.ok(messages.includes("snapshot"));
  assert.ok(messages.includes("progress"), "Expected live progress over SSE, not only a final snapshot");
  const weights = await readFile(join(job.outputPath, "adapters.safetensors"));
  assert.ok(weights.length > 0);
  let reload = null;
  if (!protocol) {
    reload = JSON.parse(execFileSync(python, [resolve("training/smoke.py"), "--verify-adapter", fixture.modelPath, job.outputPath], {
      encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    }));
    assert.equal(reload.rank, workspace.runs[0].recipe.rank);
    assert.equal(reload.scale, workspace.runs[0].recipe.alpha / workspace.runs[0].recipe.rank);
    assert.ok(reload.maxAbsLearnedB > 0 && reload.maxAbsReloadedLogitDelta > 0);
  }
  await page.reload();
  await page.locator("#local-training-panel").waitFor();
  await page.getByRole("heading", { name: "Adapter saved. Review it next.", exact: true }).waitFor();
  assert.equal(await page.locator("#run-technical").evaluate((element) => element.open), false);
  assert.equal(await page.locator("#local-training-panel .button.primary").count(), 1);
  assert.equal(await page.locator("#external-training-guide").isVisible(), false);
  assert.match(await page.locator("#run-loss-value").innerText(), /^\d+\.\d{4}$/);
  assert.equal((await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY)).artifacts.length, 1);
  assert.deepEqual(errors, []);
  if (process.env.MAMASE_SCREENSHOTS) {
    await mkdir(process.env.MAMASE_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.MAMASE_SCREENSHOTS, protocol ? "training-protocol.png" : "training-real-mlx.png"), fullPage: true });
  }
  await page.getByRole("link", { name: "Review adapter", exact: true }).click();
  await page.getByRole("heading", { name: "Saved does not mean evaluated.", exact: true }).waitFor();
  await page.getByText(/not the complete model/).waitFor();
  await page.goto(runUrl);
  if (protocol) {
    await page.getByRole("button", { name: "Duplicate recipe", exact: true }).click();
    await page.waitForURL("**/#/playground");
    await page.getByRole("button", { name: /Train in a terminal/ }).click();
    await page.getByLabel("Familiar ID", { exact: true }).fill("diagnostic");
    await page.getByLabel("Coven instance ID", { exact: true }).fill("offline-smoke");
    await page.locator("#recipe-advanced > summary").click();
    await page.getByLabel("Adapter technique", { exact: true }).selectOption("dora");
    await page.getByRole("button", { name: "Save recipe & review", exact: true }).click();
    await page.waitForURL(/sessions\/run-/);
    await page.getByRole("heading", { name: "Recipe saved for terminal training.", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Review & start training", exact: true }).count(), 0);
    assert.equal(trainer.jobs.size, 1);
    await page.getByRole("button", { name: "Duplicate recipe", exact: true }).click();
    await page.waitForURL("**/#/playground");
    await page.getByRole("button", { name: /Train on this Mac/ }).click();
    await page.getByLabel("Run name", { exact: true }).fill("cancel");
    await page.getByRole("button", { name: "Save recipe & review", exact: true }).click();
    await page.waitForURL(/sessions\/run-/);
    await page.getByRole("button", { name: "Review & start training", exact: true }).click();
    modal = page.locator("#dialog");
    await modal.getByLabel("Original JSONL file", { exact: true }).setInputFiles(fixture.datasetPath);
    await modal.getByRole("checkbox").check();
    await modal.getByRole("button", { name: "Start training", exact: true }).click();
    await modal.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Cancel local training", exact: true }).click();
    await modal.getByRole("button", { name: "Cancel local job", exact: true }).click();
    await modal.waitFor({ state: "hidden" });
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).runs.at(-1).status === "cancelled", STORAGE_KEY);
    await page.getByRole("heading", { name: "Training was cancelled.", exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit a copy & retry", exact: true }).click();
    await page.waitForURL("**/#/playground");
    await page.getByLabel("Run name", { exact: true }).fill("failure");
    await page.getByRole("button", { name: "Save recipe & review", exact: true }).click();
    await page.waitForURL(/sessions\/run-/);
    await page.getByRole("button", { name: "Review & start training", exact: true }).click();
    await modal.getByLabel("Original JSONL file", { exact: true }).setInputFiles(fixture.datasetPath);
    await modal.getByRole("checkbox").check();
    await modal.getByRole("button", { name: "Start training", exact: true }).click();
    await modal.waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: "Training stopped with an error.", exact: true }).waitFor();
    await page.getByRole("button", { name: "Show technical details", exact: true }).click();
    assert.equal(await page.locator("#run-technical").evaluate((element) => element.open), true);
    assert.equal(await page.locator(".trainer-log").evaluate((element) => element.open), true);
    assert.equal((await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY)).artifacts.length, 1);
  }
  if (keepOutput) {
    const evidence = {
      diagnostic: true, backend: protocol ? "protocol-fixture-not-training" : "mlx-lm",
      runId, jobId: job.id, modelPath: job.modelPath, outputPath: job.outputPath,
      optimizerSteps: job.run.step, observations: job.run.history, reload,
    };
    await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "workspace.json"), JSON.stringify(workspace, null, 2), { flag: "wx", mode: 0o600 });
  }
  assert.deepEqual(errors, []);
  console.log(`${protocol ? "Protocol-fixture" : "Real MLX-LM"} training passed: saved recipe -> local process -> streamed observations -> browser reconnect -> completed run -> one registered adapter${reload ? " -> MLX-LM reload" : ""}. ${workspace.runs[0].step} optimizer steps; ${weights.length} adapter bytes.${keepOutput ? ` Output retained in ${root}` : ""}`);
} finally {
  if (browser) await browser.close();
  if (server) server.closeTrainingConnections();
  if (trainer) await trainer.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (!keepOutput) await rm(root, { recursive: true, force: true });
}
