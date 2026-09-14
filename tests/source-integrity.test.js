import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("tracked source and dependency manifests have no unresolved merge conflicts", () => {
  const root = new URL("../", import.meta.url);
  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr || tracked.error?.message);
  const conflicts = tracked.stdout.split("\0")
    .filter((path) => /\.(?:[cm]?js|json|py|txt|md|ya?ml|html|css)$/.test(path))
    .filter((path) => /^(?:<{7} |>{7} )/m.test(readFileSync(new URL(path, root), "utf8")));
  assert.deepEqual(conflicts, [], `Unresolved merge conflicts: ${conflicts.join(", ")}`);
});
