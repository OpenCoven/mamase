import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { assert, id, text } from "./validation.js";
import { CONTEXT_ROLES, validateFamiliarContext } from "./context-summary.js";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const canonicalContext = (value) => JSON.stringify(value, (_, item) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

export async function boundedRead(path, limit) {
  const info = await stat(path);
  assert(info.isFile(), `Expected a regular file: ${path}`);
  assert(info.size <= limit, `File exceeds ${limit} bytes: ${path}`);
  const bytes = await readFile(path);
  assert(bytes.length <= limit, `File exceeds ${limit} bytes: ${path}`);
  return bytes;
}

function exactKeys(value, keys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), `Invalid ${label} fields.`);
}

function sourcePath(path, index, role) {
  if (index < 2) {
    assert(path === ["IDENTITY.md", "SOUL.md"][index] && role === CONTEXT_ROLES[index], "Context must start with IDENTITY.md/identity then SOUL.md/soul.");
  } else {
    assert(CONTEXT_ROLES.slice(2).includes(role), "Extra sources must be role, skill or instructions.");
    assert(typeof path === "string" && path.length <= 200 &&
      /^(?:(?:ROLE|SKILL|AGENTS|INSTRUCTIONS)\.md|(?:roles|skills|instructions)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md)$/.test(path),
    "Select a familiar-owned role/skill/instructions Markdown source, not private or neighboring files.");
    assert(!/(?:memory|user|profile|secret|credential|token|session|history|private|harness)/i.test(path), "Private memory, profiles, secrets and harness sources are excluded.");
  }
}

function metadata(content, label) {
  const pattern = new RegExp(`^[ \\t\\ufeff]*(?:-[ \\t]*)?(?:\\*\\*)?${label}:(?:\\*\\*)?[ \\t]*([^\\r\\n]*?)[ \\t]*\\r?$`, "gmi");
  const values = [...content.matchAll(pattern)].map((match) => match[1].trim());
  assert(values.length <= 1, `Duplicate structured ${label} metadata in context source.`);
  return values[0];
}

export function composeContext(binding, sources) {
  return `Coven instance: ${binding.instanceId}\nFamiliar ID: ${binding.familiarId}\nLane: ${binding.lane}\nRole: ${binding.role}\nContext coverage: selected-sources\n\n` +
    sources.map((source, index) => `[${binding.sources[index].role}: ${source.path}]\n${source.content}`).join("\n\n");
}

export async function inspectContext({ contextManifestPath, identityDir, recipe }) {
  assert(recipe && typeof recipe === "object", "Context inspection requires the exported recipe binding.");
  const directory = await realpath(resolve(identityDir));
  assert(basename(directory) === recipe.familiarId, "Familiar ID must match the selected workspace directory name.");
  const path = await realpath(resolve(contextManifestPath));
  const bytes = await boundedRead(path, 16 * 1024);
  const selection = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  exactKeys(selection, ["schema", "familiarId", "instanceId", "lane", "role", "coverage", "sources"], "context selection");
  assert(selection.schema === "mamase.context-selection.v1" && selection.coverage === "selected-sources", "Unsupported context selection schema or coverage; full runtime parity is not claimed.");
  for (const key of ["familiarId", "instanceId"]) assert(id(selection[key]) === recipe[key], `Context ${key} does not match this recipe.`);
  id(selection.lane);
  assert(text(selection.role, "Declared role", 200) === selection.role && selection.role.isWellFormed() &&
    !/[\u0000-\u001f\u007f]/u.test(selection.role), "Context role must be normalized, well-formed single-line text.");
  assert(Array.isArray(selection.sources) && selection.sources.length >= 2 && selection.sources.length <= 16, "Select 2-16 ordered context sources.");
  const sources = [], inventory = [], paths = new Set();
  let total = 0;
  for (const [index, source] of selection.sources.entries()) {
    exactKeys(source, ["path", "role"], "context source");
    sourcePath(source.path, index, source.role);
    assert(!paths.has(source.path), "Duplicate context source path.");
    paths.add(source.path);
    const candidate = resolve(directory, source.path);
    assert(await realpath(candidate) === candidate, "Context sources must belong to the selected familiar without symlinks.");
    const raw = await boundedRead(candidate, 128 * 1024);
    total += raw.length;
    assert(total <= 512 * 1024, "Combined context exceeds 512 KiB; select fewer or shorter sources.");
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    assert(content.trim(), `Empty context source: ${source.path}`);
    for (const [label, expected] of [["Role", selection.role], ["Lane", selection.lane], ["Familiar ID", selection.familiarId], ["Instance ID", selection.instanceId]]) {
      const declared = metadata(content, label);
      assert(declared === undefined || declared === expected, `Structured ${label} in ${source.path} contradicts the context selection.`);
    }
    if (index === 0) {
      const name = metadata(content, "Name");
      assert(name && name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") === recipe.familiarId.toLowerCase(), "Structured Name contradicts the familiar binding.");
    }
    sources.push({ path: source.path, content });
    inventory.push({ ...source, sha256: sha256(raw) });
  }
  const binding = {
    schema: "mamase.context-binding.v1", familiarId: selection.familiarId, instanceId: selection.instanceId,
    lane: selection.lane, role: selection.role, coverage: selection.coverage,
    composition: "ordered-sections-v1", sources: inventory,
  };
  const prompt = composeContext(binding, sources);
  binding.promptSha256 = sha256(prompt);
  const familiarContext = validateFamiliarContext({
    schema: "mamase.familiar-context-summary.v1", sha256: sha256(canonicalContext(binding)), scope: binding.coverage,
    familiarId: binding.familiarId, instanceId: binding.instanceId, lane: binding.lane, role: binding.role,
    promptSha256: binding.promptSha256, sourceRoles: inventory.map((source) => source.role),
  }, recipe);
  return {
    prompt, familiarContext,
    snapshot: { schema: "mamase.familiar-context.v1", selection: { path, sha256: sha256(bytes) }, binding, sources },
    preview: { familiarContext, sources: inventory, interpretation: "Review these roles and this order; confirm with --context-sha256. Raw sources remain local. Selected coverage is provenance, not authenticated identity, full runtime parity or permission to train/promote." },
  };
}
