// Strips control characters (C0, DEL, C1) and bidi-override codepoints, then
// collapses whitespace to one line. This exists because a run name is
// attacker-controlled free text: without it, a run name could inject a line
// break to forge its own `Lane      :` line, or append a bogus command under
// `Start here:`. Slicing happens before the final trim so a value cut off
// mid-run of whitespace never leaves a trailing space in the result.
const oneLine = (value, limit = 120) =>
  String(value ?? "")
    .replace(/[\x00-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, limit)
    .trim();

/** A dated, single-segment filename so repeated handoffs stay distinguishable. */
export function handoffFilename(date) {
  return `coven-workspace-${new Date(date).toISOString().slice(0, 10)}.json`;
}

// The two lanes that mean there is real training work to hand off, mirrored
// from workflow-receipt.mjs's LANES ("peft", "managed-mlx", "unselected")
// without importing it, so this module stays dependency-free. Anything else
// -- "unselected", unknown, empty or missing -- takes the cautious branch:
// the training branch is the exception, not the default.
const ACTION_LANES = ["peft", "managed-mlx"];

/**
 * The prompt an operator hands to an agent. It names the exported workspace,
 * the run and the lane, and points at the repository's own skill.
 *
 * It carries no workspace contents, no dataset names and no local training
 * command token: workflow-receipt.mjs already forbids copying the token into a
 * receipt, and the same rule applies here. Extra caller arguments are ignored
 * by construction — only the three fields below are read.
 */
export function agentPrompt({ filename, run, lane }) {
  const file = oneLine(filename, 200) || "coven-workspace.json";
  const id = oneLine(run?.id, 80) || "MISSING-RUN-ID";
  const name = oneLine(run?.name, 120);
  const cleanLane = oneLine(lane, 40);
  const path = `~/Downloads/${file}`;
  const lines = [
    "Use the mamase skill in this repo (skills/mamase/SKILL.md).",
    "",
    `Workspace : ${path}  (wherever your browser saved it)`,
    `Run       : ${id}${name ? ` "${name}"` : ""}`,
    `Lane      : ${cleanLane}`,
    "",
    "Start here:",
    `  npm run ops -- inspect --workspace "${path}"`,
    `  npm run ops -- receipt --workspace "${path}" --run ${id}`,
    "",
  ];
  if (ACTION_LANES.includes(cleanLane)) {
    lines.push(
      "Do exactly the receipt's nextAction, or report its blockers.",
      "Do not run training/train.py without my explicit go-ahead for this run.",
    );
  } else {
    lines.push(
      "This run's lane is not selected, so there is no next action yet.",
      "Report what the receipt says is missing. Do not choose the lane for me.",
    );
  }
  return lines.join("\n");
}
