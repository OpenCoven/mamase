"""Read-only, offline readiness checks for prepared PEFT bundles, not MLX jobs."""

import sys

# Also suppress bytecode for our local helpers when invoked without python -B.
sys.dont_write_bytecode = True

import argparse
import contextlib
import hashlib
import importlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import struct

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

if __package__:
    from .data import optimizer_steps
    from .evaluate import context_limit, read_json, unique_object
    from .mlx_runner import validate_model_metadata, validate_tokenizer_metadata
    from .train import (
        TRAINING_PACKAGES, adapter_config, fingerprint, load_bundle,
        load_local_tokenizer, require, tokenize_rows, validate_device, validate_device_request,
    )
else:
    from data import optimizer_steps
    from evaluate import context_limit, read_json, unique_object
    from mlx_runner import validate_model_metadata, validate_tokenizer_metadata
    from train import (
        TRAINING_PACKAGES, adapter_config, fingerprint, load_bundle,
        load_local_tokenizer, require, tokenize_rows, validate_device, validate_device_request,
    )


class Report:
    def __init__(self):
        self.value = {
            "schema": "mamase.preflight.v1",
            "backend": "transformers-peft",
            "ready": False,
            "errors": [],
            "warnings": [],
            "facts": {},
            "skipped": [],
            "promotion": "not-authorized",
        }

    def error(self, code, message):
        self.value["errors"].append({"code": code, "message": str(message)})

    def warning(self, code, message):
        self.value["warnings"].append({"code": code, "message": message})

    def check(self, code, operation):
        try:
            return operation()
        except (ValueError, OSError, ImportError) as error:
            self.error(code, error)
            return None


def prepared_bundle(directory):
    require(directory.is_dir(), "--bundle must be an existing directory from npm run lab -- prepare; MLX job.json is not a PEFT bundle.")
    try:
        bundle, rows = load_bundle(directory)
    except (KeyError, TypeError, IndexError, AttributeError) as error:
        raise ValueError(f"Malformed prepared bundle ({error}); prepare a new bundle from the original recipe and source.") from error
    require(bundle.get("execution") == "not-started" and bundle.get("promotion") == "not-authorized",
            "Expected an unstarted, non-promoting bundle; prepare a new experiment.")
    return bundle, rows


def unused_bundle(directory):
    existing = [
        name for name in ("training.lock", "run-report.json", "adapter", "checkpoints", "result.json")
        if os.path.lexists(directory / name)
    ]
    require(not existing, f"Bundle already contains training state: {', '.join(existing)}. Preserve it and prepare a new bundle; preflight never removes outputs or locks.")
    return True


def safetensors_header(path):
    """Read only the bounded header; never deserialize or read tensor payloads."""
    sizes = {
        "BOOL": 1, "U8": 1, "I8": 1, "I16": 2, "U16": 2, "F16": 2,
        "BF16": 2, "I32": 4, "U32": 4, "F32": 4, "F64": 8, "I64": 8, "U64": 8,
    }
    size = path.stat().st_size
    with path.open("rb") as stream:
        prefix = stream.read(8)
        require(len(prefix) == 8, f"{path.name}: missing safetensors header.")
        length = struct.unpack("<Q", prefix)[0]
        require(0 < length <= 16 * 1024 * 1024 and length <= size - 8,
                f"{path.name}: invalid or oversized safetensors header.")
        raw = stream.read(length)
    header = json.loads(raw, object_pairs_hook=unique_object)
    require(isinstance(header, dict), f"{path.name}: invalid safetensors metadata.")
    if "__metadata__" in header:
        require(isinstance(header["__metadata__"], dict) and all(isinstance(value, str) for value in header["__metadata__"].values()),
                f"{path.name}: safetensors metadata values must be strings.")
    tensors = {key: value for key, value in header.items() if key != "__metadata__"}
    require(tensors, f"{path.name}: no tensors in the safetensors header.")
    intervals, parameters = [], 0
    for name, tensor in tensors.items():
        require(isinstance(tensor, dict), f"{path.name}: invalid tensor descriptor for {name}.")
        shape, offsets, dtype = tensor.get("shape"), tensor.get("data_offsets"), tensor.get("dtype")
        require(isinstance(dtype, str) and dtype in sizes, f"{path.name}: unsupported tensor dtype {dtype!r}; use an unquantized PEFT base snapshot.")
        require(isinstance(shape, list) and all(type(dim) is int and dim >= 0 for dim in shape),
                f"{path.name}: invalid shape for {name}.")
        require(isinstance(offsets, list) and len(offsets) == 2 and all(type(n) is int for n in offsets),
                f"{path.name}: invalid offsets for {name}.")
        start, end = offsets
        count = math.prod(shape)
        require(0 <= start <= end <= size - 8 - length and end - start == count * sizes[dtype],
                f"{path.name}: truncated or inconsistent tensor data for {name}.")
        intervals.append((start, end))
        parameters += count
    cursor = 0
    for start, end in sorted(intervals):
        require(start == cursor, f"{path.name}: overlapping tensors or gaps in the safetensors inventory.")
        cursor = end
    require(cursor == size - 8 - length, f"{path.name}: unaccounted tensor payload bytes.")
    require(parameters > 0, f"{path.name}: the model shard has no tensor elements.")
    return {
        "path": str(path.resolve(strict=True)), "bytes": size,
        "headerSha256": hashlib.sha256(prefix + raw).hexdigest(),
        "tensors": len(tensors), "elements": parameters,
    }, set(tensors)


