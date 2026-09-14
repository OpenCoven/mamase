import { assert, digest, id, text, number } from "./validation.js";

export const CONTEXT_ROLES = ["identity", "soul", "role", "skill", "instructions"];
const keys = ["schema", "sha256", "scope", "familiarId", "instanceId", "lane", "role", "promptSha256", "sourceRoles"];

export function validateFamiliarContext(input, familiar) {
  assert(input && typeof input === "object" && !Array.isArray(input), "Familiar context summary is required.");
  assert(Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key)), "Unsupported familiar context fields; private sources do not belong in summaries.");
  assert(input.schema === "mamase.familiar-context-summary.v1" && input.scope === "selected-sources", "Unsupported familiar context scope or schema.");
  assert(Array.isArray(input.sourceRoles), "Context source roles are required.");
  number(input.sourceRoles.length, "Context source count", 2, 16, true);
  assert(input.sourceRoles[0] === "identity" && input.sourceRoles[1] === "soul" &&
    input.sourceRoles.slice(2).every((role) => CONTEXT_ROLES.slice(2).includes(role)), "Invalid ordered context source roles.");
  const result = {
    schema: input.schema, sha256: digest(input.sha256, "Familiar context"), scope: input.scope,
    familiarId: id(input.familiarId), instanceId: id(input.instanceId), lane: id(input.lane),
    role: text(input.role, "Declared familiar role", 200), promptSha256: digest(input.promptSha256, "Composed prompt"),
    sourceRoles: [...input.sourceRoles],
  };
  assert(result.role === input.role && input.role.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(input.role), "Context role must be normalized, well-formed single-line text.");
  if (familiar) for (const key of ["familiarId", "instanceId"]) assert(result[key] === familiar[key], `Context ${key} does not match the familiar binding.`);
  return result;
}

export function sameFamiliarContext(first, second) {
  if (!first || !second) return first === undefined && second === undefined;
  const left = validateFamiliarContext(first);
  const right = validateFamiliarContext(second);
  return keys.every((key) => key === "sourceRoles" ? left[key].join("\n") === right[key].join("\n") : left[key] === right[key]);
}

export function familiarContextLabel(lineage) {
  if (!lineage) return "Unbound context";
  if (!lineage.familiarContext) return "Legacy identity-files-only";
  const context = validateFamiliarContext(lineage.familiarContext, lineage);
  return `Selected sources (${context.sourceRoles.length}) \u00b7 ${context.lane} \u00b7 ${context.role} \u00b7 ${context.sha256}`;
}
