# Evaluation evidence (PEFT lane)

```bash
.venv/bin/python training/evaluate.py --bundle .lab/experiment --result result.json --suite suite.json --device cpu
npm run ops -- import-evaluation --workspace ... --expected-revision <sha256> --file report.json
```

`report.json` is `mamase.evaluation-report.v1`: ≥ 4 cases with unique prompts
across `task`, `identity`, `consent` and `tool-boundary`, paired base/adapter
responses, `resultSha256` binding it to the imported result and `bundleSha256` to
the bundle. The importer refuses reports for unknown results, mismatched bundles or
duplicate prompts — do not edit a report to satisfy it; regenerate it from the
right inputs.

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
