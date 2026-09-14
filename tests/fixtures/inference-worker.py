"""Protocol-only inference fixture. Real MLX is covered by test_local_inference.py."""
import json
import os
from pathlib import Path
import signal
import sys
import time

request = json.loads(sys.stdin.buffer.readline())
mode = json.loads((Path(request["modelPath"]) / "fixture.json").read_text())["mode"]
(Path(request["modelPath"]) / "worker.pid").write_text(str(os.getpid()))


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


emit({"type": "status", "message": "loading"})
if mode == "stubborn":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
emit({"type": "status", "message": "generating"})
if mode in ("hang", "stubborn"):
    time.sleep(60)
elif mode == "error":
    emit({"type": "error", "message": "Fixture rejected this model."})
    time.sleep(60)
elif mode == "stderr":
    print("PRIVATE PROMPT AND OUTPUT DIAGNOSTIC", file=sys.stderr, flush=True)
    raise SystemExit(7)
elif mode == "stderr-limit":
    sys.stderr.write("s" * 100000)
    sys.stderr.flush()
    time.sleep(60)
elif mode == "malformed":
    print("not json", flush=True)
    time.sleep(60)
elif mode == "utf8":
    sys.stdout.buffer.write(b'{"type":"token","text":"\xff"}\n')
    sys.stdout.buffer.flush()
elif mode == "oversized":
    print("x" * 70000, flush=True)
elif mode == "output-limit":
    for _ in range(100):
        emit({"type": "token", "text": "x" * 4096})
elif mode == "missing":
    emit({"type": "token", "text": "partial"})
elif mode == "partial":
    sys.stdout.write('{"type":"token","text":"unfinished')
    sys.stdout.flush()
else:
    text = "repeat\nrepeat\n\n\u00e9\U0001f431"
    line = (json.dumps({"type": "token", "text": text}, ensure_ascii=False) + "\n").encode()
    for byte in line:
        sys.stdout.buffer.write(bytes([byte]))
        sys.stdout.buffer.flush()
        time.sleep(0.001)
    complete = {"type": "complete", "finishReason": "length", "promptTokens": 7, "generatedTokens": request["maxTokens"]}
    if mode == "counts":
        complete["generatedTokens"] = request["maxTokens"] + 1
    emit(complete)
    if mode == "after":
        emit({"type": "token", "text": "not allowed"})
    if mode == "exit":
        raise SystemExit(4)
    if mode == "delayed-exit":
        time.sleep(0.5)
