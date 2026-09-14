# mamase

**The Coven's distillation lab.** A local-first interface for planning LoRA
experiments, recording model-distillation progress, and keeping track of our
customized local models.

## Run locally

Requires Node.js 20 or later. There are no runtime dependencies or build step.

```sh
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The server binds only to
loopback and serves an explicit list of public assets. Set `PORT` to use a
different port.

## Workflow

1. **Programs:** organize related experiments.
2. **Datasets:** import JSONL conversations or prompt/response pairs (up to 20 MB).
   Record provenance, permissions, holdout percentage, and the teacher model for
   teacher-generated data. Only metadata and a SHA-256 fingerprint are retained;
   source examples remain in your file.
3. **Distillation lab:** choose LoRA fine-tuning or response distillation,
   configure the student/base model, rank, alpha, learning rate, epochs,
   micro-batch size, gradient accumulation, sequence length, and output path.
   Saving creates a **planned run**, not a training process.
4. **Training runs:** export a recipe, execute training with an external tool,
   then record progress manually or import a progress report. Actual observations
   drive status, optimizer-step progress, loss charts, and the progress journal.
5. **Model library:** register local adapters, checkpoints, merged weights, or
   GGUF paths. Download a manifest with the recipe, dataset fingerprint, and
   recorded evaluations.
6. **Evaluations:** record benchmark versions, scores, sample counts, and
   conditions for comparisons.

### Dataset formats

One object per line; keep the format consistent throughout a file:

```json
{"prompt":"A question","response":"A reviewed answer"}
```

Or:

```json
{"messages":[{"role":"user","content":"A question"},{"role":"assistant","content":"A reviewed answer"}]}
```

At least two examples are required. Mamase records a deterministic split plan:
shuffle with seed 42, reserve the holdout count, and train on the remainder.
**Your trainer must apply this split**; the browser does not write split files.
The Training handbook includes a small downloadable example dataset.

### Response distillation

Response distillation means supervised LoRA training on **pre-generated teacher
responses**. Generate and review those examples externally, import them as
teacher-generated data, and select the same teacher ID in the recipe. This lab
does not call a teacher API, generate examples, extract hidden reasoning, or
compute logit/KL losses.

Exported `mamase.training-recipe.v1` files are **planning manifests**, not
executable configurations for any particular trainer. Map the fields to your
chosen Transformers/PEFT, TRL, or MLX-LM workflow. Model licenses, hardware
compatibility, precision, target modules, and chat templates must be confirmed
in that trainer. Step estimates assume a single device.

### Progress reports

Download a report template from a run's progress journal. Replace the values
with actual trainer observations before importing:

```json
{
  "schema": "mamase.run-report.v1",
  "runId": "COPY-THE-RUN-ID-FROM-MAMASE",
  "updates": [
    {
      "status": "running",
      "step": 10,
      "totalSteps": 120,
      "loss": 1.2,
      "evalLoss": null,
      "note": "Observed from local trainer logs",
      "recordedAt": "2026-09-13T18:00:00.000Z"
    }
  ]
}
```

Updates are applied atomically. Timestamps must be chronological and steps
cannot go backwards. Planned runs can become running or cancelled; running or
paused runs can become completed, failed, or cancelled. Completion requires all
steps to be recorded. Closed runs are immutable; create another recipe for a new
attempt. Status updates never start, stop, or pause a real training process.

## Local data and boundaries

Workspace metadata is saved in this browser's `localStorage`, under
`mamase.coven-lab.v1` (4 MB maximum). **Export a workspace backup from Settings**
before clearing browser data or changing browsers/ports. Restoring a validated
backup replaces existing metadata after confirmation. Corrupt data and failed
saves surface an error instead of silently resetting the workspace. Concurrent
edits from another tab require a reload to avoid overwriting changes.

There is no hosted training, inference endpoint, cloud sync, billing, account
system, or fabricated training progress. Artifact paths are references: the
browser does not verify files, merge adapters, quantize weights, or export actual
model binaries. Fonts and artwork are local; the app makes no external service
requests. External documentation links open only when clicked.

## Development checks

```sh
npm test
```

Uses Node's built-in runner for dataset parsing, recipe validation, teacher
provenance, run-state transitions, artifact/evaluation relationships, backup
integrity, storage failure handling, exports, and the local asset server.
