# PEFT lane (CPU / CUDA via `training/*.py`)

Receipt lane `peft`. Steps: plan → prepare → preflight → train → evaluate →
human-review. Use the PEFT environment (`training/requirements.txt`, e.g.
`.venv/bin/python`), never the MLX one.

## Prepare (inert)

```bash
mkdir -p .lab && npm run lab -- prepare --recipe recipe.json --dataset examples.jsonl \
  --identity-dir /path/familiar --out .lab/experiment
```

Writes `bundle.json` (frozen recipe, dataset fingerprint, split, `execution:
"not-started"`, `promotion: "not-authorized"`). Downloads nothing, trains nothing.

Optional selected familiar context — only when the user asks for it:

```bash
npm run lab -- inspect-context --recipe recipe.json --identity-dir /path/familiar --context-manifest context-selection.json
```

Show the user the ordered sources and fingerprint; then pass
`--context-manifest … --context-sha256 <sha from preview>` to `prepare`. Without
those flags the bundle keeps the historical `identity-files-only` scope. The scope
is recorded in results and receipts — never describe the two as interchangeable.

Then `receipt --bundle .lab/experiment`: expect `state: "prepared"`, or blockers
`source-changed` / `recipe-changed` / `bundle-run-mismatch` (the inputs moved
after planning — prepare again from the saved recipe and tell the user; do not
edit the bundle).

## Preflight (read-only)

```bash
.venv/bin/python training/preflight.py --bundle .lab/experiment --model /path/local-model --device cpu
```

JSON `errors` / `warnings` / `facts`; exit `1` = blocked (missing model files,
runtime, memory facts). Report the errors verbatim as blockers. A clean preflight is
not an OOM guarantee.

## Train (requires explicit approval for this run)

```bash
.venv/bin/python training/train.py --bundle .lab/experiment --model /path/local-model --device cpu
```

Only after the user says to train *this* bundle. It writes the run journal
(`mamase.run-report.v1`) and `result.json` (`mamase.training-result.v1`) with
`bundleSha256` lineage. Import the journal first, then the result — the validators
refuse a result whose run has no completed journal and bind it to the run and
bundle:

```bash
npm run ops -- import-progress --workspace ... --expected-revision <sha256> --file run-report.json
npm run ops -- import-result --workspace ... --expected-revision <sha256> --file result.json
```

A result from a different bundle than the one named in `--bundle` shows as
`bundle-changed`: keep both attempts; never delete or overwrite one so the other
"matches". Progress observations (`import-progress`) are replayed the same way:
duplicates `unchanged`, conflicts `blocked`, nothing rewritten.

`receipt` now says `state: "trained"`, `nextAction.step: "evaluate"`. Without
`--bundle` the prepare fingerprint is taken from artifact lineage; it never asks a
trained run to prepare again.
