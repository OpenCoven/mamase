#!/usr/bin/env python3
"""Mamase's offline MLX-LM worker. See training/INTEGRATION.md."""

import argparse
import contextlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import random
import re
import sys
import threading

# Set before any Hugging Face/MLX imports, including when used by smoke tests.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["MLXLM_USE_MODELSCOPE"] = "False"

if __package__:
    from .data import (
        accumulation_groups, collate, deterministic_split, encode_example,
        finite_number, microbatches, optimizer_steps, positive_integer,
        read_source, split_counts, write_splits,
    )
else:
    from data import (
        accumulation_groups, collate, deterministic_split, encode_example,
        finite_number, microbatches, optimizer_steps, positive_integer,
        read_source, split_counts, write_splits,
    )


def emit(stream, event):
    stream.write("MAMASE_EVENT " + json.dumps(event, allow_nan=False) + "\n")
    stream.flush()


def monitor_parent():
    """Exit the whole process on pipe EOF, even while the main thread loads MLX."""
    descriptor = sys.stdin.fileno()

    def watch():
        try:
            while os.read(descriptor, 4096):
                pass
        except OSError as error:
            os.write(2, f"Parent stdin monitor failed: {error}\n".encode())
            os._exit(143)
        os.write(2, b"Parent stdin closed; terminating training without completion.\n")
        os._exit(143)

    threading.Thread(target=watch, name="mamase-parent-monitor", daemon=True).start()


def absolute_path(value, name):
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError(f"{name} must be an absolute local path")
    return Path(value)


def read_job(job_path):
    if not job_path.is_absolute() or not job_path.is_file():
        raise ValueError("Job manifest must be an existing absolute JSON file")
    with job_path.open(encoding="utf-8") as stream:
        job = json.load(stream)
    if not isinstance(job, dict) or type(job.get("version")) is not int or job["version"] != 1:
        raise ValueError("Expected manifest version 1")
    if not isinstance(job.get("jobId"), str) or not job["jobId"]:
        raise ValueError("jobId must be a nonempty string")
    if not isinstance(job.get("run"), dict) or not isinstance(job["run"].get("recipe"), dict):
        raise ValueError("run.recipe must be an object")
    recipe = job["run"]["recipe"]
    dataset = job.get("dataset")
    if not isinstance(dataset, dict):
        raise ValueError("dataset must be an object")
    if recipe.get("method") not in ("lora", "distillation"):
        raise ValueError("Only lora and pre-generated response distillation are supported")
    if recipe.get("datasetId") != dataset.get("id") or not dataset.get("id"):
        raise ValueError("recipe.datasetId must match dataset.id")
    for key in ("rank", "epochs", "batchSize", "accumulation"):
        positive_integer(recipe.get(key), f"recipe.{key}")
    positive_integer(recipe.get("maxSequence"), "recipe.maxSequence", 2)
    for key in ("alpha", "learningRate"):
        value = finite_number(recipe.get(key), f"recipe.{key}")
        if value == 0:
            raise ValueError(f"recipe.{key} must be positive")
    split_counts(dataset.get("records"), dataset.get("holdout"))
    source = absolute_path(job.get("sourcePath"), "sourcePath")
    model = absolute_path(job.get("modelPath"), "modelPath")
    output = absolute_path(job.get("outputPath"), "outputPath")
    if not source.is_file() or not model.is_dir():
        raise ValueError("sourcePath must be a file and modelPath an existing local directory")
    if output.is_symlink():
        raise ValueError("outputPath itself must not be a symlink")
    # Resolve normal macOS aliases such as /var -> /private/var before checking
    # ownership relationships; all subsequent writes use this resolved directory.
    output = output.resolve()
    for protected in (source.resolve(), model.resolve(), job_path.resolve()):
        if protected.is_relative_to(output):
            raise ValueError("outputPath must not contain the source, model, or manifest")
    if output.is_relative_to(model.resolve()):
        raise ValueError("outputPath must not be inside the base model directory")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("outputPath must be a new or empty allocated directory")
    return job, source.resolve(), model.resolve(), output


