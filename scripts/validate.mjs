import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (!["node", "cpu", "browser", "all"].includes(mode) || process.argv.length !== 3) {
  console.error("Usage: npm run validate -- node|cpu|browser|all");
  process.exit(1);
}
const outputRoot = join(root, ".validation");
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
const output = mkdtempSync(join(outputRoot, "run-"));
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" });
const jobs = mode === "all" ? ["node-22", "node-24", "cpu", "browser"] : [mode === "node" ? `node-${process.versions.node.split(".")[0]}` : mode];
const evidence = {
  schema: "mamase.local-validation.v1", source: "local-command-execution",
  commit: revision.status === 0 ? revision.stdout.trim() : null,
  dirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null,
  startedAt: new Date().toISOString(), status: "running",
  limitations: ["Not hosted approval or a branch-protection status", "CPU synthetic fixtures are not model-quality evidence",
    "CUDA/QLoRA, MPS, MLX and full-size models not executed", "Human keyboard-only and screen-reader review not executed"],
  jobs: jobs.map((name) => ({ name, status: "not-run", steps: [] })),
};
const save = () => writeFileSync(join(output, "summary.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
save();

// Do not inherit provider credentials, Node preload hooks, Python paths or private output overrides.
const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "PLAYWRIGHT_BROWSERS_PATH"]
  .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
Object.assign(env, {
  PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1",
  CUDA_VISIBLE_DEVICES: "", OMP_NUM_THREADS: "1", TOKENIZERS_PARALLELISM: "false", NO_COLOR: "1",
});
const python = process.env.MAMASE_TRAINING_PYTHON || resolve(root, ".venv/bin/python");
if (process.env.MAMASE_TEST_PYTHON) env.MAMASE_TEST_PYTHON = process.env.MAMASE_TEST_PYTHON;

function run(job, executable, args, label, extra = {}, requireNoSkips = false) {
  const step = { command: label, status: "running" };
  job.steps.push(step);
  save();
  console.log(`\n[${job.name}] ${label}`);
  const started = Date.now();
  const result = spawnSync(executable, args, {
    cwd: root, encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...env, ...extra },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  step.durationMs = Date.now() - started;
  step.exitCode = result.status;
  step.signal = result.signal;
  step.errorCode = result.error?.code || null;
  const summary = Object.fromEntries([...result.stdout?.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm) || []]
    .map(([, key, count]) => [key, Number(count)]));
  if (Object.keys(summary).length) step.counts = summary;
  step.status = result.status === 0 && (!requireNoSkips || summary.skipped === 0 && summary.tests > 0) ? "passed" : "failed";
  save();
  if (step.status !== "passed") throw new Error(`${job.name}: ${label} failed${requireNoSkips ? " (CPU requires a nonempty test run with zero skips)" : ""}${result.error ? `: ${result.error.code}` : ""}.`);
  return result.stdout.trim();
}

try {
  for (const job of evidence.jobs) {
    job.status = "running";
    const major = job.name.startsWith("node-") ? Number(job.name.slice(5))
      : mode === "all" ? 24 : Number(process.versions.node.split(".")[0]);
    const node = mode === "all" ? process.env[`MAMASE_NODE_${major}`] : process.execPath;
    if (!node) throw new Error(`Set MAMASE_NODE_${major} to an installed Node ${major} executable. Unrun jobs are not passing.`);
    const version = run(job, node, ["--version"], `node ${major} --version`);
    if (version.length > 32 || !new RegExp(`^v${major}\\.\\d+\\.\\d+$`).test(version) || ![22, 24].includes(major)) {
      throw new Error(`Expected a supported Node ${major} version; executable reported a different or invalid version.`);
    }
    job.nodeVersion = version;
    const nodeEnv = { PATH: `${dirname(resolve(node))}${delimiter}${env.PATH || ""}` };
    if (job.name.startsWith("node-")) {
      run(job, node, ["--test", "--test-concurrency=1", "--test-reporter=tap"], "node --test --test-concurrency=1 --test-reporter=tap (explicit Node-only mode)",
        { ...nodeEnv, MAMASE_SKIP_ML: "1" });
    } else if (job.name === "cpu") {
      const mlEnv = { ...nodeEnv, MAMASE_TRAINING_PYTHON: python, MAMASE_REQUIRE_ML: "1" };
      run(job, python, ["-B", "scripts/check-training-env.py"], "selected Python -B scripts/check-training-env.py", mlEnv);
      job.pythonVersion = "3.14.7";
      run(job, node, ["--test", "--test-concurrency=1", "--test-reporter=tap", "tests/lab.test.js", "tests/evaluation.test.js", "tests/preflight.test.js"],
        "node --test --test-concurrency=1 --test-reporter=tap tests/lab.test.js tests/evaluation.test.js tests/preflight.test.js (required ML)", mlEnv, true);
    } else {
      run(job, node, ["scripts/verify-ux.mjs"], "node scripts/verify-ux.mjs",
        { ...nodeEnv, MAMASE_UX_EVIDENCE: join(output, "browser") });
      run(job, node, ["scripts/verify-training.mjs", "--protocol-fixture"],
        "node scripts/verify-training.mjs --protocol-fixture (not MLX)", nodeEnv);
    }
    job.status = "passed";
    save();
  }
  evidence.status = "passed";
} catch (error) {
  for (const job of evidence.jobs) if (job.status === "running") job.status = "failed";
  evidence.status = "failed";
  console.error(error.message);
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  save();
  console.log(`Bounded execution summary: ${join(output, "summary.json")}`);
}
