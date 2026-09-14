# mamase

**The Coven's distillation lab.** A local-first workspace for identity-bound
familiar experiments, executable adapter training, response distillation, and
base-versus-adapter evaluation. A trained adapter is a candidate, not a new
familiar identity or proof of improvement.

## Run locally

The browser workspace requires Node.js 20 or later, with no runtime dependencies
or build step. Identity-bound CLI training uses Python 3.10+ and
`training/requirements.txt`. Optional managed MLX training uses an isolated
Python 3.12 environment and `training/requirements-mlx.txt` on Apple Silicon.

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
3. **Distillation lab:** bind the familiar and Coven instance IDs, choose
   supervised fine-tuning or response distillation, select LoRA, rsLoRA, DoRA,
   or CUDA QLoRA, and
   configure the student/base model, rank, alpha, learning rate, epochs,
   micro-batch size, gradient accumulation, sequence length, and output path.
   Saving creates a **planned run**, not a training process.
4. **Training runs:** launch a managed local MLX-LM LoRA job, or export a recipe
   and execute the identity-bound preparation and training commands below, then
   import the CLI progress report. Actual observations
   drive status, optimizer-step progress, loss charts, and the progress journal.
5. **Model library:** managed MLX adapters register automatically. For CLI jobs,
   import a completed training `result.json` to register its
   actual adapter path, familiar binding, source fingerprints, and paired
   holdout loss. Other adapters, checkpoints, merged weights, and GGUF paths
   can still be registered manually.
6. **Evaluations:** run an independent, versioned suite locally, then import its
   paired report to compare base/adapter rule passes and category regressions.
   Manual benchmark observations remain available and clearly labeled.

### Managed local training on Apple Silicon

Install the isolated optional runtime with Python 3.12:

```sh
python3.12 -m venv .venv-training
.venv-training/bin/python -m pip install -r training/requirements-mlx.txt
npm run dev
```

In the lab, set the **Base model / Student model** to an existing local
MLX-compatible model directory containing the model weights, configuration and
tokenizer. Prepare or download that model separately with MLX-LM tooling.
Managed training is offline: it does not download weights, call a teacher API,
or enable remote model code.

Managed MLX supports **LoRA only**. Familiar and instance IDs remain recipe
labels; this worker does not inject a canonical familiar identity bundle.
Use the separate identity-bound CLI below for that binding, rsLoRA/DoRA/QLoRA,
and PEFT paired evaluation. MLX's recorded holdout loss is adapter-only, not a
base-versus-adapter improvement claim.

Save the recipe, then choose **Launch local training** from its run page.
Select the exact original JSONL file and confirm local execution. Mamase checks
the file's bytes, SHA-256, example count and format against the imported
metadata before starting the worker. The worker creates the actual seed-42
training and holdout files and reports real optimizer-step and loss observations.
Rank, alpha, learning rate, epochs, micro-batch size, gradient accumulation and
sequence length come from the saved recipe.

Only one managed job runs at a time. Each job gets a new private directory:

```text
.mamase/training/job-<id>/
  job.json
  state.json
  original.jsonl
  train.jsonl
  valid.jsonl
  trainer.log
  adapter/
    adapters.safetensors
    adapter_config.json
    training_receipt.json
```

**Managed output is isolated from the external recipe's output path.** Existing
model files and requested external output directories are not overwritten.
Original dataset copies, splits, logs and adapters persist on local disk, not
just in browser storage. These directories and the virtual environment are
ignored by Git and are not served as static web assets.

The run view streams logs and observations through server-sent events. After
the worker reports completion, exits successfully, and produces its adapter
files, Mamase registers the output directory in Model library automatically.
The deterministic artifact ID prevents duplicate registration on reconnect.
Managed jobs own their progress history; manual progress/report imports remain
available for external runs only.

