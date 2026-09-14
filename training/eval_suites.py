"""Declared suite provenance and local exposure history; not authenticated independence."""

from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

if __package__:
    from .train import require
else:
    from train import require

CATEGORIES = ("task", "identity", "consent", "tool-boundary")
USES = ("development", "training", "tuning", "final")
HASH = re.compile(r"[a-f0-9]{64}")
IDENTIFIER = re.compile(r"[a-zA-Z0-9_-]{1,80}")


def text(value, label, maximum=1000):
    require(isinstance(value, str) and value.strip() and len(value.encode("utf-16-le")) // 2 <= maximum,
            f"{label} requires 1..{maximum} characters.")
    return value


def identifier(value):
    require(isinstance(value, str) and IDENTIFIER.fullmatch(value), "Invalid opaque task-family identifier.")
    return value


def digest(value):
    require(isinstance(value, str) and HASH.fullmatch(value), "Invalid provenance SHA-256.")
    return value


def timestamp(value):
    text(value, "History timestamp", 80)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("Invalid history timestamp.") from error
    require(parsed.tzinfo is not None, "History timestamp needs a timezone.")


def validate_events(events):
    require(isinstance(events, list) and len(events) <= 2000, "Exposure history requires at most 2000 events.")
    for event in events:
        require(isinstance(event, dict), "Invalid exposure event.")
        require(set(event) == {"use", "familyIds", "suiteSha256", "recordedAt", "provenance"}, "Invalid exposure event fields.")
        require(event.get("use") in USES, "Invalid historical suite use.")
        families = event.get("familyIds")
        require(isinstance(families, list) and 1 <= len(families) <= 200, "Exposure event needs 1..200 task families.")
        require(len(set(identifier(item) for item in families)) == len(families), "Duplicate historical family.")
        digest(event.get("suiteSha256"))
        timestamp(event.get("recordedAt"))
        text(event.get("provenance"), "History provenance")
    return events


def validate_governance(suite):
    if suite["schema"] == "mamase.eval-suite.v1":
        return
    require(set(suite) == {
        "schema", "name", "version", "owner", "reviewer", "provenance", "permission", "purpose",
        "intendedUse", "reviewStatus", "synthetic", "rubrics", "history", "cases",
    }, "Unsupported v2 suite fields; version the schema rather than silently dropping metadata.")
    for key in ("owner", "reviewer"):
        text(suite.get(key), key, 200)
    for key in ("provenance", "permission", "purpose"):
        text(suite.get(key), key)
    require(suite.get("intendedUse") in USES, "Invalid intended suite use.")
    require(suite.get("reviewStatus") in ("draft", "reviewed"), "Invalid suite review status.")
    require(type(suite.get("synthetic")) is bool, "Declare whether this suite is synthetic/non-production.")
    rubrics = suite.get("rubrics")
    require(isinstance(rubrics, dict) and set(rubrics) == set(CATEGORIES), "All four categories need written rubrics.")
    for rubric in rubrics.values():
        text(rubric, "Category rubric", 2000)
    history = suite.get("history")
    require(isinstance(history, dict) and set(history) == {"status", "events"}, "Invalid suite history.")
    require(history.get("status") in ("unknown", "complete-declared"), "Invalid history completeness declaration.")
    validate_events(history.get("events"))
    for case in suite["cases"]:
        require(set(case) == {"id", "category", "prompt", "checks", "familyId", "source", "requestedOutcome"}, "Invalid v2 case fields.")
        identifier(case.get("familyId"))
        text(case.get("source"), "Declared case source")
        text(case.get("requestedOutcome"), "Requested outcome", 2000)


def validate_lineage(value, result):
    require(isinstance(value, dict) and set(value) == {"schema", "bundleSha256", "datasetSha256", "coverage", "provenance", "groups"},
            "Invalid task-lineage inventory fields.")
    require(value.get("schema") == "mamase.task-lineage.v1", "Unsupported task-lineage inventory.")
    for key in ("bundleSha256", "datasetSha256"):
        require(digest(value.get(key)) == result[key], f"Task-lineage {key} differs from the completed training result.")
    require(value.get("coverage") in ("partial", "complete-declared"), "Invalid task-lineage coverage.")
    text(value.get("provenance"), "Task-lineage provenance")
    groups = value.get("groups")
    require(isinstance(groups, list) and 1 <= len(groups) <= 10000, "Task-lineage inventory needs 1..10000 groups.")
    for group in groups:
        require(isinstance(group, dict) and set(group) == {"familyId", "use", "source"}, "Invalid task-lineage group.")
        identifier(group.get("familyId"))
        require(group.get("use") in ("training", "tuning"), "Task-lineage groups must declare training or tuning exposure.")
        text(group.get("source"), "Task-lineage source")
    return value


def merge_events(*histories):
    known, merged = set(), []
    for history in histories:
        for event in history:
            signature = json.dumps(event, sort_keys=True)
            if signature not in known:
                known.add(signature)
                merged.append(event)
    return merged


