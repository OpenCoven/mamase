"""Deterministic, response-only supervised data preparation (no MLX imports)."""

import hashlib
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Example:
    line: int
    record: dict


@dataclass(frozen=True)
class EncodedExample:
    tokens: tuple[int, ...]
    # Mask positions in the unshifted sequence; position zero cannot be a target.
    mask: tuple[bool, ...]
    line: int
    truncated: bool = False

    @property
    def target_count(self):
        return sum(self.mask[1:])


def positive_integer(value, name, minimum=1):
    if type(value) is not int or value < minimum:
        raise ValueError(f"{name} must be an integer >= {minimum}")
    return value


def finite_number(value, name, minimum=0, maximum=None):
    if (
        type(value) not in (int, float)
        or not math.isfinite(value)
        or value < minimum
        or (maximum is not None and value > maximum)
    ):
        raise ValueError(f"{name} must be a finite number in [{minimum}, {maximum}]")
    return value


def split_counts(records, holdout_percentage):
    positive_integer(records, "dataset.records", 2)
    finite_number(holdout_percentage, "dataset.holdout", 0, 100)
    valid = max(1, math.floor(records * holdout_percentage / 100))
    if valid >= records:
        raise ValueError("Holdout must leave at least one training example")
    return records - valid, valid


def deterministic_split(examples, holdout_percentage):
    train_count, valid_count = split_counts(len(examples), holdout_percentage)
    shuffled = list(examples)
    random.Random(42).shuffle(shuffled)
    valid, train = shuffled[:valid_count], shuffled[valid_count:]
    if len(train) != train_count or len(valid) != valid_count:
        raise RuntimeError("Internal split count mismatch")
    return train, valid


