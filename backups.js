import { assert, date } from "./validation.js";
import { MAX_WORKSPACE_BYTES, validateWorkspace } from "./workspace.js";

export const BACKUP_SCHEMA = "mamase.workspace-backup.v1";
export const MAX_BACKUP_BYTES = MAX_WORKSPACE_BYTES + 1024;

function backupWorkspace(input) {
  const workspace = validateWorkspace(input);
  assert(new TextEncoder().encode(JSON.stringify(workspace)).length <= MAX_WORKSPACE_BYTES, "Backup workspace exceeds the 4 MB storage limit.");
  return workspace;
}

function backupTimestamp(value) {
  assert(typeof value === "string" && value.length <= 80, "Backup export timestamp must contain at most 80 characters.");
  return date(value);
}

export function exportWorkspaceBackup(workspace, exportedAt) {
  const source = JSON.stringify({
    schema: BACKUP_SCHEMA,
    exportedAt: new Date(backupTimestamp(exportedAt)).toISOString(),
    workspace: backupWorkspace(workspace),
  });
  assert(new TextEncoder().encode(source).length <= MAX_BACKUP_BYTES, "Backup exceeds the file size limit.");
  return source;
}

export function parseWorkspaceBackup(source) {
  assert(typeof source === "string" && new TextEncoder().encode(source).length <= MAX_BACKUP_BYTES, "Backup exceeds the file size limit.");
  // The engine's own wording ("Unexpected end of JSON input") is what a screen reader reads out of
  // the assertive alert when a restore fails, and it says neither what failed nor that the stored
  // workspace survived. Every other assertion here is written; this one has to be too.
  let input;
  try {
    input = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SyntaxError("Backup is not valid JSON. Select the original exported file. No changes were made.");
  }
  assert(input && typeof input === "object" && !Array.isArray(input), "Expected a workspace backup object.");
  const legacy = !Object.hasOwn(input, "schema");
  if (!legacy) {
    assert(input.schema === BACKUP_SCHEMA, "Unsupported backup schema. Keep the original file; a compatible Mamase version is required.");
    assert(Object.keys(input).every((key) => ["schema", "exportedAt", "workspace"].includes(key)), "Unsupported backup envelope fields. Keep the original file rather than downgrading it.");
  }
  return {
    workspace: backupWorkspace(legacy ? input : input.workspace),
    format: legacy ? "legacy-workspace-v1" : BACKUP_SCHEMA,
    exportedAt: legacy ? null : backupTimestamp(input.exportedAt),
    migration: legacy ? "legacy-workspace-v1-to-backup-v1" : null,
  };
}