def validated_model_config(model_path):
    with (model_path / "config.json").open(encoding="utf-8") as stream:
        config = json.load(stream)
    if not isinstance(config, dict):
        raise ValueError("Model config.json must contain an object")
    if config.get("model_file") is not None or config.get("auto_map"):
        raise ValueError("Custom model code (model_file/auto_map) is not supported")
    if not re.fullmatch(r"[a-z][a-z0-9_]*", str(config.get("model_type", ""))):
        raise ValueError("Model config requires a standard MLX-LM model_type")
    if config.get("is_encoder_decoder") or config.get("vision_config") or config.get("audio_config"):
        raise ValueError("Only text-only causal language models are supported")
    if not list(model_path.glob("model*.safetensors")):
        raise ValueError("Local model directory must contain model*.safetensors weights")
    with (model_path / "tokenizer_config.json").open(encoding="utf-8") as stream:
        tokenizer_config = json.load(stream)
    if not isinstance(tokenizer_config, dict) or tokenizer_config.get("auto_map"):
        raise ValueError("Tokenizer must be standard and cannot require custom auto_map code")
    for key in ("chat_template_type", "tool_parser_type"):
        value = tokenizer_config.get(key)
        if value is not None and not re.fullmatch(r"[a-z][a-z0-9_]*", str(value)):
            raise ValueError(f"Unsupported tokenizer {key}")
    # v0.31.3 load_model has no trust_remote_code parameter. A validated override
    # prevents its unconditional custom model_file branch from executing.
    return {**config, "model_file": None}


def load_local_model(model_path):
    config = validated_model_config(model_path)
    from mlx_lm.utils import load_model
    from transformers import AutoTokenizer

    model, config = load_model(model_path, strict=True, model_config=config)
    tokenizer = AutoTokenizer.from_pretrained(
        model_path, trust_remote_code=False, local_files_only=True,
    )
    if tokenizer.init_kwargs.get("chat_template_type") and not tokenizer.chat_template:
        raise ValueError("Python chat_template_type is unsupported; supply a real Jinja chat template")
    if not hasattr(model, "layers") or not model.layers:
        raise ValueError("Unsupported MLX causal model: no transformer layers for LoRA")
    return model, tokenizer, config


def supervised_loss(model, tokens, mask):
    import mlx.core as mx
    import mlx.nn as nn

    logits = model(tokens[:, :-1])
    targets = tokens[:, 1:]
    if logits.ndim != 3 or logits.shape[:2] != targets.shape:
        raise ValueError("Unsupported model output: expected [batch, sequence, vocabulary] logits")
    losses = nn.losses.cross_entropy(logits.astype(mx.float32), targets)
    target_mask = mask[:, 1:]
    return mx.where(target_mask, losses, 0).sum() / target_mask.sum()


def optimizer_update(model, optimizer, loss_and_grad, batches, pad_token_id):
    """One token-weighted optimizer update, including any partial final group."""
    import mlx.core as mx
    from mlx.utils import tree_map

    total_tokens = sum(example.target_count for batch in batches for example in batch)
    if total_tokens <= 0:
        raise ValueError("Accumulation group has no supervised tokens")
    gradients = None
    total_loss = 0.0
    for batch in batches:
        tokens, masks = collate(batch, pad_token_id)
        count = sum(example.target_count for example in batch)
        loss, gradient = loss_and_grad(
            model, mx.array(tokens, dtype=mx.int32), mx.array(masks, dtype=mx.bool_)
        )
        weight = count / total_tokens
        gradient = tree_map(lambda value: value.astype(mx.float32) * weight, gradient)
        gradients = (
            gradient if gradients is None
            else tree_map(lambda left, right: left + right, gradients, gradient)
        )
        # Materialize each microbatch before building the next graph.
        mx.eval(loss, gradients)
        measured = loss.item()
        if not math.isfinite(measured):
            raise FloatingPointError("Non-finite training loss; adapter not finalized")
        total_loss += measured * weight
    optimizer.update(model, gradients)
    mx.eval(model.trainable_parameters(), optimizer.state)
    return total_loss, total_tokens


