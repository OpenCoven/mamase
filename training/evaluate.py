"""Offline, independent base/adapter string-rule evaluation; never authorizes promotion."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re

if __package__:
    from .train import (
        adapter_config, fingerprint, fingerprint_tree, load_bundle, load_local_model,
        load_local_tokenizer, package_versions, require, validate_device, write_json,
    )
else:
    from train import (
        adapter_config, fingerprint, fingerprint_tree, load_bundle, load_local_model,
        load_local_tokenizer, package_versions, require, validate_device, write_json,
    )

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

CATEGORIES = {"task", "identity", "consent", "tool-boundary"}
CHECK_TYPES = {"equals", "contains", "not_contains"}
SHA256 = re.compile(r"[a-f0-9]{64}")
MAX_REPORT_BYTES = 20_000_000


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, f"Duplicate JSON key: {key}")
        value[key] = item
    return value


def read_json(path, limit=16 * 1024 * 1024):
    with path.open("rb") as stream:
        source = stream.read(limit + 1)
    require(len(source) <= limit, "JSON file exceeds its size limit (suite limit: 1 MiB).")
    value = json.loads(
        source, object_pairs_hook=unique_object,
        parse_constant=lambda value: require(False, f"Non-finite JSON number: {value}"),
    )
    require(isinstance(value, dict), "Expected a JSON object.")
    return value, hashlib.sha256(source).hexdigest()


def trimmed(value):
    return re.sub(r"^[\s\ufeff]+|[\s\ufeff]+$", "", value)


def bounded_text(value, label, maximum, allow_empty=False):
    require(isinstance(value, str), f"{label} must be a string.")
    # Match the browser's UTF-16 length budget, including non-BMP characters.
    require(len(value.encode("utf-16-le")) // 2 <= maximum, f"{label} exceeds {maximum} characters.")
    require(allow_empty or trimmed(value), f"{label} must not be empty.")


def validate_checks(checks):
    require(isinstance(checks, list) and 1 <= len(checks) <= 20, "Each case needs 1..20 checks.")
    for check in checks:
        require(isinstance(check, dict) and set(check) == {"type", "value"}, "Invalid check object.")
        require(isinstance(check["type"], str) and check["type"] in CHECK_TYPES, "Unsupported check type; only equals, contains, and not_contains are allowed.")
        bounded_text(check["value"], "Check value", 2000)


def validate_suite(suite, rows):
    require(isinstance(suite, dict) and suite.get("schema") == "mamase.eval-suite.v1", "Unsupported evaluation suite schema.")
    bounded_text(suite.get("name"), "Suite name", 100)
    bounded_text(suite.get("version"), "Suite version", 80)
    cases = suite.get("cases")
    require(isinstance(cases, list) and 4 <= len(cases) <= 200, "A suite requires 4..200 cases.")
    source_prompts = {
        trimmed(message["content"])
        for split in ("train", "holdout") for row in rows[split]
        for message in row["prompt"] if message["role"] == "user"
    }
    identifiers, prompts, categories = set(), set(), set()
    for case in cases:
        require(isinstance(case, dict), "Invalid suite case.")
        identifier = case.get("id")
        require(isinstance(identifier, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", identifier), "Invalid case ID.")
        require(identifier not in identifiers, "Duplicate case ID.")
        category = case.get("category")
        require(isinstance(category, str) and category in CATEGORIES, "Unsupported case category.")
        bounded_text(case.get("prompt"), "Case prompt", 16000)
        prompt = trimmed(case["prompt"])
        require(prompt not in prompts, "Duplicate suite prompt after whitespace trimming.")
        require(prompt not in source_prompts, f"Suite case {identifier} overlaps a training or holdout user prompt.")
        validate_checks(case.get("checks"))
        identifiers.add(identifier)
        prompts.add(prompt)
        categories.add(category)
    require(categories == CATEGORIES, "The suite must cover task, identity, consent, and tool-boundary.")
    return suite


def load_suite(path, rows):
    suite, digest = read_json(path, 1024 * 1024)
    return validate_suite(suite, rows), digest


def score_response(response, checks):
    bounded_text(response, "Generated response", 64000, allow_empty=True)
    validate_checks(checks)
    return all(
        response == check["value"] if check["type"] == "equals"
        else check["value"] in response if check["type"] == "contains"
        else check["value"] not in response
        for check in checks
    )


def validate_max_new_tokens(value):
    require(type(value) is int and 1 <= value <= 512, "--max-new-tokens must be an integer in 1..512.")
    return value


def verify_inventory(directory, expected, label):
    require(isinstance(expected, dict) and expected, f"{label} file inventory is missing.")
    for name, digest in expected.items():
        path = Path(name)
        require(not path.is_absolute() and name == path.as_posix() and ".." not in path.parts and name not in ("", "."), f"Invalid {label} inventory path.")
        require(isinstance(digest, str) and SHA256.fullmatch(digest), f"Invalid {label} file fingerprint.")
    require(fingerprint_tree(directory) == expected, f"{label} fingerprint mismatch; files were added, removed, or changed.")
    require(not any(path.is_symlink() and path.is_dir() for path in directory.rglob("*")), f"{label} directory symlinks are unsupported.")


def load_completed_bundle(directory):
    require(not os.path.lexists(directory / "training.lock"), "Training must be completed and unlocked before evaluation.")
    result, result_hash = read_json(directory / "result.json")
    require(result.get("schema") == "mamase.training-result.v1", "Unsupported training result schema.")
    bundle_hash = fingerprint(directory / "bundle.json")
    require(result.get("bundleSha256") == bundle_hash, "Training result bundle fingerprint mismatch.")
    bundle, rows = load_bundle(directory)
    require(result.get("runId") == bundle["runId"], "Training result run ID mismatch.")
    require(result.get("familiar") == bundle["identity"], "Training result familiar identity mismatch.")
    require(result.get("datasetSha256") == bundle["dataset"]["sha256"], "Training result dataset fingerprint mismatch.")
    require(result.get("holdoutSha256") == bundle["files"]["holdout.jsonl"], "Training result holdout fingerprint mismatch.")
    require(result.get("promotion") == "not-authorized", "Training result must not authorize promotion.")
    require(result.get("seed") == 42, "Unsupported training seed.")
    progress, progress_hash = read_json(directory / "run-report.json")
    updates = progress.get("updates")
    require(progress.get("schema") == "mamase.run-report.v1" and progress.get("runId") == bundle["runId"], "Training progress lineage mismatch.")
    require(isinstance(updates, list) and updates and isinstance(updates[-1], dict) and updates[-1].get("status") == "completed", "Training progress must be completed before evaluation.")
    steps = updates[-1].get("step")
    require(type(steps) is int and steps > 0 and steps == updates[-1].get("totalSteps") == result.get("optimizerSteps"), "Completed training step counts mismatch.")
    base = result.get("baseModel")
    adapter = result.get("adapter")
    require(isinstance(base, dict) and isinstance(adapter, dict), "Training result model/adapter lineage is missing.")
    require(base.get("label") == bundle["recipe"]["student"], "Base-model label mismatch.")
    require(adapter.get("technique") == bundle["recipe"]["adapter"], "Adapter technique mismatch.")
    for record, key in ((base, "localPath"), (adapter, "path")):
        path = record.get(key)
        require(isinstance(path, str) and Path(path).is_absolute(), "Completed model and adapter paths must be absolute local directories.")
        require(Path(path).is_dir(), "Completed model or adapter directory is missing.")
    model_dir = Path(base["localPath"]).resolve(strict=True)
    adapter_dir = Path(adapter["path"]).resolve(strict=True)
    require(adapter_dir == directory / "adapter", "Adapter path must be the completed bundle's adapter.")
    verify_inventory(model_dir, base.get("files"), "Base-model")
    verify_inventory(adapter_dir, adapter.get("files"), "Adapter")
    require((adapter_dir / "adapter_model.safetensors").is_file(), "A local safetensors adapter is required; pickle loading is forbidden.")
    require((adapter_dir / "adapter_config.json").is_file(), "Adapter configuration is missing.")
    require(not (model_dir / "adapter_config.json").exists(), "The base snapshot must not redirect to another adapter/model.")
    require((model_dir / "model.safetensors").is_file() or (model_dir / "model.safetensors.index.json").is_file(), "A local safetensors base snapshot is required.")
    index_path = model_dir / "model.safetensors.index.json"
    if index_path.exists():
        index, _ = read_json(index_path)
        weights = index.get("weight_map")
        require(isinstance(weights, dict) and weights, "Invalid safetensors shard index.")
        require(all(isinstance(name, str) and name.endswith(".safetensors") and name in base["files"] for name in weights.values()), "Safetensors index references an unrecorded or unsafe shard.")
    config, _ = read_json(model_dir / "config.json")
    require(not config.get("quantization_config"), "Pre-quantized base snapshots are unsupported; use the training runner's QLoRA configuration.")
    return {
        "bundle": bundle, "rows": rows, "result": result, "resultSha256": result_hash,
        "progressSha256": progress_hash, "modelDir": model_dir, "adapterDir": adapter_dir,
    }


def context_limit(config, tokenizer):
    text_config = config.get_text_config() if hasattr(config, "get_text_config") else config
    limits = [
        getattr(text_config, key, None)
        for key in ("max_position_embeddings", "n_positions", "max_seq_len", "max_sequence_length", "seq_length")
    ]
    limits = [value for value in limits if type(value) is int and 0 < value < 10**9]
    require(limits, "Cannot establish the local model's context limit; refusing an unknown context budget.")
    token_limit = getattr(tokenizer, "model_max_length", None)
    if type(token_limit) is int and 0 < token_limit < 10**9:
        limits.append(token_limit)
    return min(limits)


def prepare_prompts(suite, rows, tokenizer, max_sequence, model_context, max_new_tokens):
    validate_max_new_tokens(max_new_tokens)
    require(type(max_sequence) is int and max_sequence > 0, "Invalid recipe maxSequence budget.")
    require(tokenizer.chat_template, "The local tokenizer must declare a chat template.")
    system = rows["train"][0]["prompt"][0]
    prompts = []
    for case in suite["cases"]:
        messages = [system, {"role": "user", "content": case["prompt"]}]
        plain = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
        prefix = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        require(isinstance(prefix, str) and prefix.strip(), "Chat template produced an empty generation prefix.")
        require(isinstance(plain, str) and prefix.startswith(plain) and prefix != plain, "Chat template must append an explicit assistant generation prefix.")
        tokens = tokenizer.encode(prefix, add_special_tokens=False)
        plain_tokens = tokenizer.encode(plain, add_special_tokens=False)
        require(tokens and tokens != plain_tokens, "Tokenizer produced an empty or missing generation prefix.")
        total = len(tokens) + max_new_tokens
        require(total <= max_sequence and total <= model_context, f"Case {case['id']} needs {total} tokens including generation; exceeds maxSequence={max_sequence} or model context={model_context}. Identity and prompts are never silently truncated.")
        prompts.append(tokens)
    return prompts


def generate_response(model, tokenizer, prompt, max_new_tokens):
    import torch
    from transformers import GenerationConfig

    input_ids = torch.tensor([prompt], dtype=torch.long, device=model.device)
    # A fresh config excludes checkpoint-specific sampling, stopping, or forced-token overrides.
    decoding = GenerationConfig(
        do_sample=False, num_beams=1, max_new_tokens=max_new_tokens,
        pad_token_id=tokenizer.pad_token_id, eos_token_id=tokenizer.eos_token_id,
        bos_token_id=tokenizer.bos_token_id, use_cache=False,
    )
    with torch.inference_mode():
        output = model.generate(input_ids=input_ids, attention_mask=torch.ones_like(input_ids), generation_config=decoding)
    require(output.ndim == 2 and output.shape[0] == 1, "Generation returned an unexpected sequence count.")
    require(torch.equal(output[0, :len(prompt)], input_ids[0]), "Generation did not preserve the input prefix.")
    completion = output[0, len(prompt):]
    require(0 < len(completion) <= max_new_tokens, "Generation returned no new tokens or exceeded the decoding budget.")
    response = tokenizer.decode(completion, skip_special_tokens=True, clean_up_tokenization_spaces=False)
    bounded_text(response, "Generated response", 64000, allow_empty=True)
    return response


def restore_adapter(model, recipe, adapter_dir):
    from peft import get_peft_model, get_peft_model_state_dict, prepare_model_for_kbit_training, set_peft_model_state_dict
    from safetensors.torch import load_file

    if recipe["adapter"] == "qlora":
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=False)
    model = get_peft_model(model, adapter_config(recipe))
    saved, _ = read_json(adapter_dir / "adapter_config.json")
    expected = model.peft_config["default"].to_dict()
    # Reconstruct only the trainer's known LoRA configuration, not arbitrary adapter initialization.
    ignored = {"inference_mode", "peft_version"}
    normalized = lambda value: sorted(value) if isinstance(value, (set, list)) else value
    require(
        {key: normalized(value) for key, value in saved.items() if key not in ignored}
        == {key: normalized(value) for key, value in expected.items() if key not in ignored},
        "Saved adapter configuration differs from the supported training recipe.",
    )
    weights = load_file(adapter_dir / "adapter_model.safetensors", device="cpu")
    expected_weights = get_peft_model_state_dict(model, save_embedding_layers=False)
    require(set(weights) == set(expected_weights), "Saved adapter tensor inventory does not match the training recipe.")
    require(all(weights[key].shape == expected_weights[key].shape for key in weights), "Saved adapter tensor shapes mismatch.")
    loaded = set_peft_model_state_dict(model, weights)
    require(not loaded.unexpected_keys, "Unexpected adapter tensors during loading.")
    model.requires_grad_(False)
    return model


def write_report(out, report):
    out.mkdir(mode=0o700)
    staged = out / ".evaluation-report.json"
    try:
        write_json(staged, report)
        require(staged.stat().st_size <= MAX_REPORT_BYTES, "Serialized evaluation report exceeds the 20 MB (20,000,000-byte) limit. Use fewer cases or a smaller --max-new-tokens budget.")
        # An exclusive hard link publishes only a fully written report, never replacing a file.
        os.link(staged, out / "evaluation-report.json")
    finally:
        staged.unlink(missing_ok=True)
        staged.with_suffix(".tmp").unlink(missing_ok=True)
    return out / "evaluation-report.json"


def evaluate(args):
    os.umask(0o077)
    max_new_tokens = validate_max_new_tokens(args.max_new_tokens)
    requested_out = Path(args.out).absolute()
    parent = requested_out.parent.resolve(strict=True)
    require(parent.is_dir(), "Evaluation output parent must already be a directory.")
    out = parent / requested_out.name
    require(not os.path.lexists(out), "Evaluation output already exists; refusing to overwrite.")
    bundle_dir = Path(args.bundle).resolve(strict=True)
    suite_path = Path(args.suite).absolute()
    source = load_completed_bundle(bundle_dir)
    suite, suite_hash = load_suite(suite_path, source["rows"])
    require(not any(out.is_relative_to(source[key]) for key in ("modelDir", "adapterDir")), "Evaluation output must not modify the model or adapter snapshot.")
    try:
        import torch
        from transformers import set_seed
    except ImportError as error:
        raise RuntimeError("Evaluation dependencies are missing. Use the training/requirements.txt virtual environment (not the managed MLX runtime).") from error
    recipe = source["bundle"]["recipe"]
    validate_device(torch, recipe["adapter"], args.device)
    set_seed(42)
    torch.use_deterministic_algorithms(True)
    tokenizer = load_local_tokenizer(source["modelDir"])
    model = load_local_model(source["modelDir"], recipe["adapter"], args.device)
    require(not model.config.is_encoder_decoder, "Evaluation supports causal language models only.")
    prompts = prepare_prompts(suite, source["rows"], tokenizer, recipe["maxSequence"], context_limit(model.config, tokenizer), max_new_tokens)
    cases = [
        {key: case[key] for key in ("id", "category", "prompt", "checks")}
        for case in suite["cases"]
    ]
    for candidate in ("base", "adapter"):
        if candidate == "adapter":
            model = restore_adapter(model, recipe, source["adapterDir"])
        model.eval()
        set_seed(42)
        for case, prompt in zip(cases, prompts):
            response = generate_response(model, tokenizer, prompt, max_new_tokens)
            case[candidate] = {"response": response, "passed": score_response(response, case["checks"])}
    # Revalidate exact bytes and all original identity/model/adapter sources after inference.
    current = load_completed_bundle(bundle_dir)
    require(current == source, "Training result or source provenance changed during evaluation.")
    require(fingerprint(suite_path) == suite_hash, "Suite changed during evaluation.")
    result = source["result"]
    report = {
        "schema": "mamase.evaluation-report.v1", "runId": result["runId"],
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "resultSha256": source["resultSha256"], "bundleSha256": result["bundleSha256"],
        "datasetSha256": result["datasetSha256"],
        "familiar": {key: result["familiar"][key] for key in ("familiarId", "instanceId")},
        "adapterPath": result["adapter"]["path"],
        "suite": {"name": suite["name"], "version": suite["version"], "sha256": suite_hash},
        "decoding": {"doSample": False, "numBeams": 1, "maxNewTokens": max_new_tokens, "seed": 42},
        "device": args.device, "versions": package_versions(recipe["adapter"]),
        "promotion": "not-authorized", "cases": cases,
        "summary": {
            "samples": len(cases), "basePassed": sum(case["base"]["passed"] for case in cases),
            "adapterPassed": sum(case["adapter"]["passed"] for case in cases),
            "regressions": sum(case["base"]["passed"] and not case["adapter"]["passed"] for case in cases),
        },
        "interpretation": "Case-sensitive string-rule checks are narrow proxies, not proof of semantic correctness, identity fidelity, consent, or safe tool use. This independent suite is distinct from training holdout loss and does not authorize deployment or promotion.",
    }
    return write_report(out, report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, help="Prepared bundle with completed result.json and run-report.json")
    parser.add_argument("--suite", required=True, help="Independent, versioned mamase.eval-suite.v1 JSON file")
    parser.add_argument("--out", required=True, help="New private output directory; its parent must already exist")
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    parser.add_argument("--max-new-tokens", type=int, default=128)
    args = parser.parse_args()
    report_path = evaluate(args)
    print(json.dumps({"report": str(report_path), "promotion": "not-authorized"}))


if __name__ == "__main__":
    main()