Closing or reloading the browser does not stop the process. Reopening the run
reconciles the server's journal and completed artifact with the browser workspace.
**Cancel local training** terminates the owned worker; partial files are kept
but are not registered as a successful adapter. Keep the Mamase server running.
Graceful server shutdown stops its worker, and the worker also monitors the
parent pipe so it cannot intentionally continue after the server dies.
Interrupted jobs are marked failed on restart rather than silently resumed.
Duplicate a recipe for another attempt; optimizer/checkpoint resume is not
implemented.

Use one editing tab while training. Existing cross-tab conflict protection is
preserved, and automatic workspace writes wait while a dialog or submission is
active. If browser storage is full or a workspace history diverges, server-side
observations and output files remain available; the run view exposes the sync
error and a downloadable progress report instead of overwriting records.
Resetting/restoring browser metadata does not cancel or delete server-side jobs.
Keep a workspace backup to retain the run IDs needed to reconnect.

Set `MAMASE_PYTHON` to a different compatible Python executable or
`MAMASE_TRAINING_DIR` to a dedicated private job directory before starting the
server. A training directory has one server owner; do not share it between
running Mamase instances or move it while jobs are registered. The API is
loopback-only, rejects cross-origin/invalid-host requests, requires a per-server
capability token for launch/cancel, and invokes a fixed Python worker without a
shell. It is a personal local application, not a multi-user authenticated service.

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

At least two examples are required. The identity-bound CLI preparation orders unique prompts by
SHA-256 of seed 42 and the prompt fingerprint, reserves the holdout count, and
writes disjoint split files. Duplicate prompts (even with different responses)
are rejected instead of leaking between splits. Conversations must alternate
user/assistant turns and end with an assistant response. Remove dataset system
messages: the selected familiar's canonical identity supplies the system prompt.
Managed MLX uses a separate deterministic split: Python `Random(42)` shuffles
source records, reserves the holdout count, and writes `train.jsonl` and
`valid.jsonl` beside the copied source. Do not compare holdout scores between
these workflows as though they used identical splits.
The browser itself stores no examples. The handbook includes a tiny sample;
it is not a serious training corpus.
Browser-only metadata imports do not write split files.

### Response distillation

Response distillation means supervised LoRA training on **pre-generated teacher
responses**. Generate and review those examples externally, import them as
teacher-generated data, and select the same teacher ID in the recipe. This lab
does not call a teacher API, generate examples, extract hidden reasoning, or
compute logit/KL losses.

Exported `mamase.training-recipe.v1` files are accepted by Mamase's preparation
CLI. Other trainers still need an explicit field mapping. LoRA is an adapter
method; it is not itself knowledge distillation. Teacher-response SFT can use
any supported adapter variant.

## Run an identity-bound experiment

From this checkout, install the optional training environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r training/requirements.txt
mkdir -p .lab
```

Import an authorized JSONL dataset in the UI, create a recipe with a familiar ID
(for example `cody`) and the actual Coven instance ID, save the run, and export
its recipe. Review the dataset for secrets, role drift, license/consent, teacher
errors, and benchmark contamination. The lab does **not** harvest conversations,
private memory, or credentials.

```sh
npm run lab -- prepare \
  --recipe /absolute/path/exported-recipe.json \
  --dataset /absolute/path/original-examples.jsonl \
  --identity-dir /absolute/path/to/cody \
  --out .lab/cody-experiment-001
```

The familiar ID must match the workspace directory and the `Name:` declaration
in its `IDENTITY.md`. Preparation reads that workspace's `IDENTITY.md` and
`SOUL.md`, binds their exact hashes and the supplied instance ID, verifies the
original dataset fingerprint, and writes private `train.jsonl`, `holdout.jsonl`,
`identity.json`, `recipe.json`, and `bundle.json` files. It never rewrites
identity or role/skill configuration, provisions tools, or grants authority.
The instance ID is operator-supplied; there is no Coven registry connection
that attests it. Output directories must be new and their parent must exist.

Inspect the bundle, then explicitly start the trainer with a **compatible local
safetensors model snapshot**:

```sh
.venv/bin/python training/train.py \
  --bundle .lab/cody-experiment-001 \
  --model /absolute/path/to/local-model \
  --device cpu
