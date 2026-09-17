import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";

// Use only an explicitly selected test database, or an isolated disposable local cluster.
let connectionString = process.env.MAMASE_TEST_DATABASE_URL;
let directory, pgctl, child, killTimer;
let interrupted = 0;
const stopChild = (signal) => {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== "ESRCH") throw error; }
};
const interrupt = (signal) => {
  if (interrupted) return;
  interrupted = signal === "SIGINT" ? 130 : 143;
  stopChild("SIGTERM");
  killTimer = setTimeout(() => stopChild("SIGKILL"), 5000);
  killTimer.unref();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
// PostgreSQL on macOS must not initialize the system locale after starting threads.
const pgEnv = { ...process.env, LC_ALL: "C" };
try {
  if (!connectionString) {
    const bindir = process.env.MAMASE_POSTGRES_BIN || execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
    directory = await mkdtemp(join(tmpdir(), "mamase-postgres-"));
    pgctl = join(bindir, "pg_ctl");
    if (interrupted) throw new Error("Interrupted");
    execFileSync(join(bindir, "initdb"), ["-D", join(directory, "data"), "-U", "mamase_test", "--auth=trust", "--no-locale", "-E", "UTF8"], { stdio: "pipe", env: pgEnv });
    const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    execFileSync(pgctl, ["-D", join(directory, "data"), "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "start"], { stdio: "pipe", env: pgEnv });
    connectionString = `postgresql://mamase_test@127.0.0.1:${port}/postgres`;
  }
  if (interrupted) throw new Error("Interrupted");
  child = spawn(process.execPath, ["--test", "--test-concurrency=1", "tests/workspace-store.test.js", "tests/workspace-api.test.js", "tests/workspace-client.test.js", "tests/workspace-browser.test.js"], {
    detached: process.platform !== "win32", stdio: "inherit", env: { ...process.env, MAMASE_TEST_DATABASE_URL: connectionString },
  });
  const [code] = await once(child, "exit");
  process.exitCode = interrupted || (code ?? 1);
} catch (error) {
  // Do not print provider URLs or connection errors containing credentials.
  if (!interrupted && directory && error.stderr) console.error(String(error.stderr).slice(0, 2000));
  if (!interrupted && directory) console.error((await readFile(join(directory, "postgres.log"), "utf8").catch(() => "")).slice(-2000));
  if (!interrupted) console.error(`Workspace verification could not run (${error.code || error.name}). Install PostgreSQL or set MAMASE_TEST_DATABASE_URL to a disposable test database.`);
  process.exitCode = interrupted || 1;
} finally {
  clearTimeout(killTimer);
  if (interrupted) stopChild("SIGKILL");
  if (directory) {
    try { execFileSync(pgctl, ["-D", join(directory, "data"), "-m", "immediate", "-w", "stop"], { stdio: "pipe", env: pgEnv }); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
  if (interrupted) process.exitCode = interrupted;
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
