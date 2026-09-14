"""Explicit, offline PEFT training for a prepared Mamase bundle."""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import re

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

TRAINING_PACKAGES = ("torch", "transformers", "peft", "accelerate", "tokenizers", "safetensors", "numpy")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fingerprint(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint_tree(directory):
    return {str(path.relative_to(directory)): fingerprint(path) for path in sorted(directory.rglob("*")) if path.is_file()}


def validate_device_request(technique, device):
    require(device in ("cpu", "mps", "cuda"), "Unsupported device.")
    require(int(os.environ.get("WORLD_SIZE", "1")) == 1, "This runner supports one device, not distributed execution.")
    require(technique != "qlora" or device == "cuda", "QLoRA in this runner requires CUDA and bitsandbytes. Use LoRA, rsLoRA, or DoRA on CPU/MPS.")


def validate_device(torch, technique, device):
    validate_device_request(technique, device)
    require(device != "cuda" or torch.cuda.is_available(), "CUDA is not available.")
    require(device != "mps" or torch.backends.mps.is_available(), "MPS is not available.")
    if technique == "qlora":
        try:
            importlib.metadata.version("bitsandbytes")
        except importlib.metadata.PackageNotFoundError as error:
            raise RuntimeError("Install bitsandbytes on the CUDA machine for QLoRA.") from error


def load_local_tokenizer(model_dir):
    from transformers import AutoTokenizer

    try:
        tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    except Exception as error:
        # The Rust tokenizer decoder uses bare Exception for invalid serialized input.
        if type(error) is not Exception:
            raise
        raise ValueError(f"Cannot deserialize the local tokenizer: {error}. Supply a valid matching tokenizer snapshot.") from error
    if tokenizer.pad_token_id is None:
        require(tokenizer.eos_token_id is not None, "Tokenizer needs a pad or EOS token.")
        tokenizer.pad_token = tokenizer.eos_token
    return tokenizer


def load_local_model(model_dir, technique, device):
    import torch
    from transformers import AutoModelForCausalLM, BitsAndBytesConfig

    options = {"local_files_only": True, "trust_remote_code": False, "use_safetensors": True, "dtype": torch.float32}
    if technique == "qlora":
        options["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.float32)
        options["device_map"] = {"": 0}
    model = AutoModelForCausalLM.from_pretrained(model_dir, **options)
    if technique != "qlora":
        model.to(device)
    return model


def adapter_config(recipe):
    from peft import LoraConfig

    return LoraConfig(
        task_type="CAUSAL_LM", r=recipe["rank"], lora_alpha=recipe["alpha"],
        lora_dropout=0.0, bias="none", target_modules="all-linear",
        use_rslora=recipe["adapter"] == "rslora", use_dora=recipe["adapter"] == "dora",
    )


def package_versions(technique):
    return {name: importlib.metadata.version(name) for name in TRAINING_PACKAGES + (("bitsandbytes",) if technique == "qlora" else ())}


def validate_recipe(recipe):
    require(isinstance(recipe, dict), "Recipe must be an object.")
    require(recipe.get("adapter") in ("lora", "qlora", "rslora", "dora"), "Unsupported adapter.")
    require(recipe.get("method") in ("lora", "distillation"), "Unsupported training objective.")
    require(isinstance(recipe.get("student"), str) and recipe["student"].strip(), "Recipe student must be a nonempty model label.")
    bounds = {"rank": (4, 256), "alpha": (1, 1024), "epochs": (1, 100),
              "batchSize": (1, 128), "accumulation": (1, 1024), "maxSequence": (128, 131072)}
    for key, (minimum, maximum) in bounds.items():
        value = recipe.get(key)
        require(type(value) is int and minimum <= value <= maximum, f"Recipe {key} must be an integer in {minimum}..{maximum}.")
    require(recipe["rank"] in (4, 8, 16, 32, 64, 128, 256), "Recipe rank must be a power of two from 4 to 256.")
    rate = recipe.get("learningRate")
    require(type(rate) in (int, float) and math.isfinite(rate) and 0.00000001 <= rate <= 1,
            "Recipe learningRate must be finite and in 0.00000001..1.")


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def load_bundle(directory):
    directory = directory.resolve(strict=True)
    bundle = json.loads((directory / "bundle.json").read_text(encoding="utf-8"))
    require(isinstance(bundle, dict), "Bundle must be a JSON object.")
    require(bundle.get("schema") == "mamase.local-bundle.v1", "Unsupported bundle schema.")
    validate_recipe(bundle.get("recipe"))
    expected = {"train.jsonl", "holdout.jsonl", "identity.json", "recipe.json"}
    require(set(bundle["files"]) == expected, "Bundle file inventory is invalid.")
    for name, digest in bundle["files"].items():
        path = (directory / name).resolve(strict=True)
        require(path.parent == directory, f"Bundle file escapes its directory: {name}")
        require(fingerprint(path) == digest, f"Bundle fingerprint mismatch: {name}")
    manifest = json.loads((directory / "recipe.json").read_text(encoding="utf-8"))
    require(manifest["runId"] == bundle["runId"], "Recipe run ID mismatch.")
    require(all(manifest["recipe"].get(key) == value for key, value in bundle["recipe"].items()), "Recipe settings changed after preparation.")
    require(manifest["dataset"]["sha256"] == bundle["dataset"]["sha256"], "Recipe dataset fingerprint mismatch.")
    identity = json.loads((directory / "identity.json").read_text(encoding="utf-8"))
    for key in ("familiarId", "instanceId"):
        require(identity[key] == bundle["recipe"][key] == bundle["identity"][key], f"Identity mismatch: {key}")
    require(set(identity["files"]) == {"IDENTITY.md", "SOUL.md"}, "Identity files are incomplete.")
    for name, record in identity["files"].items():
        require(hashlib.sha256(record["content"].encode()).hexdigest() == record["sha256"], f"Identity snapshot mismatch: {name}")
        require(fingerprint(Path(record["path"])) == record["sha256"], f"Familiar identity changed: {name}. Prepare a new run.")
    declared_name = re.search(r"^\s*(?:-\s*)?(?:\*\*)?Name:(?:\*\*)?\s*(.+?)\s*$", identity["files"]["IDENTITY.md"]["content"], re.MULTILINE | re.IGNORECASE)
    require(declared_name is not None, "IDENTITY.md must declare a Name: line.")
    require(re.sub(r"[^a-z0-9_-]+", "-", declared_name[1].lower()) == identity["familiarId"].lower(), "Declared familiar name does not match the recipe.")
    rows = {}
    prompt_sets = {}
    canonical = f'Coven instance: {identity["instanceId"]}\nFamiliar ID: {identity["familiarId"]}\n\n{identity["files"]["IDENTITY.md"]["content"]}\n\n{identity["files"]["SOUL.md"]["content"]}'
    for split in ("train", "holdout"):
        rows[split] = [json.loads(line) for line in (directory / f"{split}.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
        require(len(rows[split]) == bundle["split"][split] > 0, f"Invalid {split} count.")
        prompt_sets[split] = set()
        for row in rows[split]:
            require(row["prompt"][0] == {"role": "system", "content": canonical}, "Training prompt contradicts identity snapshot.")
            require(not any(message["role"] == "system" for message in row["prompt"][1:]), "Unexpected system instruction.")
            require(len(row["completion"]) == 1 and row["completion"][0]["role"] == "assistant", "Invalid completion.")
            key = json.dumps(row["prompt"], ensure_ascii=False, sort_keys=True)
            require(key not in prompt_sets[split], "Duplicate prompt within a split.")
            prompt_sets[split].add(key)
    require(prompt_sets["train"].isdisjoint(prompt_sets["holdout"]), "Train/holdout prompt leakage.")
    if bundle["recipe"]["method"] == "distillation":
        require(bundle["dataset"]["kind"] == "teacher" and bundle["dataset"]["teacher"] == bundle["recipe"]["teacher"], "Teacher provenance mismatch.")
    return bundle, rows


def tokenize_rows(rows, tokenizer, max_length):
    require(tokenizer.chat_template, "The local tokenizer must declare a chat template.")
    result = []
    for row in rows:
        prefix = tokenizer.apply_chat_template(row["prompt"], tokenize=False, add_generation_prompt=True)
        full = tokenizer.apply_chat_template(row["prompt"] + row["completion"], tokenize=False, add_generation_prompt=False)
        require(isinstance(prefix, str) and prefix.strip() and isinstance(full, str), "Chat template must render a nonempty text prompt.")
        require(full.startswith(prefix), "Chat template has no stable prompt/completion boundary; use a compatible template.")
        require(all(message["content"].strip() in prefix for message in row["prompt"]), "Chat template drops or rewrites identity/prompt content; use a compatible template.")
        require(row["completion"][0]["content"].strip() in full[len(prefix):], "Chat template drops or rewrites completion content; use a compatible template.")
        prompt_ids = tokenizer.encode(prefix, add_special_tokens=False)
        input_ids = tokenizer.encode(full, add_special_tokens=False)
        require(input_ids[:len(prompt_ids)] == prompt_ids, "Tokenizer merges across the response boundary; cannot safely mask the prompt.")
        require(len(input_ids) <= max_length, f"Example has {len(input_ids)} tokens, exceeding maxSequence={max_length}. Shorten it or raise the limit; identity is never silently truncated.")
        require(len(input_ids) > len(prompt_ids), "Example has no completion tokens.")
        result.append({"input_ids": input_ids, "attention_mask": [1] * len(input_ids), "labels": [-100] * len(prompt_ids) + input_ids[len(prompt_ids):]})
    return result


class Progress:
    def __init__(self, path, run_id):
        self.path = path
        self.report = {"schema": "mamase.run-report.v1", "runId": run_id, "updates": []}
        self.step = 0
        self.total = 1

    def record(self, status, step, total, loss=None, eval_loss=None, note=""):
        require(0 <= step <= total and total >= 1, "Invalid trainer step counts.")
        require(step >= self.step, "Trainer steps went backwards.")
        for value in (loss, eval_loss):
            require(value is None or (math.isfinite(value) and value >= 0), "Trainer reported a non-finite or negative loss.")
        require(len(self.report["updates"]) < 10000, "Progress report limit reached.")
        self.step, self.total = step, total
        self.report["updates"].append({
            "status": status, "step": step, "totalSteps": total, "loss": loss,
            "evalLoss": eval_loss, "note": note,
            "recordedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        })
        write_json(self.path, self.report)


def train(args):
    bundle_dir = Path(args.bundle).resolve(strict=True)
    bundle, rows = load_bundle(bundle_dir)
    model_dir = Path(args.model).resolve(strict=True)
    require(model_dir.is_dir(), "--model must be an existing local model directory.")
    require(any(model_dir.glob("*.safetensors")), "A local safetensors model is required; pickle weights and remote code are not loaded.")
    try:
        import torch
        from peft import get_peft_model, prepare_model_for_kbit_training
        from transformers import Trainer, TrainerCallback, TrainingArguments, set_seed
    except ImportError as error:
        raise RuntimeError("Training dependencies are missing. Install training/requirements.txt in a local virtual environment (not the managed MLX runtime).") from error

    recipe = bundle["recipe"]
    validate_device(torch, recipe["adapter"], args.device)
    set_seed(42)
    tokenizer = load_local_tokenizer(model_dir)
    train_rows = tokenize_rows(rows["train"], tokenizer, recipe["maxSequence"])
    holdout_rows = tokenize_rows(rows["holdout"], tokenizer, recipe["maxSequence"])
    require(not (bundle_dir / "run-report.json").exists(), "This bundle already has a run. Prepare a new bundle for another attempt.")
    # One exclusive lock prevents simultaneous trainers from sharing outputs.
    with (bundle_dir / "training.lock").open("x") as lock:
        lock.write(str(os.getpid()))
    progress = Progress(bundle_dir / "run-report.json", bundle["runId"])
    try:
        require(not progress.path.exists(), "This bundle already has a run. Prepare a new bundle for another attempt.")
        require(not any((bundle_dir / name).exists() for name in ("adapter", "checkpoints", "result.json")), "Training outputs already exist. Prepare a new bundle instead of overwriting artifacts.")
        progress.record("running", 0, 1, note="Loading the local model; optimizer step count will be set by Trainer.")
        model_files = fingerprint_tree(model_dir)
        bundle_hash = fingerprint(bundle_dir / "bundle.json")
        model = load_local_model(model_dir, recipe["adapter"], args.device)
        model.config.use_cache = False

        def collate(features):
            width = max(len(row["input_ids"]) for row in features)
            return {
                key: torch.tensor([row[key] + [padding] * (width - len(row[key])) for row in features])
                for key, padding in (("input_ids", tokenizer.pad_token_id), ("attention_mask", 0), ("labels", -100))
            }

        def heldout_loss(candidate):
            candidate.eval()
            summed, tokens = 0.0, 0
            with torch.no_grad():
                for row in holdout_rows:
                    batch = {key: value.to(candidate.device) for key, value in collate([row]).items()}
                    count = int((batch["labels"][:, 1:] != -100).sum())
                    loss = float(candidate(**batch).loss)
                    require(count > 0 and math.isfinite(loss), "Holdout loss is invalid.")
                    summed += loss * count
                    tokens += count
            return summed / tokens

        base_loss = heldout_loss(model)
        if recipe["adapter"] == "qlora":
            model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=False)
        model = get_peft_model(model, adapter_config(recipe))
        trainable = sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad)
        total_parameters = sum(parameter.numel() for parameter in model.parameters())
        require(0 < trainable < total_parameters, "Expected a frozen base with trainable adapters.")

        class Reporter(TrainerCallback):
            def on_train_begin(self, training_args, state, control, **kwargs):
                require(state.max_steps <= 9990, "Run exceeds the 9,990-step local report budget. Split it into bounded experiments.")
                progress.record("running", 0, state.max_steps, eval_loss=base_loss, note="Base-model holdout loss before adaptation.")

            def on_log(self, training_args, state, control, logs=None, **kwargs):
                if logs and "loss" in logs:
                    progress.record("running", state.global_step, state.max_steps, loss=float(logs["loss"]), note="Observed optimizer-step training loss.")

        training_args = TrainingArguments(
            output_dir=str(bundle_dir / "checkpoints"),
            num_train_epochs=recipe["epochs"], per_device_train_batch_size=recipe["batchSize"],
            gradient_accumulation_steps=recipe["accumulation"], learning_rate=recipe["learningRate"],
            seed=42, data_seed=42, logging_steps=1, logging_strategy="steps",
            save_strategy="no", eval_strategy="no", report_to="none",
            use_cpu=args.device == "cpu", bf16=False, fp16=False,
            dataloader_num_workers=0, dataloader_pin_memory=False,
            optim="adamw_torch", disable_tqdm=True, logging_nan_inf_filter=False,
        )
        require(str(training_args.device).split(":")[0] == args.device, "Trainer selected a different device than requested.")
        trainer = Trainer(model=model, args=training_args, train_dataset=train_rows, data_collator=collate, processing_class=tokenizer, callbacks=[Reporter()])
        outcome = trainer.train()
        adapter_loss = heldout_loss(model)
        load_bundle(bundle_dir)
        require(fingerprint(bundle_dir / "bundle.json") == bundle_hash, "Bundle changed during training.")
        require(fingerprint_tree(model_dir) == model_files, "Base-model source changed during training.")
        adapter_dir = bundle_dir / "adapter"
        model.save_pretrained(adapter_dir, safe_serialization=True)
        tokenizer.save_pretrained(adapter_dir)
        weights = list(adapter_dir.glob("adapter_model*.safetensors"))
        require(weights, "Trainer did not save adapter weights.")
        metrics = {
            "schema": "mamase.training-result.v1", "runId": bundle["runId"],
            "familiar": bundle["identity"], "bundleSha256": bundle_hash,
            "baseModel": {"label": recipe["student"], "localPath": str(model_dir), "files": model_files},
            "adapter": {"path": str(adapter_dir), "technique": recipe["adapter"], "files": {path.name: fingerprint(path) for path in sorted(adapter_dir.iterdir()) if path.is_file()}},
            "datasetSha256": bundle["dataset"]["sha256"], "holdoutSha256": bundle["files"]["holdout.jsonl"],
            "evaluation": {
                "metric": "completion-token-weighted-negative-log-likelihood",
                "samples": len(holdout_rows), "baseLoss": base_loss, "adapterLoss": adapter_loss,
                "delta": adapter_loss - base_loss,
                "interpretation": "Lower loss is not proof of identity fidelity, task improvement, or permission to promote.",
            },
            "trainableParameters": trainable, "totalParameters": total_parameters,
            "optimizerSteps": outcome.global_step, "device": args.device, "seed": 42,
            "versions": package_versions(recipe["adapter"]),
            "python": platform.python_version(), "platform": platform.platform(),
            "promotion": "not-authorized",
        }
        write_json(bundle_dir / "result.json", metrics)
        progress.record("completed", trainer.state.global_step, trainer.state.max_steps, loss=float(outcome.training_loss), eval_loss=adapter_loss, note="Adapter and result.json saved. Identity/task evaluation and explicit promotion remain separate.")
        print(json.dumps({"adapter": str(adapter_dir), "result": str(bundle_dir / "result.json"), "report": str(progress.path)}))
    except (Exception, KeyboardInterrupt) as error:
        # Record failure, then propagate it; a failed run never looks completed.
        if progress.report["updates"] and progress.report["updates"][-1]["status"] == "running":
            progress.record("failed", progress.step, progress.total, note=f"Training stopped: {type(error).__name__}. See the terminal traceback.")
        raise
    finally:
        (bundle_dir / "training.lock").unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, help="Directory created by npm run lab -- prepare")
    parser.add_argument("--model", required=True, help="Compatible local safetensors model snapshot; never downloaded")
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    args = parser.parse_args()
    os.umask(0o077)
    train(args)


if __name__ == "__main__":
    main()
