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
const root = await mkdtemp(join(tmpdir(), "mamase-real-training-"));
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
  await modal.getByRole("button", { name: "Import dataset", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
  const datasetId = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).datasets[0].id, STORAGE_KEY);
  await page.goto(`${base}/#/playground`);
  await page.getByLabel("Run name", { exact: true }).fill("Local training diagnostic");
  await page.getByLabel("Training objective", { exact: true }).fill("Verify real LoRA optimization and artifact registration, not model quality.");
  await page.getByLabel("Base model", { exact: true }).fill(fixture.modelPath);
  await page.getByLabel("Training dataset", { exact: true }).selectOption(datasetId);
  await page.getByLabel("Rank", { exact: true }).selectOption("4");
  await page.getByLabel("Alpha", { exact: true }).fill("8");
  await page.getByLabel("Learning rate", { exact: true }).fill("0.001");
  await page.getByLabel("Epochs", { exact: true }).fill("2");
  await page.getByLabel("Micro batch", { exact: true }).fill("2");
  await page.getByLabel("Gradient accumulation", { exact: true }).fill("2");
  await page.getByLabel("Max sequence length", { exact: true }).fill("128");
  await page.getByRole("button", { name: "Save planned run", exact: true }).click();
  await page.waitForURL(/sessions\/run-/);
  const runUrl = page.url();
  const runId = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).runs[0].id, STORAGE_KEY);
  await page.getByRole("button", { name: "Launch local training", exact: true }).click({ timeout: 45000 });
  await modal.getByLabel("Original JSONL file", { exact: true }).setInputFiles(fixture.datasetPath);
  await modal.getByRole("checkbox").check();
  await modal.getByRole("button", { name: "Launch local job", exact: true }).click();
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
  if (!protocol) {
    const headerSize = Number(weights.readBigUInt64LE());
    assert.ok(Number.isSafeInteger(headerSize) && headerSize > 0 && headerSize < weights.length - 8);
    const header = JSON.parse(weights.subarray(8, 8 + headerSize).toString());
    const learned = Object.entries(header).filter(([key]) => key.toLowerCase().endsWith("lora_b"));
    assert.ok(learned.length > 0, "Expected real LoRA B tensors");
    assert.ok(learned.some(([, tensor]) => {
      const data = weights.subarray(8 + headerSize + tensor.data_offsets[0], 8 + headerSize + tensor.data_offsets[1]);
      assert.ok(tensor.shape.includes(4), "Saved adapter rank must match the recipe");
      if (tensor.dtype === "F32") {
        for (let offset = 0; offset < data.length; offset += 4) {
          const value = data.readFloatLE(offset);
          assert.ok(Number.isFinite(value), "Adapter contains nonfinite weights");
          if (value !== 0) return true;
        }
      } else if (["F16", "BF16"].includes(tensor.dtype)) {
        for (let offset = 0; offset < data.length; offset += 2) {
          const bits = data.readUInt16LE(offset) & 0x7fff;
          assert.ok(tensor.dtype === "F16" ? (bits & 0x7c00) !== 0x7c00 : (bits & 0x7f80) !== 0x7f80, "Adapter contains nonfinite weights");
          if (bits !== 0) return true;
        }
      } else throw new Error(`Unsupported diagnostic tensor dtype: ${tensor.dtype}`);
      return false;
    }), "LoRA B tensors must change from their zero initialization");
  }
  await page.reload();
  await page.locator("#local-training-panel").waitFor();
  assert.equal((await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY)).artifacts.length, 1);
  assert.deepEqual(errors, []);
  if (process.env.MAMASE_SCREENSHOTS) {
    await mkdir(process.env.MAMASE_SCREENSHOTS, { recursive: true });
    await page.locator(".trainer-log summary").click();
    await page.screenshot({ path: join(process.env.MAMASE_SCREENSHOTS, protocol ? "training-protocol.png" : "training-real-mlx.png"), fullPage: true });
  }
  console.log(`${protocol ? "Protocol-fixture" : "Real MLX-LM"} training passed: saved recipe -> local process -> streamed observations -> browser reconnect -> completed run -> one registered adapter. ${workspace.runs[0].step} optimizer steps; ${weights.length} adapter bytes.`);
} finally {
  if (browser) await browser.close();
  if (server) server.closeTrainingConnections();
  if (trainer) await trainer.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
