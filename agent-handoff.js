const SAFE = (value, limit = 120) =>
  String(value ?? "").replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);

/** A dated, single-segment filename so repeated handoffs stay distinguishable. */
export function handoffFilename(date) {
  return `coven-workspace-${new Date(date).toISOString().slice(0, 10)}.json`;
}

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
  const file = SAFE(filename, 200) || "coven-workspace.json";
  const id = SAFE(run?.id, 80);
  const name = SAFE(run?.name, 120);
  const path = `~/Downloads/${file}`;
  const lines = [
    "Use the mamase skill in this repo (skills/mamase/SKILL.md).",
    "",
    `Workspace : ${path}  (wherever your browser saved it)`,
    `Run       : ${id}${name ? ` "${name}"` : ""}`,
    `Lane      : ${SAFE(lane, 40)}`,
    "",
    "Start here:",
    `  npm run ops -- inspect --workspace ${path}`,
    `  npm run ops -- receipt --workspace ${path} --run ${id}`,
    "",
  ];
  if (lane === "unselected") {
    lines.push(
      "This run's lane is not selected, so there is no next action yet.",
      "Report what the receipt says is missing. Do not choose the lane for me.",
    );
  } else {
    lines.push(
      "Do exactly the receipt's nextAction, or report its blockers.",
      "Do not run training/train.py without my explicit go-ahead for this run.",
    );
  }
  return lines.join("\n");
}
