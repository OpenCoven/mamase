import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAppServer } from "../server.mjs";
import { createAuthApi } from "../auth-api.mjs";

test("local server serves the complete app and only public assets", async (context) => {
  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/", "/index.html", "/app.js", "/theme.js", "/ui.js", "/workspace.js", "/experience.js", "/validation.js", "/results.js", "/backups.js", "/training-state.js", "/training-guide.js", "/training-client.js", "/styles.css", "/favicon.svg"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok((await response.text()).length);
  }
  for (const path of ["/.git/config", "/README.md", "/package.json", "/server.mjs", "/local-training.mjs", "/training/evaluate.py", "/training/mlx_runner.py", "/.lab/evaluation-report.json", "/.mamase/training/owner.json", "/%2e%2e%2f.git/config", "/missing"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    await response.text();
  }
  const malformed = await fetch(`${base}/%ZZ`);
  assert.equal(malformed.status, 400);
  await malformed.text();
  const post = await fetch(base, { method: "POST" });
  assert.equal(post.status, 405);
  await post.text();
  const head = await fetch(base, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const healthy = await fetch(base);
  assert.equal(healthy.status, 200);
  await healthy.text();
});

test("the receipt module the CLI uses is also served to the browser", async (context) => {
  const server = createAppServer({ auth: createAuthApi({ env: {} }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/workflow-receipt.mjs`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.match(await response.text(), /export function workflowReceipt/);
  // Its imports must already be public, or the browser cannot load it.
  for (const dependency of ["/validation.js", "/training-state.js"]) {
    assert.equal((await fetch(base + dependency)).status, 200, dependency);
  }
});
