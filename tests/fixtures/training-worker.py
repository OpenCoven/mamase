"""Protocol fixture only; real optimization is exercised by the MLX smoke suite."""
import json
import pathlib
import sys
import time

job = json.loads(pathlib.Path(sys.argv[1]).read_text())
name = job["run"]["name"]

def emit(value):
    print("MAMASE_EVENT " + json.dumps(value), flush=True)

emit({"type": "log", "message": "Lifecycle test fixture, not a real training run."})
if name == "failure":
    raise RuntimeError("Deliberate worker failure")
if name == "cancel":
    time.sleep(30)
if name == "protocol":
    print("MAMASE_EVENT broken", flush=True)
    time.sleep(30)

steps = job["run"]["totalSteps"]
for step in range(1, steps + 1):
    time.sleep(0.2 if name == "Local training diagnostic" else 0.04)
    emit({"type": "progress", "step": step, "totalSteps": steps, "loss": 1 / step, "evalLoss": None})
if name != "missing-output":
    output = pathlib.Path(job["outputPath"])
    (output / "adapters.safetensors").write_bytes(b"protocol fixture, not real weights")
    (output / "adapter_config.json").write_text(json.dumps({"lora_parameters": {"rank": 4}}))
emit({"type": "complete"})
