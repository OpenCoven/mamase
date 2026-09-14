"""Bounded, explicit familiar context validation; never discovers or executes sources."""

import hashlib
import json
from pathlib import Path
import re

ROLES = ("identity", "soul", "role", "skill", "instructions")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fingerprint(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def exact_keys(value, keys, label):
    require(isinstance(value, dict) and set(value) == set(keys), f"Invalid {label} fields.")


def read_bytes(path, limit):
    require(path.is_file(), f"Missing regular context source: {path.name}")
    with path.open("rb") as stream:
        value = stream.read(limit + 1)
    require(len(value) <= limit, f"Context source exceeds {limit} bytes: {path.name}")
    return value


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def compose(binding, sources):
    header = (f'Coven instance: {binding["instanceId"]}\nFamiliar ID: {binding["familiarId"]}\n'
              f'Lane: {binding["lane"]}\nRole: {binding["role"]}\nContext coverage: selected-sources\n\n')
    return header + "\n\n".join(
        f'[{record["role"]}: {source["path"]}]\n{source["content"]}'
        for record, source in zip(binding["sources"], sources)
    )


def metadata(content, label):
    values = re.findall(rf"^[ \t\ufeff]*(?:-[ \t]*)?(?:\*\*)?{label}:(?:\*\*)?[ \t]*([^\r\n]*?)[ \t]*\r?$", content, re.MULTILINE | re.IGNORECASE)
    require(len(values) <= 1, f"Duplicate structured {label} in context source.")
    return values[0].strip() if values else None


def validate_context(directory, bundle, identity):
    snapshot = json.loads(read_bytes(directory / "context.json", 4 * 1024 * 1024))
    exact_keys(snapshot, ("schema", "selection", "binding", "sources"), "context snapshot")
    require(snapshot["schema"] == "mamase.familiar-context.v1", "Unsupported familiar context schema.")
    binding, sources, selection = snapshot["binding"], snapshot["sources"], snapshot["selection"]
    exact_keys(binding, ("schema", "familiarId", "instanceId", "lane", "role", "coverage", "composition", "sources", "promptSha256"), "context binding")
    require(binding["schema"] == "mamase.context-binding.v1" and binding["coverage"] == "selected-sources" and
            binding["composition"] == "ordered-sections-v1", "Unsupported context coverage or composition.")
    for key in ("familiarId", "instanceId"):
        require(binding[key] == identity[key], f"Context {key} contradicts identity.")
    require(isinstance(binding["lane"], str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", binding["lane"]), "Invalid context lane.")
    role = binding["role"]
    require(isinstance(role, str) and role == role.strip() and 0 < len(role.encode("utf-16-le")) // 2 <= 200 and
            not re.search(r"[\x00-\x1f\x7f]", role), "Invalid declared context role.")
    records = binding["sources"]
    require(isinstance(records, list) and 2 <= len(records) <= 16 and isinstance(sources, list) and len(sources) == len(records), "Invalid context source inventory.")
    root = Path(bundle["identity"]["workspace"]).resolve(strict=True)
    paths, total = set(), 0
    for index, (record, source) in enumerate(zip(records, sources)):
        exact_keys(record, ("path", "role", "sha256"), "context source fingerprint")
        exact_keys(source, ("path", "content"), "context source snapshot")
        name = record["path"]
        require(isinstance(name, str) and source["path"] == name and name not in paths, "Duplicate or inconsistent context source.")
        paths.add(name)
        if index < 2:
            require(name == ("IDENTITY.md", "SOUL.md")[index] and record["role"] == ROLES[index], "Required identity source order changed.")
        else:
            require(record["role"] in ROLES[2:] and len(name) <= 200 and
                    re.fullmatch(r"(?:(?:ROLE|SKILL|AGENTS|INSTRUCTIONS)\.md|(?:roles|skills|instructions)/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.md)", name),
                    "Context source must be selected familiar-owned role/skill/instructions Markdown.")
            require(not re.search(r"memory|user|profile|secret|credential|token|session|history|private|harness", name, re.IGNORECASE), "Private context source is excluded.")
        path = root / name
        require(path.resolve(strict=True) == path, "Context source escapes the selected familiar or uses a symlink.")
        raw = read_bytes(path, 128 * 1024)
        total += len(raw)
        require(total <= 512 * 1024, "Combined context exceeds 512 KiB.")
        content = raw.decode("utf-8")
        require(content.strip() and content == source["content"] and hashlib.sha256(raw).hexdigest() == record["sha256"],
                f"Familiar context source changed: {name}. Review and prepare a new experiment.")
        if index < 2:
            require(content == identity["files"][name]["content"] and record["sha256"] == identity["files"][name]["sha256"] and
                    str(path) == identity["files"][name]["path"], "Context and identity snapshots disagree.")
        for label, expected in (("Role", role), ("Lane", binding["lane"]), ("Familiar ID", binding["familiarId"]), ("Instance ID", binding["instanceId"])):
            declared = metadata(content, label)
            require(declared is None or declared == expected, f"Structured {label} contradicts the context binding.")
    exact_keys(selection, ("path", "sha256"), "original context selection")
    require(isinstance(selection["path"], str) and Path(selection["path"]).is_absolute(), "Context selection needs its original local path.")
    original = read_bytes(Path(selection["path"]), 16 * 1024)
    require(hashlib.sha256(original).hexdigest() == selection["sha256"], "Context selection changed; review source ordering and prepare again.")
    manifest = json.loads(original)
    expected_manifest = {key: binding[key] for key in ("familiarId", "instanceId", "lane", "role", "coverage")}
    expected_manifest.update(schema="mamase.context-selection.v1", sources=[{key: record[key] for key in ("path", "role")} for record in records])
    require(manifest == expected_manifest, "Context selection ordering or metadata contradicts the frozen binding.")
    prompt = compose(binding, sources)
    require(hashlib.sha256(prompt.encode("utf-8")).hexdigest() == binding["promptSha256"], "Composed context prompt fingerprint mismatch.")
    summary = {
        "schema": "mamase.familiar-context-summary.v1", "sha256": hashlib.sha256(canonical(binding)).hexdigest(),
        "scope": binding["coverage"], "familiarId": binding["familiarId"], "instanceId": binding["instanceId"],
        "lane": binding["lane"], "role": role, "promptSha256": binding["promptSha256"],
        "sourceRoles": [record["role"] for record in records],
    }
    require(bundle.get("familiarContext") == summary, "Familiar context summary fingerprint or scope mismatch.")
    return prompt