def model_inventory(directory):
    require(directory.is_dir(), "--model must be an existing local snapshot directory, not a Hub ID or GGUF file.")
    require(not os.path.lexists(directory / "adapter_config.json"),
            "--model points to an adapter/redirect. Supply the complete local base snapshot, not adapter weights.")
    config, config_hash = read_json(directory / "config.json")
    tokenizer_config, tokenizer_hash = read_json(directory / "tokenizer_config.json")
    validate_model_metadata(config)
    validate_tokenizer_metadata(tokenizer_config)
    require(tokenizer_config.get("tokenizer_class") is None or isinstance(tokenizer_config["tokenizer_class"], str),
            "tokenizer_class must name a standard tokenizer, not a malformed configuration value.")
    require(tokenizer_config.get("model_file") is None, "Custom tokenizer model_file is unsupported; use a standard local snapshot.")
    require(not config.get("quantization_config") and not config.get("quantization"),
            "Pre-quantized/MLX base snapshots are unsupported by the PEFT runner. Use unquantized safetensors; select QLoRA with CUDA for runner-managed NF4.")
    require(not tokenizer_config.get("chat_template_type"),
            "Python chat_template_type is unsupported; supply a standard tokenizer with a local Jinja chat template.")
    single, index_path = directory / "model.safetensors", directory / "model.safetensors.index.json"
    require(single.is_file() or index_path.is_file(),
            "Missing model.safetensors or model.safetensors.index.json. GGUF, pickle/.bin, and adapter-only sources cannot be used.")
    require(not (single.exists() and index_path.exists()),
            "Both single-file and sharded weights are present. Supply one unambiguous base snapshot.")
    metadata = {"config.json": config_hash, "tokenizer_config.json": tokenizer_hash}
    weight_map = None
    if index_path.exists():
        index, metadata[index_path.name] = read_json(index_path)
        weight_map = index.get("weight_map")
        require(isinstance(weight_map, dict) and weight_map, "Invalid safetensors shard index: weight_map must be a nonempty object.")
        require(all(isinstance(name, str) and name.endswith(".safetensors") and Path(name).name == name and "/" not in name and "\\" not in name
                    for name in weight_map.values()), "Unsafe safetensors shard path; use filenames inside the selected snapshot.")
        filenames = sorted(set(weight_map.values()))
    else:
        filenames = [single.name]
    inventory, names = {}, set()
    for filename in filenames:
        record, tensors = safetensors_header(directory / filename)
        require(not names.intersection(tensors), f"Duplicate tensors across model shards: {filename}.")
        if weight_map is not None:
            require(tensors == {name for name, shard in weight_map.items() if shard == filename},
                    f"Safetensors shard index does not match the header of {filename}.")
        names.update(tensors)
        inventory[filename] = record
    # Enumerate only the selected snapshot, not subdirectories or model caches.
    tokenizer_files = {
        "tokenizer.json", "tokenizer.model", "special_tokens_map.json", "added_tokens.json",
        "vocab.json", "vocab.txt", "merges.txt", "chat_template.jinja", "tekken.json",
    }
    for name in sorted(tokenizer_files):
        path = directory / name
        if path.is_file():
            metadata[path.name] = fingerprint(path)
    return config, {
        "localPath": str(directory), "modelType": config.get("model_type"),
        "metadataSha256": metadata, "weights": inventory,
        "weightBytes": sum(record["bytes"] for record in inventory.values()),
        "tensorElements": sum(record["elements"] for record in inventory.values()),
        "identityScope": "Resolved local paths, metadata hashes, weight sizes and header hashes only; tensor payloads are neither read nor hashed. No Hub revision attestation.",
    }


