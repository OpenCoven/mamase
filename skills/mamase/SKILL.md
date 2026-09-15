---
name: mamase
description: Operate the Mamase familiar-training lab end to end from a terminal — plan runs, prepare PEFT bundles, reconcile managed MLX jobs, import evidence and hand off to a human — using only the repository's versioned `npm run ops`, `npm run lab` and `training/*.py` commands. Use for Mamase workspaces, recipes, receipts, adapters and evaluation evidence. Do not use for unrelated application coding or generic model advice.
---

# Mamase workflow skill

You are operating an existing lab, not designing one. Every deterministic step
has a shared command that runs the same domain validators as the browser. Never
reconstruct workspace JSON by hand, edit `localStorage`, or bypass validation with
inline scripts. The state of the world is what the files and receipts say.

## Discover before acting

1. `npm run ops -- catalog` — read `schema` (`mamase.operation-catalog.v1`),
   `workspaceFileSchema`, `workflowReceiptSchema` and `exitCodes`. If a schema
   you rely on is missing or a version differs from these references, stop and
   report the mismatch instead of guessing.
2. `npm run ops -- inspect --workspace <file>` — the current `revision.after` is
   required by every mutating operation as `--expected-revision`. Re-inspect
   after each write; stale revisions exit `2` without writing.
3. `npm run ops -- receipt --workspace <file> --run <runId> [--bundle <dir>] [--server http://127.0.0.1:PORT]`
   — the receipt names the **lane**, executed steps, typed `blockers` and the one
   `nextAction`. Do exactly that action or surface the blocker. `nextAction: null`
   with blockers means stop and report.

Exit codes: `0` changed/unchanged, `2` blocked (state conflict — report, do not
retry blindly), `1` failed (bad input — fix the input). Every response is one
JSON receipt with a stable `code` on errors.

## Route by phase

| Phase | Reference | Starts training? |
|---|---|---|
| Workspace, datasets, planning | [references/planning.md](references/planning.md) | Never |
| PEFT lane (CPU/CUDA, `training/*.py`) | [references/peft.md](references/peft.md) | Only `train.py`, only with explicit approval |
| Managed MLX lane (Train on this Mac) | [references/managed-mlx.md](references/managed-mlx.md) | Never from the skill; launch is a browser action |
| Evaluation evidence | [references/evaluation.md](references/evaluation.md) | Never |
| Human handoff | [references/human-handoff.md](references/human-handoff.md) | Never |
| Recovery | [references/recovery.md](references/recovery.md) | Never |

The receipt's `lane` decides the reference: `peft`, `managed-mlx`, or
`unselected` (bind a familiar and instance or set `workflow` first).

## Non-negotiable boundaries

- **Planning never trains.** `create-recipe`, `export-recipe`, `lab prepare`,
  `preflight.py` and `receipt` are inert. Training is `train.py` (PEFT, needs the
  user's explicit go-ahead for this run) or a browser-launched managed job.
- **Blockers are explicit.** Missing runtime, model files, bundle, permissions or
  context confirmation surface as receipt `blockers` (the `receipt` command itself
  exits `0` — read `state` and `blockers`, never the exit code), as `preflight.py`
  / `lab prepare` exit `1` with JSON errors, or as mutating-operation exit `2`
  conflicts. Never work around one by relaunching, resetting or editing state.
- **Two lanes, two kinds of evidence.** PEFT results carry `bundleSha256` lineage
  and paired evaluation reports; managed MLX jobs carry a `job-…` ID and an
  `artifact-job-…` adapter with no paired evaluation. Do not merge or compare them
  as one attempt. `familiarContext.scope` (`identity-files-only` vs
  `selected-sources`) is part of the evidence; keep it in every summary.
- **Your judgment is a recommendation.** Only a human records a review decision
  in the Mamase UI. Never write a review, call evidence "approved", grant tools,
  replace an identity or deploy an adapter. `evidence-ready` means ready for a
  human, nothing more. This one is convention, not enforcement: the importer
  checks a decision's shape and its binding to exact evidence, but nothing
  attests that a human authored it, and a decision you fabricate is
  indistinguishable from a recorded one. The boundary holds only because you
  keep it.
- **Private text stays private.** Case prompts, responses and familiar sources are
  read only when the user names the file and scope. Receipts, backups, commit
  messages and logs carry fingerprints, IDs and counts — never the text.
- **History is append-only.** Recovery reuses stable IDs and recorded job IDs; it
  never resets progress journals, deletes conflicting records or repeats training
  to make a result look successful.

## Harness discovery

This directory is the canonical copy. Point your harness at it rather than
copying: Claude Code / Copilot CLI style loaders accept a `skills/` directory or a
symlink to `skills/mamase`; Agent-Skills-compatible registries can reference
`skills/mamase/SKILL.md` directly. Contracts are verified by
`tests/skill.test.js`, which fails if these references drift from the catalog.
