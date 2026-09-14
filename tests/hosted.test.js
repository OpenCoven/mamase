import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { publicAssets } from "../public-assets.mjs";
import { TrainingClient } from "../training-client.js";
import { runGuidance } from "../training-guide.js";

test("hosted builds contain only public assets and no serverless function", async () => {
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
  assert.equal(config.functions, undefined);
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
  await assert.rejects(client.launch({ workspace: { runs: [{ id: "run" }] } }), /local Mamase/);
  await assert.rejects(client.cancel("job"), /local Mamase/);
  assert.deepEqual(calls, ["capabilities"]);
});

test("hosted recipes explain the local handoff instead of offering server installation or launch", () => {
  const guide = runGuidance({ status: "planned", recipe: { workflow: "managed" } }, { hosted: true, available: false });
  assert.equal(guide.phase, "hosted");
  assert.equal(guide.action, "backup");
  assert.match(guide.description, /export|import/i);
});