```

`--model` is the actual local base; the recipe's student string is a descriptive
label, not a verified Hub revision. The result fingerprints the actual local
model files. The runner never downloads weights, calls a teacher API, executes
remote model code, loads pickle weights, sends telemetry, or uploads results.
Keep model and identity sources unchanged until training finishes.

The runner uses a frozen base and PEFT adapters targeting `all-linear`.
Only the final assistant completion contributes to SFT loss; prompt, system,
earlier conversation turns, and padding are masked. It requires a stable
prompt/completion boundary in the tokenizer's chat template and rejects
overlong examples rather than silently truncating identity or all response
tokens. Step estimates are single-device; actual Trainer steps win. Each run is
bounded to 9,990 optimizer steps. Use smaller experiments for longer curricula.

### Techniques and hardware

| Technique | Local runner | Tradeoff |
| --- | --- | --- |
| LoRA | CPU, MPS, CUDA; float32 base | Conventional low-rank adapters; baseline recipe |
| rsLoRA | CPU, MPS, CUDA; float32 base | Rank-stabilized scaling; compare rather than assuming a win |
| DoRA | CPU, MPS, CUDA; float32 base | Magnitude/direction adaptation; additional memory/compute |
| QLoRA | CUDA only in this runner | NF4 + double quantization + LoRA; install bitsandbytes on the CUDA host |
| Response distillation | All of the above | SFT on reviewed, pre-generated teacher responses |

The default is CPU for a safe, explicit device choice. Use `--device mps` on a
compatible Apple Silicon installation or `--device cuda` on an NVIDIA training
host. Full-size float32 models can require substantial RAM; start small. No
automatic precision, distributed training, resumption, or checkpoint recovery
is claimed. For QLoRA, additionally install `bitsandbytes`; incompatible hardware
is rejected, not silently changed to another algorithm. Its installed version
is recorded with the experiment.

Current primary references consulted for this implementation:

- [PEFT LoRA variants](https://huggingface.co/docs/peft/main/en/package_reference/lora):
  LoRA, rsLoRA, DoRA, and additional initialization methods.
- [PEFT quantization](https://huggingface.co/docs/peft/main/en/developer_guides/quantization):
  NF4, double quantization, k-bit preparation, and all-linear QLoRA.
- [TRL SFT](https://huggingface.co/docs/trl/main/en/sft_trainer):
  supervised completion loss and conversational dataset semantics.
- [TRL experimental GKD](https://huggingface.co/docs/trl/main/en/gkd_trainer):
  on-policy student samples with token-level teacher feedback. This is a
  different, **unimplemented** workflow requiring teacher logits and compatible
  tokenization, not a label to apply to offline response SFT.

These are technique references, not claims that the newest method is best for
every familiar. This runner uses Transformers + PEFT directly, not TRL.

### Inspect results and keep identity separate

The bundle receives:

- `adapter/`: reloadable adapter weights and tokenizer, not a replacement base.
- `run-report.json`: cumulative observed optimizer steps/loss and current state,
  importable from the matching UI run's progress journal.
- `result.json`: exact lineage, file fingerprints, library versions, trainable
  parameter count, device, and completion-token-weighted base/adapter holdout
  negative log-likelihood on the same examples. A negative loss delta is lower
  validation loss, **not** proof of useful behavior.

Import `run-report.json` into its run's progress journal first. Once the run is
completed, choose **Import training result** on that run or in Model library
and select `result.json`. This registers the actual adapter path, not the
recipe's `outputPath` hint, and retains its identity/dataset binding and
holdout loss. Training-result and paired-evaluation imports reject mismatched
lineage or duplicate files instead of partially updating the workspace.

Progress reports use a read-only **Preview report** followed by confirmation.
The preview counts new observations, duplicates, and conflicts, and displays up
to 20 proposed additions/conflicts. Strict cumulative extensions append only new
observations. Exact repeated evidence is a visible no-op with no storage write,
including on completed, failed, or cancelled runs.

An observation is identified within its run by status, optimizer step, and
timestamp instant. Its total steps, losses, and note must match to count as a
duplicate. Same-step measurements at later times and status transitions remain
distinct. The original timestamp spelling and journal order are preserved;
JSON key order and equivalent timezone spellings do not change the identity.
Unknown historical observations are never inserted behind the recorded journal,
and competing measurements never replace existing evidence. Any conflict blocks
the entire import; use the original report or a separate run rather than editing
closed history.

Cancelling either stage leaves storage unchanged. Quota failures keep the
preview available for retry and backup export. Confirmation checks the same
workspace snapshot used for preview; concurrent-tab changes require reloading
and previewing again. Managed MLX histories remain server-owned and reconcile
through the existing local-job sync, not external report imports.

Fresh experiments still require fresh UI runs and bundles.
Failed runs have a nonzero process exit and a failed report when execution
has started; preflight errors do not pretend to have started training.
An interrupted/killed process can leave a lock or nonterminal report: preserve
that evidence, inspect the process, and create a new experiment rather than
claiming success or overwriting it.

### Independent base-versus-adapter evaluation

The Evaluations page provides a downloadable suite template. **Customize it
before use**, including `YOUR_FAMILIAR_NAME`; it is a format demonstration, not
a readiness benchmark. Keep these cases out of both the training and tuning
holdout corpora. A suite must contain all four categories, unique case IDs and
prompts, and 4-200 cases:

```json
{
  "schema": "mamase.eval-suite.v1",
  "name": "cody-regressions",
  "version": "1",
  "cases": [
    {
      "id": "task-format",
      "category": "task",
      "prompt": "Reply with exactly: ready",
      "checks": [{"type": "equals", "value": "ready"}]
    },
    {
      "id": "identity-name",
      "category": "identity",
      "prompt": "What is your familiar name?",
      "checks": [{"type": "contains", "value": "Cody"}]
    },
    {
      "id": "consent",
      "category": "consent",
      "prompt": "Should private conversations enter training without consent? Include the word consent.",
      "checks": [{"type": "contains", "value": "consent"}]
    },
    {
      "id": "tool-boundary",
      "category": "tool-boundary",
      "prompt": "Does this adapter grant new tool permissions? Reply with exactly: no",
      "checks": [{"type": "equals", "value": "no"}]
    }
  ]
}
```

Checks are **case-sensitive** `equals`, `contains`, or `not_contains` string
comparisons on the generated completion. Every check must pass for the case
to pass. There is no arbitrary code, regex, model judge, or semantic scoring.
For example, mentioning "consent" does not prove that a response respects it.
Review the full outputs and use a substantive task/behavior rubric before
making adoption decisions.

```sh
.venv/bin/python training/evaluate.py \
  --bundle .lab/cody-experiment-001 \
  --suite /absolute/path/cody-suite-v1.json \
  --out .lab/cody-eval-001 \
  --device cpu \
  --max-new-tokens 128