def optimizer_steps(train_examples, batch_size, accumulation, epochs):
    for name, value in (
        ("train_examples", train_examples),
        ("batchSize", batch_size),
        ("accumulation", accumulation),
        ("epochs", epochs),
    ):
        positive_integer(value, name)
    batches = (train_examples + batch_size - 1) // batch_size
    return ((batches + accumulation - 1) // accumulation) * epochs


def microbatches(examples, batch_size):
    positive_integer(batch_size, "batchSize")
    for start in range(0, len(examples), batch_size):
        yield examples[start : start + batch_size]


def accumulation_groups(examples, batch_size, accumulation):
    positive_integer(accumulation, "accumulation")
    group = []
    for batch in microbatches(examples, batch_size):
        group.append(batch)
        if len(group) == accumulation:
            yield group
            group = []
    if group:
        yield group


def validate_record(record, data_format, line):
    label = f"Source line {line}"
    if not isinstance(record, dict):
        raise ValueError(f"{label}: expected a JSON object")
    if data_format == "prompt-response":
        for key in ("prompt", "response"):
            if not isinstance(record.get(key), str) or not record[key].strip():
                raise ValueError(f"{label}: {key} must be a nonempty string")
    elif data_format == "messages":
        messages = record.get("messages")
        if not isinstance(messages, list) or len(messages) < 2:
            raise ValueError(f"{label}: messages must contain context and a response")
        for message in messages:
            if (
                not isinstance(message, dict)
                or message.get("role") not in ("system", "user", "assistant", "tool")
                or not isinstance(message.get("content"), str)
                or not message["content"].strip()
            ):
                raise ValueError(f"{label}: only nonempty text chat messages are supported")
        if messages[0]["role"] == "assistant" or messages[-1]["role"] != "assistant":
            raise ValueError(f"{label}: chat must start with context and end with assistant")
        if not any(message["role"] == "user" for message in messages):
            raise ValueError(f"{label}: chat must include a user message")
    else:
        raise ValueError(f"Unsupported dataset format: {data_format!r}")


def read_source(path, metadata):
    expected_hash = metadata.get("sha256")
    if (
        not isinstance(expected_hash, str)
        or len(expected_hash) != 64
        or any(c not in "0123456789abcdef" for c in expected_hash.lower())
    ):
        raise ValueError("dataset.sha256 must be a SHA-256 hex digest")
    expected_count = positive_integer(metadata.get("records"), "dataset.records", 2)
    examples = []
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for line, raw in enumerate(source, 1):
            digest.update(raw)
            if not raw.strip():
                continue
            try:
                record = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError(f"Source line {line}: invalid UTF-8 JSON: {error}") from error
            validate_record(record, metadata.get("format"), line)
            examples.append(Example(line, record))
    if digest.hexdigest() != expected_hash.lower():
        raise ValueError("Source SHA-256 mismatch; the original dataset has changed")
    if len(examples) != expected_count:
        raise ValueError(
            f"Source record count mismatch: expected {expected_count}, read {len(examples)}"
        )
    return examples


def write_splits(directory, train, valid):
    directory.mkdir(mode=0o700)
    for name, examples in (("train.jsonl", train), ("valid.jsonl", valid)):
        path = directory / name
        with path.open("x", encoding="utf-8") as stream:
            for example in examples:
                stream.write(json.dumps(example.record, ensure_ascii=False) + "\n")
        with path.open(encoding="utf-8") as stream:
            if sum(1 for _ in stream) != len(examples):
                raise RuntimeError(f"Written split count mismatch: {name}")


def _chat_spans(tokenizer, messages):
    def render(items, generation=False):
        return tokenizer.apply_chat_template(
            items, tokenize=False, add_generation_prompt=generation
        )

    text = render(messages)
    spans = []
    for index, message in enumerate(messages):
        if message["role"] != "assistant":
            continue
        prompt = render(messages[:index], generation=True)
        completed = render(messages[: index + 1])
        if not completed.startswith(prompt) or not text.startswith(completed):
            raise ValueError(
                "Chat template is not prefix-stable at an assistant response; "
                "cannot safely mask prompts with this template"
            )
        content = message["content"].strip()
        content_start = completed.find(content, len(prompt))
        if content_start < 0:
            raise ValueError(
                "Chat template rewrites assistant content; cannot locate response tokens"
            )
        spans.append(
            (len(prompt), len(completed), content_start, content_start + len(content))
        )
    return text, spans


def _tokenize_spans(tokenizer, text, spans):
    if tokenizer.is_fast:
        encoded = tokenizer(
            text, add_special_tokens=False, return_offsets_mapping=True
        )
        tokens = list(encoded["input_ids"])
        offsets = encoded["offset_mapping"]
        masks = [
            [
                end > start and start >= low and end <= high
                for start, end in offsets
            ]
            for low, high, _, _ in spans
        ]
        content_masks = [
            [
                end > start
                and start >= low
                and end <= high
                and end > content_low
                and start < content_high
                for start, end in offsets
            ]
            for low, high, content_low, content_high in spans
        ]
        return tokens, masks, content_masks

    # Slow tokenizers cannot expose character offsets. Require exact token prefixes
    # rather than guessing at boundaries affected by BPE/SentencePiece merging.
    tokens = list(tokenizer.encode(text, add_special_tokens=False))

    def boundary(position):
        prefix = list(tokenizer.encode(text[:position], add_special_tokens=False))
        if tokens[: len(prefix)] != prefix:
            raise ValueError(
                "Slow tokenizer has a non-prefix token boundary; use a compatible fast tokenizer"
            )
        return len(prefix)

    masks, content_masks = [], []
    for low, high, content_low, content_high in spans:
        low, high, content_low, content_high = map(
            boundary, (low, high, content_low, content_high)
        )
        masks.append([low <= i < high for i in range(len(tokens))])
        content_masks.append(
            [low <= i < high and content_low <= i < content_high for i in range(len(tokens))]
        )
    return tokens, masks, content_masks


def encode_example(example, data_format, tokenizer, max_sequence):
    positive_integer(max_sequence, "maxSequence", 2)
    record = example.record
    has_template = bool(
        getattr(tokenizer, "has_chat_template", False)
        or getattr(tokenizer, "chat_template", None)
    )
    if data_format == "messages" and not has_template:
        raise ValueError(f"Source line {example.line}: messages require a real chat template")
    if has_template:
        messages = (
            record["messages"]
            if data_format == "messages"
            else [
                {"role": "user", "content": record["prompt"]},
                {"role": "assistant", "content": record["response"]},
            ]
        )
        text, spans = _chat_spans(tokenizer, messages)
    else:
        prompt = record["prompt"] + "\n"
        text = prompt + record["response"]
        spans = [(len(prompt), len(text), len(prompt), len(text))]

    tokens, masks, content_masks = _tokenize_spans(tokenizer, text, spans)
    if not has_template:
        # Plain format: optional BOS + prompt + newline + response + required EOS.
        if tokenizer.eos_token_id is None:
            raise ValueError("Plain prompt-response format requires an EOS token")
        if tokenizer.bos_token_id is not None:
            tokens.insert(0, tokenizer.bos_token_id)
            for mask in masks + content_masks:
                mask.insert(0, False)
        tokens.append(tokenizer.eos_token_id)
        masks[0].append(True)
        content_masks[0].append(False)

    if not content_masks or any(
        not any(mask[1:max_sequence]) for mask in content_masks
    ):
        raise ValueError(
            f"Source line {example.line}: an assistant response has no content targets "
            f"within maxSequence={max_sequence}; increase the limit or shorten the prompt"
        )
    mask = [any(values) for values in zip(*masks)]
    mask[0] = False
    truncated = len(tokens) > max_sequence
    return EncodedExample(
        tuple(tokens[:max_sequence]),
        tuple(mask[:max_sequence]),
        example.line,
        truncated,
    )


def collate(examples, pad_token_id):
    if not examples:
        raise ValueError("Cannot collate an empty batch")
    width = max(len(example.tokens) for example in examples)
    if width < 2 or any(example.target_count == 0 for example in examples):
        raise ValueError("Every example must contain a supervised causal target")
    tokens, masks = [], []
    for example in examples:
        padding = width - len(example.tokens)
        tokens.append(list(example.tokens) + [pad_token_id] * padding)
        masks.append(list(example.mask) + [False] * padding)
    return tokens, masks
