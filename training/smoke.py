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


def run_smoke(output):
    import mlx.core as mx
    from mlx.utils import tree_flatten
    from mlx_lm.tuner.utils import load_adapters

    output = output.resolve()
    fixture = create_fixture(output / "fixture")
    job_directory = output / "job"
    job_directory.mkdir()
    source = Path(fixture["datasetPath"])
    model_path = Path(fixture["modelPath"])
    adapter_path = output / "adapters"
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
        events.append(json.loads(line[len("MAMASE_EVENT "):]))
    assert events[-1] == {"type": "complete"}
    progress = [event for event in events if event["type"] == "progress"]
    assert sorted({event["step"] for event in progress}) == [0, 1, 2, 3, 4]
    assert all(event["totalSteps"] == 4 for event in progress)
    evaluations = [event for event in progress if event["evalLoss"] is not None]
    assert [event["step"] for event in evaluations] == [2, 4]
    assert all(math.isfinite(event["evalLoss"]) for event in evaluations)

    model, tokenizer, _ = load_local_model(model_path)
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
    assert all(mx.array_equal(value, parameters[name]).item() for name, value in weights.items())
    b_max = max(
        mx.max(mx.abs(value)).item() for name, value in weights.items()
        if name.endswith(".lora_b")
    )
    assert b_max > 0
    learned_delta = max(
        mx.max(mx.abs(2.0 * (value @ weights[name[:-6] + "lora_b"]))).item()
        for name, value in weights.items() if name.endswith(".lora_a")
    )
    assert learned_delta > 0
    with (adapter_path / "training_receipt.json").open() as stream:
        receipt = json.load(stream)
    assert receipt["optimizerSteps"] == 4
    assert receipt["trainExamples"] == 7 and receipt["holdoutExamples"] == 2
    assert not set(receipt["trainSourceLines"]) & set(receipt["holdoutSourceLines"])
    evidence = {
        **fixture, "jobPath": str(job_path), "outputPath": str(adapter_path),
        "workerCommand": command, "optimizerSteps": 4,
        "trainExamples": 7, "holdoutExamples": 2,
        "adapterTensorCount": len(weights), "maxAbsLearnedB": b_max,
        "maxAbsLearnedWeightDelta": learned_delta,
        "maxAbsReloadedLogitDelta": logit_delta,
        "loss": evaluations[-1]["loss"], "evalLoss": evaluations[-1]["evalLoss"],
        "reload": "MLX-LM load_adapters; all saved tensors equal reloaded parameters",
    }
    write_json(output / "smoke_evidence.json", evidence)
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_directory", type=Path, help="Fresh directory for persistent smoke artifacts")
    run_smoke(parser.parse_args().output_directory)
