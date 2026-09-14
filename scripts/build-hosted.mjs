import assert from "node:assert/strict";
import { copyFile, cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { publicAssets } from "../public-assets.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const output = join(project, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output);
for (const name of new Set([...publicAssets.values()].map(([name]) => name))) {
  const source = join(project, name);
  const info = await lstat(source);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Public asset must be a regular file: ${name}`);
  if (name === "index.html") {
    const html = await readFile(source, "utf8");
    const marker = 'name="mamase-runtime" content="local"';
    assert.ok(html.includes(marker), "Missing runtime marker in index.html");
    await writeFile(join(output, name), html.replace(marker, 'name="mamase-runtime" content="hosted"'));
  } else await copyFile(source, join(output, name));
}
await writeFile(join(output, "training-capabilities.json"), JSON.stringify({
  enabled: false, available: false, hosted: true, backend: null,
  message: "This hosted workspace cannot run or monitor local training. Run Mamase on your Mac and use workspace export/import to move your saved recipes.",
}));

if (process.argv.includes("--prebuilt")) {
  const prebuilt = join(project, ".vercel/output");
  await rm(prebuilt, { recursive: true, force: true });
  await mkdir(prebuilt, { recursive: true });
  await cp(output, join(prebuilt, "static"), { recursive: true });
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
console.log("Hosted build created: public browser assets only; no serverless functions or training files.");
