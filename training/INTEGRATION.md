# Offline MLX-LM worker

This is real Apple-silicon MLX backpropagation, not simulated training. Only
`training/` and the project-local `.venv-training` are owned by this implementation.
No Node/UI changes are needed to the specified version-1 event protocol.

## Environment

From the repository root:

```sh
uv venv --python /opt/homebrew/bin/python3.12 .venv-training
uv pip install --python .venv-training/bin/python -r training/requirements.txt
```

Do not recreate an environment while a worker is running. The installed interpreter
is Python 3.12.11. All 34 dependencies, including transitives, are pinned in
`requirements.txt`. The main pins are MLX/MLX-Metal 0.32.2, MLX-LM 0.31.3,
Transformers 5.17.0, Tokenizers 0.23.2, NumPy 2.5.3, Safetensors 0.8.0,
SentencePiece 0.2.2, Protobuf 7.36.1, PyYAML 6.0.3, Jinja2 3.1.6 and
Hugging Face Hub 1.31.0. No PyTorch or Hugging Face datasets dependency is used.

## Parent invocation and lifetime

Use the actual virtual-environment executable, not the default `python3`:

```sh
/Users/buns/Documents/GitHub/OpenCoven/mamase/.venv-training/bin/python \
  -u /Users/buns/Documents/GitHub/OpenCoven/mamase/training/mlx_runner.py \
  /absolute/private-job-directory/job.json
```

Keep the child's stdin **open through process exit**, including after `complete`.
Do not call `stdin.end()` after launch or after receiving `complete`. A daemon
thread starts before MLX imports and exits the entire process with code 143 on
stdin EOF, even while loading. SIGTERM retains the OS default handler and kills
the process promptly; there is no success-producing cancellation handler.
Only direct developer invocations may add `--standalone` to disable the monitor.

The worker accepts the supplied version-1 manifest. `dataset.holdout` is a
**numeric percentage**, not a fraction. The parent still owns manifest policy,
dataset provenance/teacher eligibility, allocation, cancellation state, and
artifact registration. The worker independently checks the exact original
source SHA-256, record count, record format, recipe numeric values, split counts,
and optimizer count. `sourcePath` is read-only and may live outside the job.

`outputPath` is the parent's absolute, new or empty allocated directory.
Its parent must already exist. The worker resolves parent-directory aliases
(including macOS `/var`), but the output directory itself must not be a symlink,
be inside the base model directory, or contain the model, source or manifest. The recipe's external
`outputPath` is never used. The worker logs this managed destination; the parent
should continue disclosing the distinction in launch confirmation.

Actual `train.jsonl` and `valid.jsonl` are written exclusively into a new
`splits/` directory beside **job.json**, never beside the original source unless
that happens to be the private job directory. Existing splits or nonempty output
directories cause a failure rather than an overwrite. Retry using a fresh job
directory and fresh output allocation.

Stdout contains only `MAMASE_EVENT ` followed by one-line JSON. Library prints
are redirected to stderr, which the parent should also log. Errors propagate with
a useful traceback and a nonzero process exit; no exception is converted into
successful completion.

## Actual training semantics

- Shuffle the full indexed source using local `random.Random(42)`, reserve the
  holdout prefix of `max(1, floor(records * holdout / 100))`, and train only on the
  remainder. Each epoch shuffles the training split with `Random(42 + epoch)`.
- Freeze the base model and apply MLX-LM's `linear_to_lora_layers` to every
  transformer layer, using its default supported projection keys. Rank is the
  recipe rank; MLX's `scale` is **alpha / rank**; dropout is zero.
- Optimize adapter parameters with Adam at the exact constant recipe learning
  rate. One microbatch contains at most `batchSize` examples; one update groups
  at most `accumulation` microbatches. Never discard a short batch or partial
  final accumulation group, and never carry a group across epoch boundaries.
- Gradients and reported losses are weighted by **supervised response token
  counts**, not by nominal batch size or nominal accumulation count. A partial
  group is normalized by its actual supervised tokens. This matches a single
  concatenated effective batch even when response lengths differ.
- `totalSteps = ceil(ceil(trainExamples / batchSize) / accumulation) * epochs`.
  The worker confirms this against Adam's actual `optimizer.step`.
- `maxSequence` bounds the full tokenized sequence including template tokens.
  Right truncation is logged. Every assistant turn must retain actual response
  content targets: a fully truncated response fails the job, not silently skips
  the example.
- Causal targets shift by one token. All prompt, system, user, tool, assistant
  header, and padding positions are masked. All assistant response turns and
  their end-of-turn tokens are supervised. Right padding cannot influence
  earlier real tokens in a causal model.
- Messages require the local tokenizer's actual chat template. Fast tokenizer
  character offsets establish response boundaries; a slow tokenizer must have
  exact token-prefix boundaries or fails explicitly. Templates that rewrite
  assistant content or alter preceding turns non-prefix-stably are rejected
  rather than assigned guessed masks. Text-only chats must contain a user and
  finish with an assistant response; multimodal content is unsupported.
- Prompt-response records use the chat template when available. Otherwise the
  explicit format is optional BOS + `prompt` + newline + `response` + required
  EOS. Only response/EOS targets are supervised. This fallback is logged.
- `distillation` is supervised **sequence distillation from pre-generated teacher
  responses**, using the same LoRA loop. There are no teacher calls, teacher
  downloads, logit matching, or KL-divergence measurements. `objective` is
  descriptive metadata; the implemented objective is response-only causal
  cross-entropy for both methods.

