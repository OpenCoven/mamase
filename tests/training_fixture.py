"""Tiny random local model for the Node test runner; no downloaded weights."""

import os
import json
from pathlib import Path
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

import torch
from peft import PeftModel
from safetensors.torch import load_file
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace
from transformers import AutoModelForCausalLM, AutoTokenizer, GenerationConfig, LlamaConfig, LlamaForCausalLM, PreTrainedTokenizerFast


mode, model_path = sys.argv[1:3]
if mode == "create":
    torch.manual_seed(42)
    words = ["<pad>", "<unk>", "</s>", "system", "user", "assistant", "[", "]", "Cody", "records", "observed", "result", ".", "Task", ":", "record", "evidence", "0", "1", "2", "3", "4", "5"]
    backend = Tokenizer(WordLevel({word: index for index, word in enumerate(words)}, unk_token="<unk>"))
    backend.pre_tokenizer = Whitespace()
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=backend, pad_token="<pad>", unk_token="<unk>", eos_token="</s>", model_max_length=512)
    tokenizer.chat_template = "{% for message in messages %}{{ '[' + message['role'] + '] ' + message['content'] + '\\n' }}{% if message['role'] == 'assistant' %}{{ '</s>\\n' }}{% endif %}{% endfor %}{% if add_generation_prompt %}{{ '[assistant] ' }}{% endif %}"
    tokenizer.save_pretrained(model_path)
    model = LlamaForCausalLM(LlamaConfig(vocab_size=len(words), hidden_size=32, intermediate_size=64, num_hidden_layers=1, num_attention_heads=2, num_key_value_heads=2, max_position_embeddings=512, pad_token_id=0, eos_token_id=2))
    model.save_pretrained(model_path, safe_serialization=True)
elif mode == "verify":
    adapter_path = Path(sys.argv[3])
    weights = load_file(adapter_path / "adapter_model.safetensors")
    assert any("lora_B" in name and torch.count_nonzero(value) > 0 for name, value in weights.items()), "Adapter did not learn an update."
    original = AutoModelForCausalLM.from_pretrained(model_path, local_files_only=True)
    adapted = PeftModel.from_pretrained(AutoModelForCausalLM.from_pretrained(model_path, local_files_only=True), adapter_path, local_files_only=True)
    for name, value in original.state_dict().items():
        module_name, parameter = name.rsplit(".", 1)
        module = adapted.base_model.model.get_submodule(module_name)
        base = getattr(module, "base_layer", module)
        assert torch.equal(value, getattr(base, parameter)), f"Frozen base changed: {name}"
    assert adapted(torch.tensor([[3, 4, 5]])).logits.shape == (1, 3, original.config.vocab_size)
elif mode == "evaluate-offline":
    import pickle
    import runpy
    import socket
    from unittest.mock import patch

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    sys.argv = ["training/evaluate.py", *sys.argv[3:]]
    blocked = AssertionError("Offline evaluation attempted network or pickle loading.")
    with (
        patch.object(socket.socket, "connect", side_effect=blocked),
        patch.object(socket.socket, "connect_ex", side_effect=blocked),
        patch.object(socket, "create_connection", side_effect=blocked),
        patch.object(torch, "load", side_effect=blocked),
        patch.object(pickle, "load", side_effect=blocked),
        patch.object(pickle, "loads", side_effect=blocked),
    ):
        runpy.run_module("training.evaluate", run_name="__main__")
elif mode == "verify-evaluation":
    bundle_dir, report_path = map(Path, sys.argv[3:5])
    report = json.loads(report_path.read_text())
    system = json.loads((bundle_dir / "train.jsonl").read_text().splitlines()[0])["prompt"][0]
    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
    for candidate in ("base", "adapter"):
        model = AutoModelForCausalLM.from_pretrained(model_path, local_files_only=True, trust_remote_code=False, use_safetensors=True, dtype=torch.float32)
        if candidate == "adapter":
            model = PeftModel.from_pretrained(model, report["adapterPath"], local_files_only=True)
        model.eval()
        for case in report["cases"]:
            text = tokenizer.apply_chat_template([system, {"role": "user", "content": case["prompt"]}], tokenize=False, add_generation_prompt=True)
            inputs = torch.tensor([tokenizer.encode(text, add_special_tokens=False)])
            with torch.inference_mode():
                generated = model.generate(
                    input_ids=inputs, attention_mask=torch.ones_like(inputs),
                    generation_config=GenerationConfig(
                        do_sample=False, num_beams=1, max_new_tokens=report["decoding"]["maxNewTokens"],
                        eos_token_id=tokenizer.eos_token_id, pad_token_id=tokenizer.pad_token_id,
                        bos_token_id=tokenizer.bos_token_id, use_cache=False,
                    ),
                )
            response = tokenizer.decode(generated[0, inputs.shape[1]:], skip_special_tokens=True, clean_up_tokenization_spaces=False)
            assert response == case[candidate]["response"], "Report does not contain the independently reloaded model's completion."
elif mode == "change-during-evaluation":
    from argparse import Namespace
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from training import evaluate

    bundle, suite, out = sys.argv[3:6]
    original = evaluate.generate_response
    changed = False

    def generate_and_change(*args, **kwargs):
        global changed
        response = original(*args, **kwargs)
        if not changed:
            path = Path(suite)
            path.write_bytes(path.read_bytes() + b"\n")
            changed = True
        return response

    evaluate.generate_response = generate_and_change
    evaluate.evaluate(Namespace(bundle=bundle, suite=suite, out=out, device="cpu", max_new_tokens=8))
else:
    raise ValueError("Expected create, verify, evaluate-offline, verify-evaluation, or change-during-evaluation.")
