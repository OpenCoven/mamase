#!/usr/bin/env python3
"""One offline, managed MLX text reply; stdin and stdout are private NDJSON."""

import contextlib
import json
import math
import os
from pathlib import Path
import sys

os.environ.update({
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "DO_NOT_TRACK": "1",
    "TOKENIZERS_PARALLELISM": "false",
    "MLXLM_USE_MODELSCOPE": "False",
})

if __package__:
    from .mlx_runner import monitor_parent, validate_model_metadata, validate_tokenizer_metadata
else:
    from mlx_runner import monitor_parent, validate_model_metadata, validate_tokenizer_metadata

CONFIG_BYTES = 128 * 1024
CONTEXT_KEYS = (
    "max_position_embeddings", "n_positions", "max_seq_len",
    "max_sequence_length", "seq_length",
)


class InferenceError(ValueError):
    """An actionable diagnostic that cannot contain conversation text."""


def require(condition, message):
    if not condition:
        raise InferenceError(message)


def emit(stream, event):
    stream.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
    stream.flush()


def read_config(path):
    require(path.is_file() and not path.is_symlink(), "Restore the original regular model/adapter configuration files.")
    with path.open("rb") as stream:
        data = stream.read(CONFIG_BYTES + 1)
    require(0 < len(data) <= CONFIG_BYTES, "Model/adapter JSON configuration must be at most 128 KiB.")
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError):
        raise InferenceError("Invalid local model/adapter JSON configuration.") from None
    require(isinstance(value, dict), "Model/adapter configuration must be a JSON object.")
    return value


def local_directory(value):
    require(isinstance(value, str) and Path(value).is_absolute(), "Model and adapter must be absolute local directories.")
    path = Path(value)
    require(path.is_dir() and not path.is_symlink(), "Restore the original local model/adapter directory; symlinks are unsupported.")
    return path.resolve()


def validate_request(request):
    fields = {"jobId", "variant", "messages", "temperature", "maxTokens", "seed", "modelPath", "adapterPath"}
    require(isinstance(request, dict) and set(request) == fields, "Invalid managed inference request fields.")
    require(request["variant"] in ("adapter", "base"), "variant must be adapter or base.")
    require(isinstance(request["jobId"], str) and request["jobId"].startswith("job-"), "A managed jobId is required.")
    require(type(request["temperature"]) in (int, float) and math.isfinite(request["temperature"]) and 0 <= request["temperature"] <= 2, "temperature must be between 0 and 2.")
    require(type(request["maxTokens"]) is int and 1 <= request["maxTokens"] <= 2048, "maxTokens must be 1..2048.")
    require(type(request["seed"]) is int and 0 <= request["seed"] <= 0xffffffff, "seed must be a uint32 integer.")
    messages = request["messages"]
    require(isinstance(messages, list) and 1 <= len(messages) <= 32, "Provide 1 to 32 conversation messages.")
    expected, characters = "user", 0
    for index, message in enumerate(messages):
        require(isinstance(message, dict) and set(message) == {"role", "content"}, "Messages support only role and text content.")
        text = message["content"]
        require(isinstance(text, str) and bool(text.strip()), "Messages must contain nonempty text.")
        try:
            characters += len(text.encode("utf-16-le")) // 2
        except UnicodeError:
            raise InferenceError("Messages must contain valid Unicode.") from None
        require(characters <= 32000, "Conversation exceeds 32000 characters. Start a shorter conversation.")
        if index == 0 and message["role"] == "system":
            continue
        require(message["role"] == expected, "Use alternating user/assistant messages with an optional system message only first.")
        expected = "assistant" if expected == "user" else "user"
    require(messages[-1]["role"] == "user", "The final message must be a user message.")


def load_managed_model(request):
    model_path = local_directory(request["modelPath"])
    adapter_path = local_directory(request["adapterPath"])
    config = read_config(model_path / "config.json")
    tokenizer_config = read_config(model_path / "tokenizer_config.json")
    try:
        validate_model_metadata(config)
        validate_tokenizer_metadata(tokenizer_config)
    except ValueError:
        raise InferenceError("Only standard text-only causal models and tokenizers without custom code are supported.") from None
    require(not tokenizer_config.get("chat_template_type"), "Python chat templates are unsupported. Supply the model's original Jinja chat template.")
    weights = list(model_path.glob("model*.safetensors"))
    require(bool(weights) and all(path.is_file() and not path.is_symlink() and path.stat().st_size for path in weights), "Restore all original local model*.safetensors weights.")
    adapter_config = read_config(adapter_path / "adapter_config.json")
    adapter_weights_path = adapter_path / "adapters.safetensors"
    require(adapter_weights_path.is_file() and not adapter_weights_path.is_symlink(), "Restore the finalized adapters.safetensors file.")
    if request["variant"] == "adapter":
        require(adapter_config.get("fine_tune_type", "lora") == "lora" and
                type(adapter_config.get("num_layers")) is int and adapter_config["num_layers"] > 0 and
                isinstance(adapter_config.get("lora_parameters"), dict),
                "The managed adapter must contain a valid MLX LoRA configuration.")
        require(not adapter_config.get("model") or Path(adapter_config["model"]).resolve() == model_path,
                "The adapter configuration refers to a different base model. Restore its original model.")

    import mlx.core as mx
    from mlx.utils import tree_flatten
    from mlx_lm import load

    require(mx.metal.is_available(), "MLX Metal is unavailable; local inference requires Apple silicon macOS.")
    model, tokenizer, loaded_config = load(
        str(model_path),
        adapter_path=str(adapter_path) if request["variant"] == "adapter" else None,
        model_config={**config, "model_file": None},
        tokenizer_config={
            "trust_remote_code": False, "local_files_only": True,
            "chat_template_type": None, "tool_parser_type": None,
        },
        return_config=True,
    )
    if request["variant"] == "adapter":
        # MLX-LM loads adapters with strict=False. Verify every expected tensor
        # explicitly so missing, mismatched or ignored weights cannot look successful.
        saved = mx.load(str(adapter_weights_path))
        applied = {
            name: value for name, value in tree_flatten(model.parameters())
            if name.rsplit(".", 1)[-1] in ("lora_a", "lora_b")
        }
        require(bool(saved) and saved.keys() == applied.keys(), "Adapter tensor names do not match this base model's LoRA layers.")
        require(all(value.size and mx.all(mx.isfinite(value)).item() and
                    value.shape == applied[name].shape and mx.array_equal(value, applied[name]).item()
                    for name, value in saved.items()),
                "Saved adapter tensors were not applied exactly or contain invalid values.")
        require(any(mx.any(value != 0).item() for name, value in saved.items() if name.endswith(".lora_b")),
                "Adapter contains no learned LoRA update.")
    model.eval()
    return model, tokenizer, loaded_config


