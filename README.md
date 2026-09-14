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

### Moving between experiments

Use **Search workspace** or **Cmd/Ctrl+K** to find programs, datasets, training
runs, artifacts, and workspace views. Results stay local. Tab through results,
press Enter to open one, and press Escape to close search.

Dataset pages expose provenance and linked experiments. **Use in a recipe**
preselects the dataset and its recorded teacher. A recipe can also import data
without leaving the lab. **Duplicate recipe** copies a run's configuration, not
its progress or results, and suggests a separate output path. Replacing an
existing draft requires confirmation.

The lab saves recipe drafts in this tab's `sessionStorage`, under
`mamase.recipe-draft.v1`. Drafts survive reloads but are not cross-tab/cloud
storage or part of workspace backups. Download a draft before closing the tab
if you need a separate copy. Corrupt draft data is preserved for download or
explicit discard; unavailable storage is reported rather than treated as a save.

Training run filters, search terms, sort order, and pagination are encoded in
the hash URL. These links refer to records in the current browser workspace;
they do not share data with another device. Lists show 20 runs per page.
**Export CSV** includes every matching run, across all pages, in the selected
order. Clear filters returns to the full list.

Artifact detail pages connect the local path, notes, source run, dataset
fingerprint, and recorded evaluations. Evaluation actions preselect that
artifact. Training charts show both training and validation loss, distinguish
missing values from zero, and provide an expandable observations table.

### Comparing evaluations

Choose baseline and candidate records on the Evaluations page. A delta is shown
only when both records have the same benchmark/version, score maximum, sample
count, and identical nonempty conditions. Record the sample-set identity and
scoring protocol in those conditions.

The result is **candidate minus baseline in percentage points**, not an
automatic winner. Matching metadata cannot prove identical evaluation execution,
and higher scores are not necessarily better for every metric.

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

### Appearance

Choose **System**, **Light**, or **Dark** in the sidebar or Workspace settings.
System is the default and follows device appearance changes immediately.
Explicit choices persist across reloads under `mamase.appearance.v1`, separately
from workspace backups and resets. The saved theme is applied before the first
paint. All views, dialogs, charts, and the original distillation-vessel hero
illustration adapt to the selected theme without external image or font requests.
The palette follows [OpenCoven UI's canonical tokens](https://github.com/OpenCoven/ui/blob/main/packages/ui/src/styles/globals.css):
the dark canvas is `#050409`, panels are `#0f0d14`, and purple is reserved for
presence, focus, and primary actions. Restrained glass surfaces use subtle
reflections and translucent layers, with backdrop blur limited to the sidebar,
mobile header, and dialogs. Solid surfaces remain available when blur is
unsupported or reduced transparency / increased contrast is requested.

Overview cards link to their corresponding workspace views, and the main action
guides a new workspace to import data before planning training. The overview is
bounded to the viewport and a maximum content width of 1800px, with explicit
hero width/height limits. Compact
screens show the latest two experiments and keep the full workflow available
through the handbook link rather than stacking additional panels below the fold.
On very short viewports (620px high or less), or while a persistent storage
warning is present, the overview scrolls naturally instead of overlapping or
clipping essential content. Opening navigation does not rebuild open forms.

### Workspace storage

Workspace metadata is saved in this browser's `localStorage`, under
`mamase.coven-lab.v1` (4 MB maximum). **Export a workspace backup from Settings**
before clearing browser data or changing browsers/ports. Restoring a validated
backup replaces existing metadata after confirmation. Corrupt data and failed
saves surface an error instead of silently resetting the workspace. Concurrent
edits from another tab show a persistent warning and require a reload to avoid
overwriting changes. The warning preserves open forms and offers an export of
the currently open workspace before reloading newer saved data.

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

The browser regression suite uses Playwright as a development-only dependency:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

It starts its own loopback server on an available port and uses isolated browser
contexts, leaving the development server and your workspace untouched. Set
`MAMASE_SCREENSHOTS` to a directory to retain screenshots. Runtime dependencies
and a build step are still unnecessary.

See [the comprehensive UI/UX audit](UI-UX-AUDIT.md) for the findings, implemented
enhancements, and review boundaries.
