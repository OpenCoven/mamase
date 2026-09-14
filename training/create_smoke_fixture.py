#!/usr/bin/env python3
"""Create a random TINY Llama and toy dataset offline; NOT a production model."""

import argparse
import contextlib
import json
import os
from pathlib import Path
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"


def create_fixture(output):
    import mlx.core as mx
    from mlx.utils import tree_flatten
    from mlx_lm.models.llama import Model, ModelArgs
    from tokenizers import Tokenizer, decoders, models, pre_tokenizers
    from transformers import PreTrainedTokenizerFast

    output = Path(output).absolute()
    if output.is_symlink():
        raise ValueError("Fixture output itself must not be a symlink")
    output = output.resolve()
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Fixture output must be new or empty; refusing to overwrite")
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    model_path = output / "tiny-random-llama-NOT-FOR-PRODUCTION"
    model_path.mkdir()
    special = [
        "<unk>", "<pad>", "<bos>", "<eos>",
        "<|system|>", "<|user|>", "<|assistant|>", "<|tool|>",
    ]
    vocabulary = special + sorted(pre_tokenizers.ByteLevel.alphabet())
    backend = Tokenizer(models.BPE(
        vocab={token: index for index, token in enumerate(vocabulary)},
        merges=[], unk_token="<unk>",
    ))
    backend.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    backend.decoder = decoders.ByteLevel()
    tokenizer = PreTrainedTokenizerFast(
        tokenizer_object=backend, unk_token="<unk>", pad_token="<pad>",
        bos_token="<bos>", eos_token="<eos>", additional_special_tokens=special[4:],
        model_max_length=256,
        chat_template=(
            "{{ bos_token }}"
            "{% for message in messages %}"
            "{{ '<|' + message['role'] + '|>' + message['content'] + eos_token }}"
            "{% endfor %}"
            "{% if add_generation_prompt %}{{ '<|assistant|>' }}{% endif %}"
        ),
    )
    tokenizer.save_pretrained(model_path)
    config = {
        "model_type": "llama", "architectures": ["LlamaForCausalLM"],
        "hidden_size": 32, "num_hidden_layers": 2, "intermediate_size": 64,
        "num_attention_heads": 4, "num_key_value_heads": 2,
        "rms_norm_eps": 1e-5, "vocab_size": len(tokenizer),
        "max_position_embeddings": 256, "tie_word_embeddings": True,
        "bos_token_id": tokenizer.bos_token_id, "eos_token_id": tokenizer.eos_token_id,
        "pad_token_id": tokenizer.pad_token_id,
        "mamase_fixture": "Random tiny test model. NOT a production or pretrained model.",
    }
    mx.random.seed(42)
    model = Model(ModelArgs.from_dict(config))
    weights = dict(tree_flatten(model.parameters()))
    mx.eval(weights)
    mx.save_safetensors(str(model_path / "model.safetensors"), weights)
    with (model_path / "config.json").open("x", encoding="utf-8") as stream:
        json.dump(config, stream, indent=2)
        stream.write("\n")
    dataset_path = output / "original.jsonl"
    with dataset_path.open("x", encoding="utf-8") as stream:
        for word in ("red", "blue", "green", "gold", "pink", "gray", "white", "black", "tan"):
            record = {"messages": [
                {"role": "user", "content": f"Say {word}."},
                {"role": "assistant", "content": word},
            ]}
            stream.write(json.dumps(record) + "\n")
    return {"modelPath": str(model_path), "datasetPath": str(dataset_path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_directory", type=Path)
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        result = create_fixture(args.output_directory)
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