def suite_summary(suite, suite_hash, journal=None, lineage=None, lineage_hash=None):
    summary = {"name": suite["name"], "version": suite["version"], "sha256": suite_hash, "schema": suite["schema"]}
    if suite["schema"] == "mamase.eval-suite.v1":
        summary["governance"] = {"classification": "legacy-development", "independence": "unverified", "caseCount": len(suite["cases"]), "groupCount": None}
        return summary
    families = sorted({case["familyId"] for case in suite["cases"]})
    events = merge_events(suite["history"]["events"], journal["events"] if journal else [])
    exposed = {
        family for event in events if event["use"] in ("training", "tuning", "development")
        for family in event["familyIds"]
    }
    if lineage:
        exposed.update(group["familyId"] for group in lineage["groups"])
    if suite["intendedUse"] in ("training", "tuning", "development"):
        exposed.update(families)
    overlap = sorted(set(families) & exposed)
    complete = (suite["history"]["status"] == "complete-declared" and journal is not None
                and journal["status"] == "complete-declared" and lineage is not None
                and lineage["coverage"] == "complete-declared")
    independence = "known-exposure" if overlap else "mechanically-eligible" if (
        complete and suite["intendedUse"] == "final" and suite["reviewStatus"] == "reviewed" and not suite["synthetic"]
    ) else "unverified"
    summary["governance"] = {
        **{key: suite[key] for key in ("owner", "reviewer", "provenance", "permission", "purpose", "intendedUse", "reviewStatus", "synthetic", "rubrics")},
        "classification": "declared-v2", "independence": independence,
        "caseCount": len(suite["cases"]), "groupCount": len(families), "familyIds": families,
        "knownExposedFamilyIds": overlap,
        "history": {"status": suite["history"]["status"], "events": events},
        "journalStatus": journal["status"] if journal else "unavailable",
        "trainingLineage": {"coverage": lineage["coverage"] if lineage else "unavailable", "sha256": lineage_hash},
        "limitations": "Operator declarations are not authenticated proof. No semantic duplicate detector or statistical independence claim. Training family enforcement covers only the supplied inventory, not inferred dataset lineage. Missing history remains unverified.",
    }
    require(len(events) <= 2000, "Combined exposure history exceeds 2000 events; retain the original ledger and use a separately reviewed archival inventory.")
    return summary


class ExposureJournal:
    """An explicitly selected local ledger retains exposure across names, versions and candidates."""

    def __init__(self, path, read_json):
        requested = Path(path).absolute() if path else None
        self.path = requested.parent.resolve(strict=True) / requested.name if requested else None
        self.read_json = read_json
        self.value = None
        self.sha256 = None
        self.lock = None

    def __enter__(self):
        if self.path is None:
            return self
        require(self.path.parent.is_dir(), "Exposure-history parent directory must already exist.")
        self.lock = self.path.with_name(self.path.name + ".lock")
        descriptor = os.open(self.lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        try:
            require(not self.path.is_symlink(), "Exposure-history symlinks are unsupported.")
            if self.path.exists():
                self.value, self.sha256 = self.read_json(self.path, 4 * 1024 * 1024)
                require(set(self.value) == {"schema", "status", "events"} and self.value.get("schema") == "mamase.eval-history.v1", "Unsupported exposure history.")
                require(self.value.get("status") in ("unknown", "complete-declared"), "Invalid exposure-history status.")
                validate_events(self.value.get("events"))
            else:
                self.value = {"schema": "mamase.eval-history.v1", "status": "unknown", "events": []}
        except BaseException:
            self.lock.unlink()
            self.lock = None
            raise
        return self

    def record(self, suite, suite_hash, at, lineage=None, lineage_hash=None):
        legacy = suite["schema"] == "mamase.eval-suite.v1"
        if self.path is None or (legacy and not lineage):
            return
        events = merge_events(self.value["events"], [] if legacy else suite["history"]["events"])
        if lineage:
            for use in ("training", "tuning"):
                known = {family for event in events if event["use"] == use for family in event["familyIds"]}
                families = sorted({group["familyId"] for group in lineage["groups"] if group["use"] == use} - known)
                for offset in range(0, len(families), 200):
                    events.append({
                        "use": use, "familyIds": families[offset:offset + 200], "suiteSha256": suite_hash,
                        "recordedAt": at, "provenance": f"Declared task-lineage inventory {lineage_hash}; retained at evaluation attempt, not authenticated proof.",
                    })
        # Legacy suites lack case families, but supplied inventory exposure is still known.
        if not legacy:
            events.append({
                "use": suite["intendedUse"], "familyIds": sorted({case["familyId"] for case in suite["cases"]}),
                "suiteSha256": suite_hash, "recordedAt": at,
                "provenance": "Local evaluator attempt reserved before inference; interruption does not erase exposure.",
            })
        # Persist before inference: a failed/abandoned tuning attempt still exposes the family.
        current_hash = hashlib.sha256(self.path.read_bytes()).hexdigest() if self.path.exists() else None
        require(current_hash == self.sha256, "Exposure history changed while it was locked; refusing to overwrite.")
        require(len(events) <= 2000, "Exposure journal is full; no evaluation was run.")
        updated = {**self.value, "events": events}
        serialized = (json.dumps(updated, indent=2, allow_nan=False) + "\n").encode("utf-8")
        require(len(serialized) <= 4 * 1024 * 1024,
                "Exposure journal exceeds 4 MiB; no evaluation was run and the original history was preserved. Retain it and prepare a separately reviewed archival inventory.")
        descriptor, name = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
        staged = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(serialized)
                stream.flush()
                os.fsync(stream.fileno())
            require((hashlib.sha256(self.path.read_bytes()).hexdigest() if self.path.exists() else None) == self.sha256,
                    "Exposure history changed before publication; the new history was not saved.")
            staged.replace(self.path)
        finally:
            staged.unlink(missing_ok=True)
        self.value = updated
        self.sha256 = hashlib.sha256(self.path.read_bytes()).hexdigest()

    def __exit__(self, *_):
        if self.lock:
            self.lock.unlink()