def dependencies(report, technique):
    versions = {}
    names = (*TRAINING_PACKAGES, *(("bitsandbytes",) if technique == "qlora" else ()))
    for name in names:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            report.error("dependencies.missing", f"Missing {name} in {sys.executable}. Use the PEFT environment from training/requirements.txt (plus bitsandbytes on CUDA for QLoRA), not the managed MLX environment.")
    report.value["facts"]["dependencies"] = versions
    if len(versions) != len(names):
        return None
    try:
        torch = importlib.import_module("torch")
        # Import trainer APIs to expose incompatible installations, but never construct them.
        from transformers import AutoConfig, Trainer, TrainingArguments
        from peft import get_peft_model, prepare_model_for_kbit_training
        importlib.import_module("accelerate")
        if technique == "qlora":
            importlib.import_module("bitsandbytes")
    except (ImportError, OSError, RuntimeError) as error:
        report.error("dependencies.import", f"PEFT runtime cannot import its required APIs: {error}. Repair the selected local environment; no fallback runtime was selected.")
        return None
    return torch


def device_facts(torch, technique, device):
    try:
        validate_device(torch, technique, device)
    except RuntimeError as error:
        raise ValueError(str(error)) from error
    result = {"requested": device, "available": True, "basePrecision": "NF4" if technique == "qlora" else "float32"}
    if device == "cuda":
        # The training loader's QLoRA device_map is explicitly cuda:0.
        require(torch.cuda.current_device() == 0, "This runner expects CUDA device 0; choose visibility explicitly before launch.")
        capability = torch.cuda.get_device_capability(0)
        require(technique != "qlora" or capability[0] >= 6, "NF4 QLoRA requires a supported NVIDIA Pascal-or-newer CUDA device (compute capability >= 6.0).")
        result.update(name=torch.cuda.get_device_name(0), computeCapability=list(capability))
    return result


def tokenizer_and_context(directory):
    from transformers import AutoConfig
    from transformers.models.auto.modeling_auto import MODEL_FOR_CAUSAL_LM_MAPPING_NAMES

    try:
        config = AutoConfig.from_pretrained(directory, local_files_only=True, trust_remote_code=False)
        tokenizer = load_local_tokenizer(directory)
    except (TypeError, KeyError, AttributeError) as error:
        raise ValueError(f"Malformed local model/tokenizer configuration: {error}. Supply a matching standard snapshot.") from error
    require(config.model_type in MODEL_FOR_CAUSAL_LM_MAPPING_NAMES,
            f"Model type {config.model_type!r} has no standard Transformers causal-LM implementation.")
    text_config = config.get_text_config() if hasattr(config, "get_text_config") else config
    vocabulary = getattr(text_config, "vocab_size", None)
    require(type(vocabulary) is int and vocabulary > 0, "Model config must declare a positive vocab_size to check tokenizer compatibility.")
    require(all(type(value) is int and 0 <= value < vocabulary for value in tokenizer.get_vocab().values()),
            f"Tokenizer contains token IDs outside the model vocab_size={vocabulary}. Supply the matching model/tokenizer snapshot.")
    return tokenizer, context_limit(config, tokenizer)


def token_budget(rows, tokenizer, maximum, split):
    from jinja2 import TemplateError

    lengths, targets = [], []
    for index, row in enumerate(rows, 1):
        try:
            encoded = tokenize_rows([row], tokenizer, maximum)[0]
        except (ValueError, TemplateError) as error:
            raise ValueError(f"{split} example {index}: {error}") from error
        lengths.append(len(encoded["input_ids"]))
        targets.append(sum(label != -100 for label in encoded["labels"][1:]))
    return {"examples": len(rows), "minTokens": min(lengths), "maxTokens": max(lengths), "completionTokens": sum(targets)}


def local_directory(value, option):
    try:
        directory = Path(value).resolve(strict=True)
    except RuntimeError as error:
        # Python 3.10-3.12 report symlink loops as RuntimeError, not OSError.
        raise ValueError(f"Cannot resolve {option}: {error}") from error
    require(directory.is_dir(), f"{option} must be an existing local directory.")
    return directory


