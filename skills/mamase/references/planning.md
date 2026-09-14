# Planning: workspace, datasets, recipes

All commands are `npm run ops -- <operation> ...`. Nothing here starts training.

## Workspace file

```bash
npm run ops -- init --workspace .lab/agent/workspace.json [--name "Agent lab"]
npm run ops -- inspect --workspace .lab/agent/workspace.json            # revision.after, collection counts
npm run ops -- inspect --workspace ... --record run-1                    # one record from any collection
```

The file is `mamase.workspace-file.v1`, mode 0600, written by atomic rename under a
`.lock`. Browser storage is never read; the bridge in either direction is the
backup envelope (`export-backup` / Settings import). Never remove a `.lock` you did
not create — report it.

## Datasets

```bash
npm run ops -- add-dataset --workspace ... --expected-revision <sha256> \
  --file examples.jsonl --name "Curated set" --kind supervised --holdout 20 \
  --provenance "Where the examples came from and who reviewed them" --id dataset-1
```

Only the fingerprint, record count, byte count and declared metadata are stored.
Same bytes + same ID → `unchanged`. Same ID with different bytes, or same bytes
under a different explicit `--id` → `blocked` (`dataset-conflict`). Do not rename
or re-add to get past a conflict; report it.

## Recipes (planned runs)

```bash
npm run ops -- create-recipe --workspace ... --expected-revision <sha256> --input plan.json
# plan.json: { "id": "run-1", "name": "…", "recipe": { method, programId, datasetId, student, teacher,
#             adapter, familiarId, instanceId, rank, alpha, learningRate, epochs, batchSize,
#             accumulation, maxSequence, outputPath, objective, workflow? } }
npm run ops -- export-recipe --workspace ... --run run-1 --out recipe.json   # mamase recipe contract for lab prepare
```

Lane selection happens here:

- `familiarId` + `instanceId` bound, or `workflow: "cli"` → **peft** lane.
- `workflow: "managed"` → **managed-mlx** lane. LoRA only: `create-recipe`
  rejects a non-LoRA managed recipe with exit `1` and nothing is saved.
- Neither → `unselected`; the receipt will ask you to decide before anything else.

Replaying `create-recipe` with the same content is `unchanged`; the same ID with a
different recipe is `blocked` (`run-conflict`). A saved recipe is a plan. Confirm
with `receipt`: `state: "planned"`, `nextAction.step` is `prepare` (PEFT) or
`capability` (managed).