def encode_conversation(tokenizer, config, request):
    require(bool(tokenizer.chat_template), "This tokenizer has no chat template. Restore its original Jinja chat template; no prompt format will be invented.")
    from jinja2 import TemplateError

    try:
        tokens = tokenizer.apply_chat_template(
            request["messages"], tokenize=True, add_generation_prompt=True,
            return_dict=False, truncation=False,
        )
    except (TemplateError, ValueError, TypeError, KeyError):
        raise InferenceError("The model's chat template does not support this conversation. Try without a system message or restore a supported template.") from None
    require(isinstance(tokens, list) and tokens and all(type(token) is int and token >= 0 for token in tokens),
            "Chat template did not produce valid prompt tokens.")
    require(len(tokens) <= 8192, "Prompt exceeds the 8192-token local input budget. Shorten the conversation; nothing was truncated.")
    limits = [config.get(key) for key in CONTEXT_KEYS]
    limits.append(getattr(tokenizer, "model_max_length", None))
    limits = [value for value in limits if type(value) is int and 0 < value < 1_000_000_000]
    if limits:
        limit = min(limits)
        require(len(tokens) + request["maxTokens"] <= limit,
                f"Prompt ({len(tokens)} tokens) plus requested output ({request['maxTokens']}) exceeds the model's {limit}-token context. Shorten the conversation or reduce maxTokens.")
    vocabulary = config.get("vocab_size")
    if type(vocabulary) is int:
        require(all(token < vocabulary for token in tokens), "Tokenizer produced tokens outside the model vocabulary.")
    return tokens


def run(request, stream):
    validate_request(request)
    emit(stream, {"type": "status", "message": "loading"})
    model, tokenizer, config = load_managed_model(request)
    prompt = encode_conversation(tokenizer, config, request)

    import mlx.core as mx
    from mlx_lm import stream_generate
    from mlx_lm.sample_utils import make_sampler

    mx.random.seed(request["seed"])
    emit(stream, {"type": "status", "message": "generating"})
    final = None
    output_bytes = 0
    for result in stream_generate(
        model, tokenizer, prompt, max_tokens=request["maxTokens"],
        sampler=make_sampler(temp=request["temperature"]),
    ):
        require(final is None, "MLX returned output after generation finished.")
        require(result.prompt_tokens == len(prompt), "MLX reported inconsistent prompt token counts.")
        if result.text:
            output_bytes += len(result.text.encode("utf-8"))
            require(output_bytes <= 192 * 1024, "Generation exceeded the local output budget. Request fewer output tokens.")
            for start in range(0, len(result.text), 2048):
                emit(stream, {"type": "token", "text": result.text[start:start + 2048]})
        if result.finish_reason is not None:
            require(result.finish_reason in ("stop", "length"), "MLX returned an unsupported termination reason.")
            final = {
                "type": "complete", "finishReason": result.finish_reason,
                "promptTokens": int(result.prompt_tokens),
                "generatedTokens": int(result.generation_tokens),
            }
    require(final is not None, "MLX generation ended without completion.")
    emit(stream, final)


def main():
    stream = sys.stdout
    finish_monitor = None
    try:
        line = sys.stdin.buffer.readline(192 * 1024 + 1)
        require(line.endswith(b"\n") and len(line) <= 192 * 1024, "Managed inference input is missing or too large.")
        try:
            request = json.loads(line)
        except (ValueError, UnicodeError):
            raise InferenceError("Invalid managed inference JSON.") from None
        finish_monitor = monitor_parent()
        with contextlib.redirect_stdout(sys.stderr):
            run(request, stream)
    except InferenceError as error:
        emit(stream, {"type": "error", "message": str(error)})
        return 1
    except (OSError, ValueError, RuntimeError, TypeError, KeyError, ImportError) as error:
        # Library errors can embed prompts. Surface failure, but not their text.
        emit(stream, {"type": "error", "message": f"Local MLX inference failed ({type(error).__name__}). Check the saved model, adapter, tokenizer and installed MLX runtime."})
        return 1
    finally:
        if finish_monitor:
            finish_monitor()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