def preflight(args):
    report = Report()
    facts = report.value["facts"]
    facts["runtime"] = {"python": platform.python_version(), "executable": sys.executable, "platform": platform.system()}
    report.warning("scope.peft-only", "This command checks prepared identity-bound PEFT bundles only. Managed MLX jobs use mlx_runner.py and different data/adapter semantics; neither their launch nor browser hardware is certified here.")
    report.warning("scope.static", "No weights, model, adapters, optimizer, trainer or inference are instantiated. Tensor values, exact architecture/LoRA target compatibility, numerical behavior and peak memory remain unverified. Readiness is not an OOM guarantee or permission to train/promote.")
    if args.device not in ("cpu", "mps", "cuda"):
        report.error("device.unsupported", f"Unsupported device {args.device!r}. Choose cpu, mps or cuda explicitly; no fallback is selected.")
    bundle_dir = report.check("bundle.path", lambda: local_directory(args.bundle, "--bundle"))
    model_dir = report.check("model.path", lambda: local_directory(args.model, "--model"))
    prepared = report.check("bundle.invalid", lambda: prepared_bundle(bundle_dir)) if bundle_dir is not None else None
    if prepared is not None:
        bundle, rows = prepared
        recipe = bundle["recipe"]
        report.check("device.constraints", lambda: validate_device_request(recipe["adapter"], args.device))
        facts["bundle"] = {
            "path": str(bundle_dir), "runId": bundle["runId"], "sha256": fingerprint(bundle_dir / "bundle.json"),
            "files": bundle["files"], "identity": bundle["identity"],
            "datasetSha256": bundle["dataset"]["sha256"], "adapter": recipe["adapter"], "method": recipe["method"],
            "familiarContext": bundle.get("familiarContext", {"scope": "identity-files-only"}),
        }
        report.check("bundle.used", lambda: unused_bundle(bundle_dir))
        facts["plannedOptimizerSteps"] = optimizer_steps(len(rows["train"]), recipe["batchSize"], recipe["accumulation"], recipe["epochs"])
        if facts["plannedOptimizerSteps"] > 9990:
            report.error("recipe.steps", "Recipe exceeds the 9,990-step PEFT report budget. Reduce epochs or split into smaller experiments.")
        report.warning("source.dataset", "Preparation checked the original dataset; preflight verifies prepared split hashes and current bound identity files. The original dataset path is not stored and is not re-read. Instance ID and student label are operator-supplied, not externally attested.")
    else:
        recipe = None
    model = report.check("model.invalid", lambda: model_inventory(model_dir)) if model_dir is not None else None
    if model is not None:
        _, facts["model"] = model
        if recipe is not None:
            facts["model"]["recipeStudentLabel"] = recipe["student"]
    torch = dependencies(report, recipe["adapter"] if recipe else None)
    if torch is not None and recipe is not None:
        if args.device in ("cpu", "mps", "cuda"):
            device = report.check("device.unavailable", lambda: device_facts(torch, recipe["adapter"], args.device))
            if device is not None:
                facts["device"] = device
        configured = report.check("adapter.invalid", lambda: adapter_config(recipe))
        if configured is not None:
            facts["adapter"] = {"technique": recipe["adapter"], "rank": configured.r, "alpha": configured.lora_alpha, "targetModules": "all-linear"}
    else:
        report.value["skipped"].append("Device and adapter API checks require a valid recipe and importable PEFT dependencies.")
    if model is not None and torch is not None and recipe is not None:
        loaded = report.check("tokenizer.invalid", lambda: tokenizer_and_context(model_dir))
        if loaded is not None:
            tokenizer, limit = loaded
            facts["context"] = {"modelAndTokenizerLimit": limit, "maxSequence": recipe["maxSequence"]}
            if recipe["maxSequence"] > limit:
                report.error("context.overflow", f"maxSequence={recipe['maxSequence']} exceeds model/tokenizer context={limit}. Lower the recipe budget and prepare again; no truncation or context extension is assumed.")
            for split in ("train", "holdout"):
                budget = report.check("tokens.invalid", lambda: token_budget(rows[split], tokenizer, min(limit, recipe["maxSequence"]), split))
                if budget is not None:
                    facts.setdefault("tokens", {})[split] = budget
    else:
        report.value["skipped"].append("Tokenizer, template and token-budget checks require a valid bundle, local model inventory and importable PEFT dependencies.")
    report.value["ready"] = not report.value["errors"]
    return report.value


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def main(argv=None):
    parser = Parser(description=__doc__)
    parser.add_argument("--bundle", required=True, help="Existing directory produced by npm run lab -- prepare")
    parser.add_argument("--model", required=True, help="Existing local, unquantized safetensors base snapshot")
    parser.add_argument("--device", required=True, help="Explicit single device: cpu, mps or cuda (no fallback)")
    try:
        args = parser.parse_args(argv)
    except ValueError as error:
        report = Report()
        report.error("arguments.invalid", error)
        result = report.value
    else:
        # Libraries may print diagnostics; stdout is exclusively the JSON report.
        with contextlib.redirect_stdout(sys.stderr):
            result = preflight(args)
    print(json.dumps(result, indent=2, allow_nan=False))
    return 0 if result["ready"] else 1


if __name__ == "__main__":
    sys.exit(main())