def evaluate(model, examples, batch_size, pad_token_id):
    import mlx.core as mx

    model.eval()
    total_loss, total_tokens = 0.0, 0
    for batch in microbatches(examples, batch_size):
        tokens, masks = collate(batch, pad_token_id)
        count = sum(example.target_count for example in batch)
        loss = supervised_loss(
            model, mx.array(tokens, dtype=mx.int32), mx.array(masks, dtype=mx.bool_)
        ).item()
        if not math.isfinite(loss):
            raise FloatingPointError("Non-finite holdout loss; adapter not finalized")
        total_loss += loss * count
        total_tokens += count
    if not total_tokens:
        raise ValueError("Holdout contains no supervised tokens")
    return total_loss / total_tokens


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def save_adapters(output, model, config, receipt):
    import mlx.core as mx
    from mlx.utils import tree_flatten

    weights = dict(tree_flatten(model.trainable_parameters()))
    if not weights or any(not value.size for value in weights.values()):
        raise ValueError("No nonempty trainable adapter tensors")
    for name, value in weights.items():
        if name.rsplit(".", 1)[-1] not in ("lora_a", "lora_b"):
            raise ValueError(f"Unexpected non-adapter trainable parameter: {name}")
        if not mx.all(mx.isfinite(value)).item():
            raise FloatingPointError(f"Non-finite adapter tensor: {name}")
    if not any(
        mx.any(value != 0).item()
        for name, value in weights.items() if name.endswith(".lora_b")
    ):
        raise ValueError("LoRA B tensors remain zero; no learned adapter update")

    staged = output / ".adapters.partial.safetensors"
    mx.save_safetensors(str(staged), weights)
    with staged.open("rb") as stream:
        os.fsync(stream.fileno())
    restored = mx.load(str(staged))
    if restored.keys() != weights.keys() or any(
        not mx.array_equal(restored[name], value).item() for name, value in weights.items()
    ):
        raise RuntimeError("Saved adapter tensors do not match trained tensors")
    write_json(output / ".adapter_config.partial.json", config)
    write_json(output / ".training_receipt.partial.json", receipt)
    # Hard-link publication is exclusive (unlike replace); never overwrite an
    # existing final artifact, even if another process creates it after startup.
    for temporary, final in (
        (".adapters.partial.safetensors", "adapters.safetensors"),
        (".adapter_config.partial.json", "adapter_config.json"),
        (".training_receipt.partial.json", "training_receipt.json"),
    ):
        os.link(output / temporary, output / final)
        (output / temporary).unlink()
    descriptor = os.open(output, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def run(job_path, event_stream):
    def log(message):
        emit(event_stream, {"type": "log", "message": message})

    job, source_path, model_path, output = read_job(job_path)
    recipe, dataset = job["run"]["recipe"], job["dataset"]
    examples = read_source(source_path, dataset)
    train, valid = deterministic_split(examples, dataset["holdout"])
    expected_train, expected_valid = split_counts(dataset["records"], dataset["holdout"])
    if (len(train), len(valid)) != (expected_train, expected_valid):
        raise RuntimeError("Split counts disagree with manifest")
    total_steps = optimizer_steps(
        len(train), recipe["batchSize"], recipe["accumulation"], recipe["epochs"]
    )
    split_directory = job_path.resolve().parent / "splits"
    write_splits(split_directory, train, valid)
    output.mkdir(mode=0o700, exist_ok=True)
    log(
        f"Verified SHA-256 and {len(examples)} examples; seed 42 split: "
        f"{len(train)} train, {len(valid)} holdout. {total_steps} optimizer updates."
    )
    log(f"Managed adapter output: {output}; recipe.outputPath is not used.")
    if recipe["method"] == "distillation":
        log("Distillation uses only pre-generated dataset responses; no teacher inference or KL loss.")
    log(f"Loading local MLX model from {model_path} (offline, custom code disabled).")

    import mlx.core as mx
    import mlx.nn as nn
    import mlx.optimizers as optim
    from mlx.utils import tree_flatten
    from mlx_lm.tuner.utils import linear_to_lora_layers

    if not mx.metal.is_available():
        raise RuntimeError("MLX Metal is unavailable; this worker requires Apple silicon macOS")
    mx.random.seed(42)
    model, tokenizer, model_config = load_local_model(model_path)
    context_limit = model_config.get("max_position_embeddings")
    if isinstance(context_limit, int) and recipe["maxSequence"] > context_limit:
        raise ValueError(
            f"maxSequence={recipe['maxSequence']} exceeds model context limit {context_limit}"
        )
    if dataset["format"] == "prompt-response" and not (
        tokenizer.chat_template
    ):
        log("Tokenizer has no chat template: using BOS + prompt + newline + response + EOS.")

    encoded_train = [
        encode_example(item, dataset["format"], tokenizer, recipe["maxSequence"])
        for item in train
    ]
    encoded_valid = [
        encode_example(item, dataset["format"], tokenizer, recipe["maxSequence"])
        for item in valid
    ]
    truncated = sum(item.truncated for item in encoded_train + encoded_valid)
    if truncated:
        log(
            f"Right-truncated {truncated} examples to {recipe['maxSequence']} tokens; "
            "every assistant response retains content targets."
        )
    pad = tokenizer.pad_token_id
    if pad is None:
        pad = tokenizer.eos_token_id
    if pad is None:
        raise ValueError("Tokenizer requires a pad_token_id or eos_token_id")
    vocab_size = model_config.get("vocab_size")
    if isinstance(vocab_size, int):
        if not 0 <= pad < vocab_size or any(
            not 0 <= token < vocab_size
            for example in encoded_train + encoded_valid for token in example.tokens
        ):
            raise ValueError("Tokenizer produces token IDs outside the model vocabulary")

    model.freeze()
    lora_parameters = {
        "rank": recipe["rank"],
        "scale": recipe["alpha"] / recipe["rank"],
        "dropout": 0.0,
    }
    num_layers = len(model.layers)
    linear_to_lora_layers(model, num_layers, lora_parameters)
    parameters = dict(tree_flatten(model.trainable_parameters()))
    if not parameters or any(
        name.rsplit(".", 1)[-1] not in ("lora_a", "lora_b") for name in parameters
    ):
        raise ValueError("Unsupported LoRA model: expected only trainable lora_a/lora_b tensors")
    log(
        f"Training {sum(value.size for value in parameters.values())} LoRA parameters "
        f"in {num_layers} layers; rank={recipe['rank']}, scale=alpha/rank="
        f"{lora_parameters['scale']}, Adam learning rate={recipe['learningRate']}."
    )
    optimizer = optim.Adam(learning_rate=recipe["learningRate"])
    loss_and_grad = nn.value_and_grad(model, supervised_loss)
    interval = (total_steps + 4999) // 5000
    step = 0
    window_loss, window_tokens = 0.0, 0
    train_loss = eval_loss = None
    epoch_metrics = []

    def progress(loss, evaluation, note):
        emit(event_stream, {
            "type": "progress", "step": step, "totalSteps": total_steps,
            "loss": loss, "evalLoss": evaluation, "note": note,
        })

    progress(None, None, "Prepared real training; step counts optimizer updates.")
    for epoch in range(recipe["epochs"]):
        order = list(encoded_train)
        random.Random(42 + epoch).shuffle(order)
        model.train()
        epoch_loss, epoch_tokens = 0.0, 0
        groups = accumulation_groups(order, recipe["batchSize"], recipe["accumulation"])
        for group in groups:
            measured, count = optimizer_update(model, optimizer, loss_and_grad, group, pad)
            step += 1
            epoch_loss += measured * count
            epoch_tokens += count
            window_loss += measured * count
            window_tokens += count
            if step % interval == 0 or step == total_steps:
                progress(window_loss / window_tokens, None, f"Epoch {epoch + 1}: optimizer update")
                window_loss, window_tokens = 0.0, 0
        train_loss = epoch_loss / epoch_tokens
        eval_loss = evaluate(model, encoded_valid, recipe["batchSize"], pad)
        epoch_metrics.append({
            "epoch": epoch + 1, "step": step, "loss": train_loss, "evalLoss": eval_loss,
        })
        progress(train_loss, eval_loss, f"Epoch {epoch + 1}: full held-out evaluation")
        mx.clear_cache()

    actual_steps = int(optimizer.step.item())
    if step != total_steps or actual_steps != total_steps:
        raise RuntimeError(
            f"Optimizer count mismatch: loop={step}, optimizer={actual_steps}, expected={total_steps}"
        )
    adapter_config = {
        "fine_tune_type": "lora",
        "num_layers": num_layers,
        "lora_parameters": lora_parameters,
        "model": str(model_path),
    }
    receipt = {
        "version": 1, "jobId": job["jobId"], "runId": job["run"].get("id"),
        "method": recipe["method"], "objective": recipe.get("objective"),
        "datasetId": dataset["id"], "sourceSha256": dataset["sha256"],
        "modelPath": str(model_path), "outputPath": str(output),
        "splitPath": str(split_directory), "seed": 42,
        "trainExamples": len(train), "holdoutExamples": len(valid),
        "trainSourceLines": [item.line for item in train],
        "holdoutSourceLines": [item.line for item in valid],
        "optimizerSteps": actual_steps, "totalSteps": total_steps,
        "epochs": recipe["epochs"], "batchSize": recipe["batchSize"],
        "accumulation": recipe["accumulation"], "learningRate": recipe["learningRate"],
        "maxSequence": recipe["maxSequence"], "truncatedExamples": truncated,
        "loss": train_loss, "evalLoss": eval_loss, "epochMetrics": epoch_metrics,
        "lossReduction": "response-token-weighted mean over each accumulation group",
        "packages": {
            name: importlib.metadata.version(name)
            for name in ("mlx", "mlx-lm", "transformers", "tokenizers")
        },
    }
    save_adapters(output, model, adapter_config, receipt)
    log(f"Saved trained adapters and reload configuration after {actual_steps} optimizer updates.")
    emit(event_stream, {"type": "complete"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--standalone", action="store_true", help="Disable stdin parent-liveness monitor")
    parser.add_argument("job", type=Path, help="Absolute version-1 job JSON path")
    args = parser.parse_args()
    if not args.standalone:
        monitor_parent()
    event_stream = sys.stdout
    # Libraries may print diagnostics; only the worker's protocol reaches stdout.
    with contextlib.redirect_stdout(sys.stderr):
        run(args.job, event_stream)


if __name__ == "__main__":
    main()