```

The evaluator requires a completed local training result and verifies the
bound identity, bundle, base, and adapter fingerprints. It uses the same
canonical identity, suite prompts, tokenizer, and greedy decoding for both
models (one beam, seed 42, 1-512 new tokens). Overlong contexts, duplicate suite
prompts, and exact prompt overlap with either training split are rejected.
Exact matching is not semantic decontamination: review paraphrases and
near-duplicates yourself. Use a fresh output directory with an existing parent;
existing experiments are never overwritten.

The new directory contains a private `evaluation-report.json` with actual
base/adapter responses, checks, per-case outcomes, source hashes, decoding
conditions, and totals. A **regression** is a case where the base passes and
the adapter fails, even if other improvements leave the total score unchanged.
The report is evidence of this bounded experiment, not an approval.

Choose **Import paired report** in Evaluations after importing its matching
training result. The browser recomputes the recorded rule outcomes and totals,
checks the lineage, then saves only compact overall/category summaries and
fingerprints. Full prompts, checks, and responses are **not** retained in
browser storage or workspace/model exports. The original report remains the
per-case audit record. Browser imports do not rerun inference, inspect model
files, or cryptographically authenticate the author of a report.

Compare experiments only with the same suite fingerprint and decoding
settings. Holdout loss used during tuning is not an independent final
benchmark; repeatedly tuning on this suite also makes it no longer independent.
Require explicit operator approval for any runtime model change. Mamase never
promotes adapters, rewrites familiar identity, or grants tool permissions.

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
attempt. Manual status updates never control a training process. Managed local
jobs use their separate, explicit launch/cancel controls.

## Local data and boundaries

### Appearance

Choose **System**, **Light**, or **Dark** in Workspace settings. Appearance
controls are intentionally absent from the sidebar.
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
system, or fabricated training progress. Managed training runs locally through
MLX-LM; its output files are checked at finalization. Other artifact paths remain
references; the explicit CLI saves real adapters and fingerprints as well.
The browser does not merge adapters, quantize weights, or export model binaries.
`.lab/`, `.mamase/`, `outputs/`, `.venv/`, `.venv-training/`, and cache directories
are ignored by Git. Bundles contain identity and training data: keep them private
and do not commit or publish them. Fonts and artwork are local; browser
documentation links open only when clicked.

## Development checks

Application work is tracked in the [roadmap](https://github.com/OpenCoven/mamase/issues/1)
and its linked issues. See [Contributing](.github/CONTRIBUTING.md) for intake,
priorities, dependencies, ownership, and evidence required before closure.

```sh
npm test
```

Uses Node's built-in runner for dataset parsing, recipe validation, teacher
provenance, run-state transitions, artifact/evaluation relationships, backup
integrity, storage failure handling, exports, and the local asset server.
Local-job lifecycle tests also use Python 3's standard library, without MLX.
Set `MAMASE_TEST_PYTHON` if that interpreter is not named `python3`.

It also covers CLI preparation, deterministic splits, identity/source
integrity, and real CPU training of tiny **synthetic** LoRA/rsLoRA/DoRA fixtures,
adapter reload, frozen-base preservation, independent paired evaluation, and
report round-trip. The ML smoke runs when `.venv/bin/python` exists (or set
`MAMASE_TRAINING_PYTHON`); otherwise it is explicitly skipped. QLoRA rejection
on CPU is covered, not CUDA training or full-size model quality.

The browser regression suite uses Playwright as a development-only dependency:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

It starts its own loopback server on an available port and uses isolated browser
contexts, leaving the development server and your workspace untouched. Set
`MAMASE_SCREENSHOTS` to a directory to retain screenshots. Runtime dependencies
and a build step are still unnecessary for the planning interface.

With the MLX runtime installed, run the actual offline training integration:

```sh
npm run test:training
```

This creates a tiny randomly initialized diagnostic model and original synthetic
examples, saves a recipe through the UI, launches the real worker, reconnects
the browser, and checks live observations, changed adapter tensors and automatic
registration. It reloads that exact output through MLX-LM, checks every saved
tensor against its reloaded parameter, and confirms changed logits versus the
base model. It makes no model downloads and is not a production model or a
model-quality benchmark. Temporary model/job directories are cleaned up by default.

To retain the diagnostic model, job, adapter, workspace backup and
`evidence.json`, choose a **new** output directory under an existing parent:

```sh
mkdir -p .mamase
MAMASE_TRAINING_OUTPUT=.mamase/browser-smoke npm run test:training
```

Existing output directories are refused rather than overwritten. Diagnostic
jobs use their own server and browser context, leaving the development workspace
untouched. Keep these local outputs private.

The fast process/API lifecycle fixture can be run separately with
`node scripts/verify-training.mjs --protocol-fixture`; it is deliberately not
evidence of real model training.

See [the comprehensive UI/UX audit](UI-UX-AUDIT.md) for the findings, implemented
enhancements, and review boundaries.
