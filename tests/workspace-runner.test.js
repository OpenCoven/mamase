import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

test("interrupting workspace verification stops and removes its owned database", { timeout: 15000, skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mamase-interruption-"));
  const bin = join(root, "bin"), temporary = join(root, "temporary"), marker = join(root, "database-running");
  await mkdir(bin); await mkdir(temporary);
  // Simulate only the PostgreSQL processes. The real wrapper and its real test child run.
  await writeFile(join(bin, "initdb"), `#!${process.execPath}\n`, { mode: 0o755 });
  await writeFile(join(bin, "pg_ctl"), `#!${process.execPath}\nconst fs=require('node:fs');const marker=${JSON.stringify(marker)};if(process.argv.at(-1)==='start')fs.writeFileSync(marker,'running');else fs.rmSync(marker,{force:true});\n`, { mode: 0o755 });
  const env = { ...process.env, MAMASE_TEST_DATABASE_URL: "", MAMASE_POSTGRES_BIN: bin, TMPDIR: temporary };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [resolve("scripts/verify-workspace.mjs")], { detached: true, env, stdio: "ignore" });
  const exited = once(child, "exit");
  t.after(async () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} await rm(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 8000;
  while (!existsSync(marker) && Date.now() < deadline) await delay(20);
  assert.ok(existsSync(marker), "The wrapper must have started its owned database before interruption");
  await delay(50);
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.ok(code !== 0 || signal, "Interrupted verification must not report success");
  assert.equal(existsSync(marker), false, "The wrapper must stop the owned PostgreSQL process");
  assert.deepEqual(await readdir(temporary), [], "The wrapper must remove its cluster directory");
});
