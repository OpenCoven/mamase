# Evaluation evidence (PEFT lane)

```bash
.venv/bin/python training/evaluate.py --bundle .lab/experiment --suite suite.json \
  --history journal.json --task-lineage lineage.json --out .lab/experiment-eval --device cpu
npm run ops -- import-evaluation --workspace ... --expected-revision <sha256> --file .lab/experiment-eval/evaluation-report.json
```

`evaluate.py` reads `result.json` and `run-report.json` from the bundle and
requires a new `--out` directory; it writes `evaluation-report.json` there
(`mamase.evaluation-report.v1`): ≥ 4 cases with unique prompts
across `task`, `identity`, `consent` and `tool-boundary`, paired base/adapter
responses, `resultSha256` binding it to the imported result and `bundleSha256` to
the bundle. The importer refuses reports for unknown results, mismatched bundles or
duplicate prompts — do not edit a report to satisfy it; regenerate it from the
right inputs.

## Independence depends on two optional flags

`--history` (a shared exposure journal) and `--task-lineage` (a declared training
inventory) are optional to the parser but decisive for governance. A
`mamase.eval-suite.v2` suite reports
`governance.independence: "mechanically-eligible"` only when both are supplied and
every declaration is complete — the suite history and journal are
`complete-declared`, lineage coverage is `complete-declared`, the suite is `final`,
reviewed and not synthetic, and no family overlaps a recorded exposure. Omit either
flag and the report is pinned to `"unverified"` with
`governance.journalStatus: "unavailable"`, which is the weakest evidence the lane
can produce. Omitting them is a valid choice; doing so unknowingly is not.

Eligibility is an unauthenticated declaration check, never proof of independence.
A `mamase.eval-suite.v1` suite is always `"unverified"` (`legacy-development`).

After import, `receipt` shows `evaluate: done` with `reportSha256`, `suiteSha256`
and the `regressions` count, and `nextAction.step: "human-review"`
(`state: "awaiting-human-review"`).

## What you may say about it

- Counts, fingerprints, pass/fail per category, regression count, the decoding
  settings and device: yes.
- "The adapter is better", "ready to ship", "identity is preserved": no. Those are
  human judgments recorded in the UI. Phrase yours as a recommendation with the
  evidence IDs it rests on and its limitations (synthetic suite, tiny model, CPU,
  identity-files-only scope, etc.).
- Case prompts and responses: only with an explicit request naming the report and
  scope, and never copied into receipts, backups, commits or engineering logs.

Suites are content, too. A changed suite (`suite.sha256`) is a different
evaluation, not a re-run of the same one.
