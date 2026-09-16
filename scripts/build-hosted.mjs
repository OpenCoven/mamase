import assert from "node:assert/strict";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { publicAssets } from "../public-assets.mjs";
import { execFileSync } from "node:child_process";

const project = fileURLToPath(new URL("../", import.meta.url));
const output = join(project, "dist");
const authActions = ["login", "callback", "session", "logout"];
const assets = new Map();
for (const name of new Set([...publicAssets.values()].map(([name]) => name))) {
  const source = join(project, name);
  const info = await lstat(source);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Public asset must be a regular file: ${name}`);
  let content = await readFile(source);
  if (name.endsWith(".js")) execFileSync(process.execPath, ["--check", "--input-type=module"], { input: content, stdio: "pipe" });
  if (name === "index.html") {
    const html = content.toString("utf8");
    const marker = 'name="mamase-runtime" content="local"';
    assert.ok(html.includes(marker), "Missing runtime marker in index.html");
    content = Buffer.from(html.replace(marker, 'name="mamase-runtime" content="hosted"'));
  }
  assets.set(name, content);
}
const authSources = new Map();
for (const name of ["auth-api.mjs", "access-list.mjs", "workos-provider.mjs", ...authActions.map((action) => `api/auth/${action}.js`)]) {
  const source = join(project, name);
  const info = await lstat(source);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Auth source must be a regular file: ${name}`);
  const content = await readFile(source);
  execFileSync(process.execPath, ["--check", "--input-type=module"], { input: content, stdio: "pipe" });
  authSources.set(name, content);
}
await rm(output, { recursive: true, force: true });
await mkdir(output);
for (const [name, content] of assets) await writeFile(join(output, name), content);
await writeFile(join(output, "training-capabilities.json"), JSON.stringify({
  enabled: false, available: false, hosted: true, backend: null,
  message: "This hosted workspace cannot run or monitor local training. Run Mamase on your Mac and use workspace export/import to move your saved recipes.",
}));

if (process.argv.includes("--prebuilt")) {
  const prebuilt = join(project, ".vercel/output");
  await rm(prebuilt, { recursive: true, force: true });
  await mkdir(prebuilt, { recursive: true });
  await cp(output, join(prebuilt, "static"), { recursive: true });
  const dependencies = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: project, encoding: "utf8" })
    .trim().split("\n").filter((path) => path && relative(project, path));
  for (const dependency of dependencies) {
    assert.ok(dependency.startsWith(join(project, "node_modules") + sep), "Runtime dependency must be inside node_modules.");
    assert.ok(!(await lstat(dependency)).isSymbolicLink(), "Runtime dependencies cannot be linked outside the release.");
  }
  for (const action of authActions) {
    const bundle = join(prebuilt, "functions/api/auth", `${action}.func`);
    const entry = `api/auth/${action}.js`;
    await mkdir(join(bundle, "api/auth"), { recursive: true });
    await writeFile(join(bundle, entry), authSources.get(entry));
    await writeFile(join(bundle, "auth-api.mjs"), authSources.get("auth-api.mjs"));
    await writeFile(join(bundle, "access-list.mjs"), authSources.get("access-list.mjs"));
    await writeFile(join(bundle, "workos-provider.mjs"), authSources.get("workos-provider.mjs"));
    await writeFile(join(bundle, "package.json"), JSON.stringify({ type: "module" }));
    for (const dependency of dependencies) {
      await cp(dependency, join(bundle, relative(project, dependency)), { recursive: true });
    }
    await writeFile(join(bundle, ".vc-config.json"), JSON.stringify({
      runtime: "nodejs24.x", handler: entry, launcherType: "Nodejs", maxDuration: 30,
    }));
  }
  const config = JSON.parse(await readFile(join(project, "vercel.json"), "utf8"));
  await writeFile(join(prebuilt, "config.json"), JSON.stringify({
    version: 3,
    routes: [
      ...config.headers.map((rule) => ({ src: rule.source, headers: Object.fromEntries(rule.headers.map(({ key, value }) => [key, value])), continue: true })),
      ...config.rewrites.map(({ source, destination }) => ({ src: source, dest: destination })),
      { handle: "filesystem" },
    ],
  }, null, 2));
}
console.log("Hosted build created: public browser assets and isolated account functions; no local trainer or model files.");