Only local standard MLX-compatible, text-only causal models with
`model*.safetensors`, `config.json`, and standard tokenizer files are supported.
The worker sets `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, disables telemetry,
and passes `local_files_only=True, trust_remote_code=False` to AutoTokenizer.
It directly calls the local-path MLX model loader, not the download-capable
convenience loader. Custom `model_file`, `auto_map`, unsupported architectures,
multimodal models, and Python-only chat templates fail explicitly. Large models
must fit memory together with training activations; this loop does not use
activation checkpointing or silently reduce recipe settings.

## Progress and publication

Initial progress is step 0 with null losses. Ordinary progress is reported every
`ceil(totalSteps / 5000)` optimizer updates, and at the final update. There is one
additional full-holdout evaluation report at every epoch boundary. Consequently
there are at most 5000 ordinary reports plus the initial report and epoch reports.
Steps are **nondecreasing, not strictly increasing**: the epoch evaluation can
repeat the immediately preceding step. Long jobs intentionally skip intermediate
step events; validate the final cumulative step, not the number of events.

Each loss is a measured, response-token-weighted mean. Ordinary progress covers
training since the last ordinary report; epoch progress covers the whole epoch
and the entire holdout (including partial validation batches). `evalLoss` is null
except when genuinely evaluated. Non-finite losses or adapter tensors fail.

After all updates and final evaluation, the worker stages and reads back real
adapter tensors, then publishes these files using exclusive hard links:

| Output file | Purpose |
| --- | --- |
| `adapters.safetensors` | Nonempty, finite trained `lora_a`/`lora_b` tensors; B must have learned a nonzero value |
| `adapter_config.json` | MLX-LM reload config: `fine_tune_type`, `num_layers`, `lora_parameters`, base model path |
| `training_receipt.json` | Actual optimizer count, losses, epoch metrics, split line indices/hash, settings and versions |

`complete` is emitted only after file writes, tensor read-back, publication and
fsync. A cancelled/failed run can leave split/staging files or incompletely
published artifacts. File presence alone is **not** success: the parent must
require complete + exit 0 + final step + artifact checks before registering.

## Offline fixture and reproducible proof

```sh
.venv-training/bin/python training/create_smoke_fixture.py /absolute/new-fixture-directory
```

This prints exactly one JSON result with `modelPath` and `datasetPath`. It creates
a two-layer, width-32 **randomly initialized toy Llama**, a byte-level tokenizer
with a real Jinja chat template, and nine valid original messages examples.
The model is NOT pretrained, useful for inference, or suitable for production;
it exists solely to exercise actual training through the UI.

Targeted tests and a persistent standalone smoke:

```sh
.venv-training/bin/python -m unittest discover -s training -p 'test_*.py' -v
.venv-training/bin/python -u training/smoke.py training/.smoke
```

The smoke takes a fresh output directory. It creates a valid job manifest and
invokes the **real** `mlx_runner.py --standalone`, with seven training and two
held-out examples, microbatch 2, accumulation 3, and two epochs: four optimizer
updates, including short microbatches and final partial accumulation groups.
It then loads the base model and uses MLX-LM `load_adapters` to reload the result.
It asserts all serialized adapter tensors match the reloaded parameters, nonzero
learned B and effective weight delta, changed model logits, genuine finite
training/holdout losses, exact optimizer counts and valid protocol output.

The smoke writes `smoke_evidence.json`, `worker.stdout.log`, `worker.stderr.log`,
`job/job.json`, `job/splits/{train,valid}.jsonl`, `fixture/`, and `adapters/`.
Unit tests also exercise a real non-standalone worker with an open stdin pipe,
pre-generated sequence distillation using the plain-format fallback, hash/output
failures, stdin EOF and SIGTERM during loading, and real MLX gradient accumulation
against a concatenated effective-batch reference.

## Retrieved API references

Public source was retrieved before implementation and checked against the pinned
release, rather than inferred from another trainer's conventions:

- [v0.31.3 local loader](https://raw.githubusercontent.com/ml-explore/mlx-lm/v0.31.3/mlx_lm/utils.py)
- [v0.31.3 tokenizer loader](https://raw.githubusercontent.com/ml-explore/mlx-lm/v0.31.3/mlx_lm/tokenizer_utils.py)
- [v0.31.3 LoRA implementation](https://raw.githubusercontent.com/ml-explore/mlx-lm/v0.31.3/mlx_lm/tuner/lora.py)
- [v0.31.3 adapter conversion/reload helpers](https://raw.githubusercontent.com/ml-explore/mlx-lm/v0.31.3/mlx_lm/tuner/utils.py)
- [v0.31.3 Llama model](https://raw.githubusercontent.com/ml-explore/mlx-lm/v0.31.3/mlx_lm/models/llama.py)
- [trainer semantics](https://raw.githubusercontent.com/ml-explore/mlx-lm/main/mlx_lm/tuner/trainer.py)

`LoRALinear` computes `base(x) + scale * ((x @ lora_a) @ lora_b)`; there is no
implicit division by rank. `lora_b` starts at zero. `load_adapters` reconstructs
layers from `num_layers`/`lora_parameters` and loads `adapters.safetensors`.
The pinned `load_model` does **not** accept a model trust flag and unconditionally
executes `model_file` when set; Mamase rejects it and passes a validated
`model_config` override with `model_file=None`. AutoTokenizer does accept and
receives `trust_remote_code=False`. MLX `nn.value_and_grad` differentiates only
the unfrozen trainable parameters, and Adam increments `optimizer.step` only
when `optimizer.update` is called.
