"""Fail closed on an absent, incompatible, or incompletely installed CPU runtime."""
import importlib
import importlib.metadata
from pathlib import Path
import sys

if sys.version_info[:3] != (3, 14, 7):
    raise RuntimeError("The reproducible CPU gate requires Python 3.14.7.")
for line in (Path(__file__).resolve().parents[1] / "training/requirements.txt").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    package, expected = line.split("==")
    actual = importlib.metadata.version(package)
    if actual.split("+", 1)[0] != expected:
        raise RuntimeError(f"{package}: expected {expected}, installed {actual}")
    importlib.import_module(package)
print("Python 3.14.7: all pinned CPU dependencies imported. CUDA/QLoRA, MPS and MLX are NOT executed.")
