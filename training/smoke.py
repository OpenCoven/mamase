#!/usr/bin/env python3
"""Real offline worker/backpropagation/reload smoke; never mocks the worker."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys

if __package__:
    from .create_smoke_fixture import create_fixture
    from .mlx_runner import load_local_model, write_json
else:
    from create_smoke_fixture import create_fixture
    from mlx_runner import load_local_model, write_json


def verify_adapter(model_path, adapter_path):
    import mlx.core as mx
    from mlx.utils import tree_flatten
    from mlx_lm.tuner.utils import load_adapters

    model_path = model_path.resolve()
    adapter_path = adapter_path.resolve()
    config = json.loads((adapter_path / "adapter_config.json").read_text())
    assert config["fine_tune_type"] == "lora"
    assert config["model"] == str(model_path)
    scale = config["lora_parameters"]["scale"]
    assert scale > 0 and math.isfinite(scale)
    model, tokenizer, _ = load_local_model(model_path)
    assert config["num_layers"] == len(model.layers)
    prompt = tokenizer.apply_chat_template(
        [{"role": "user", "content": "Say red."}],
        add_generation_prompt=True, return_dict=False,
    )
    inputs = mx.array([prompt])
    before = model(inputs)
    mx.eval(before)
    load_adapters(model, str(adapter_path))
    model.eval()
    after = model(inputs)
    logit_delta = mx.max(mx.abs(after - before)).item()
    assert logit_delta > 0 and math.isfinite(logit_delta)
    weights = mx.load(str(adapter_path / "adapters.safetensors"))
    parameters = dict(tree_flatten(model.parameters()))
    assert weights and all(mx.all(mx.isfinite(value)).item() for value in weights.values())
    assert all(mx.array_equal(value, parameters[name]).item() for name, value in weights.items())
    b_max = max(
        mx.max(mx.abs(value)).item() for name, value in weights.items()
        if name.endswith(".lora_b")
    )
    assert b_max > 0
    learned_delta = max(
        mx.max(mx.abs(scale * (value @ weights[name[:-6] + "lora_b"]))).item()
        for name, value in weights.items() if name.endswith(".lora_a")
    )
    assert learned_delta > 0 and math.isfinite(learned_delta)
    return {
        "adapterTensorCount": len(weights), "maxAbsLearnedB": b_max,
        "maxAbsLearnedWeightDelta": learned_delta,
        "maxAbsReloadedLogitDelta": logit_delta,
        "rank": config["lora_parameters"]["rank"], "scale": scale,
        "reload": "MLX-LM load_adapters; all saved tensors equal reloaded parameters",
    }


def run_smoke(output):
    output = output.resolve()
    fixture = create_fixture(output / "fixture")
    job_directory = output / "job"
    job_directory.mkdir()
    source = Path(fixture["datasetPath"])
    model_path = Path(fixture["modelPath"])
    adapter_path = output / "adapters"
    adapter_path.mkdir(mode=0o700)
    job = {
        "version": 1, "jobId": "real-mlx-smoke",
        "run": {
            "id": "smoke-run", "name": "Random fixture: NOT FOR PRODUCTION",
            "recipe": {
                "method": "lora", "programId": "smoke", "datasetId": "smoke-data",
                "student": "tiny-random-llama", "teacher": None,
                "rank": 2, "alpha": 4, "learningRate": 0.01, "epochs": 2,
                "batchSize": 2, "accumulation": 3, "maxSequence": 96,
                "outputPath": "/not-used-by-worker", "objective": "supervised",
            },
        },
        "dataset": {
            "id": "smoke-data", "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "records": 9, "format": "messages", "kind": "curated",
            "teacher": None, "holdout": 25,
        },
        "sourcePath": str(source), "modelPath": str(model_path),
        "outputPath": str(adapter_path),
    }
    job_path = job_directory / "job.json"
    write_json(job_path, job)
    command = [
        sys.executable, "-u", str(Path(__file__).with_name("mlx_runner.py")),
        "--standalone", str(job_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    (output / "worker.stdout.log").write_text(result.stdout, encoding="utf-8")
    (output / "worker.stderr.log").write_text(result.stderr, encoding="utf-8")
    if result.returncode:
        raise RuntimeError(f"Real worker failed ({result.returncode}):\n{result.stderr}\n{result.stdout}")
    events = []
    for line in result.stdout.splitlines():
        if not line.startswith("MAMASE_EVENT "):
            raise AssertionError(f"Non-protocol stdout: {line}")
        events.append(json.loads(line[13:]))
    assert events[-1] == {"type": "complete"}
    progress = [event for event in events if event["type"] == "progress"]
    assert sorted({event["step"] for event in progress}) == [0, 1, 2, 3, 4]
    assert all(event["totalSteps"] == 4 for event in progress)
    assert progress[-1]["step"] == 4
    evaluations = [event for event in progress if event["evalLoss"] is not None]
    assert [event["step"] for event in evaluations] == [2, 4]
    assert all(math.isfinite(event["evalLoss"]) for event in evaluations)

    reload_evidence = verify_adapter(model_path, adapter_path)
    assert reload_evidence["rank"] == 2 and reload_evidence["scale"] == 2
    with (adapter_path / "training_receipt.json").open() as stream:
        receipt = json.load(stream)
    assert receipt["optimizerSteps"] == 4
    assert receipt["trainExamples"] == 7 and receipt["holdoutExamples"] == 2
    assert receipt["splitPath"] == str(source.parent)
    assert len((source.parent / "train.jsonl").read_text().splitlines()) == 7
    assert len((source.parent / "valid.jsonl").read_text().splitlines()) == 2
    assert not set(receipt["trainSourceLines"]) & set(receipt["holdoutSourceLines"])
    evidence = {
        **fixture, "jobPath": str(job_path), "outputPath": str(adapter_path),
        "workerCommand": command, "optimizerSteps": 4,
        "trainExamples": 7, "holdoutExamples": 2,
        **reload_evidence,
        "loss": evaluations[-1]["loss"], "evalLoss": evaluations[-1]["evalLoss"],
    }
    write_json(output / "smoke_evidence.json", evidence)
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_directory", nargs="?", type=Path, help="Fresh directory for persistent smoke artifacts")
    parser.add_argument("--verify-adapter", nargs=2, type=Path, metavar=("MODEL", "ADAPTER"),
                        help="Reload existing diagnostic output without launching another training job")
    arguments = parser.parse_args()
    if bool(arguments.output_directory) == bool(arguments.verify_adapter):
        parser.error("Choose an output directory or --verify-adapter MODEL ADAPTER")
    if arguments.verify_adapter:
        print(json.dumps(verify_adapter(*arguments.verify_adapter)))
    else:
        run_smoke(arguments.output_directory)
