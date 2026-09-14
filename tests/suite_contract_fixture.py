"""Synthetic suite evolution/exposure contracts, invoked by the existing Node runner."""

import copy
import hashlib
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from training.evaluate import read_json, validate_suite
from training.eval_suites import ExposureJournal, suite_summary, validate_lineage

SUITE = json.load(sys.stdin)
ROWS = {"train": [{"prompt": [{"role": "user", "content": "Training example"}]}], "holdout": []}
RESULT = {"bundleSha256": "a" * 64, "datasetSha256": "b" * 64}
AT = "2026-09-14T12:00:00.000Z"


def final_suite():
    suite = copy.deepcopy(SUITE)
    suite.update(intendedUse="final", reviewStatus="reviewed", synthetic=False)
    suite["history"]["status"] = "complete-declared"
    return suite


def lineage():
    return {
        "schema": "mamase.task-lineage.v1", **RESULT,
        "coverage": "complete-declared", "provenance": "Synthetic declared inventory, not authenticated.",
        "groups": [{"familyId": "fixture-unrelated", "use": "training", "source": "Synthetic training source"}],
    }


def event(family="fixture-alpha", use="tuning"):
    return {"use": use, "familyIds": [family], "suiteSha256": "c" * 64, "recordedAt": AT, "provenance": "Synthetic prior exposure"}


class SuiteContracts(unittest.TestCase):
    def test_versions_and_complete_declarations(self):
        self.assertEqual(validate_suite(copy.deepcopy(SUITE), ROWS), SUITE)
        suite = final_suite()
        journal = {"schema": "mamase.eval-history.v1", "status": "complete-declared", "events": []}
        result = suite_summary(suite, "c" * 64, journal, lineage(), "d" * 64)["governance"]
        self.assertEqual(result["independence"], "mechanically-eligible")
        self.assertIn("not authenticated", result["limitations"])
        for missing_journal, inventory in ((None, lineage()), (journal, None)):
            self.assertEqual(suite_summary(suite, "c" * 64, missing_journal, inventory)["governance"]["independence"], "unverified")
        old = {"schema": "mamase.eval-suite.v1", "name": "Legacy", "version": "1",
               "cases": [{key: row[key] for key in ("id", "category", "prompt", "checks")} for row in suite["cases"]]}
        self.assertEqual(validate_suite(old, ROWS), old)
        old.update(intendedUse="final", owner="Unauthenticated attempted upgrade")
        self.assertEqual(suite_summary(old, "c" * 64)["governance"], {
            "classification": "legacy-development", "independence": "unverified", "caseCount": 4, "groupCount": None,
        })

    def test_paraphrases_known_family_exposure_and_distinct_group_counts(self):
        suite = final_suite()
        suite["cases"][0]["prompt"] = "Was the request received?"
        suite["cases"][1]["familyId"] = suite["cases"][2]["familyId"] = "fixture-beta"
        suite["history"]["events"] = [event()]
        result = suite_summary(suite, "c" * 64)["governance"]
        self.assertEqual(result["caseCount"], 4)
        self.assertEqual(result["groupCount"], 3)
        self.assertEqual(result["independence"], "known-exposure")
        self.assertEqual(result["knownExposedFamilyIds"], ["fixture-alpha"])
        suite["history"]["events"] = []
        inventory = lineage()
        inventory["groups"][0]["familyId"] = "fixture-alpha"
        validate_lineage(inventory, RESULT)
        self.assertEqual(suite_summary(suite, "c" * 64, None, inventory, "d" * 64)["governance"]["independence"], "known-exposure")
        suite["cases"][0]["prompt"] = " Training example "
        with self.assertRaisesRegex(ValueError, "overlaps"):
            validate_suite(suite, ROWS)

    def test_renaming_version_bumps_and_interruption_do_not_erase_journal_exposure(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "exposure.json"
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                with ExposureJournal(path, read_json) as journal:
                    self.assertEqual(journal.value["status"], "unknown")
                    tuned = copy.deepcopy(SUITE)
                    tuned["intendedUse"] = "tuning"
                    journal.record(tuned, "c" * 64, AT)
                    raise RuntimeError("interrupted before report publication")
            self.assertFalse(path.with_name("exposure.json.lock").exists())
            with ExposureJournal(path, read_json) as journal:
                renamed = final_suite()
                renamed.update(name="Entirely different candidate/suite name", version="new-version")
                renamed["history"]["events"] = []
                journal.record(renamed, "e" * 64, AT)
                result = suite_summary(renamed, "e" * 64, journal.value, lineage(), "d" * 64)["governance"]
                self.assertEqual(result["independence"], "known-exposure")
                self.assertEqual(len(result["history"]["events"]), 2)
                self.assertEqual(result["history"]["events"][0]["use"], "tuning")
                with self.assertRaises(FileExistsError):
                    with ExposureJournal(path, read_json):
                        pass
            self.assertEqual(len(read_json(path)[0]["events"]), 2)
            fresh = Path(directory) / "fresh.json"
            with ExposureJournal(fresh, read_json) as journal:
                self.assertEqual(suite_summary(final_suite(), "c" * 64, journal.value, lineage(), "d" * 64)["governance"]["independence"], "unverified")

    def test_inventory_scope_must_match_and_partial_never_claims_full_enforcement(self):
        for key in ("bundleSha256", "datasetSha256"):
            inventory = lineage()
            inventory[key] = "f" * 64
            with self.assertRaisesRegex(ValueError, "differs"):
                validate_lineage(inventory, RESULT)
        inventory = lineage()
        inventory["coverage"] = "partial"
        validate_lineage(inventory, RESULT)
        result = suite_summary(final_suite(), "c" * 64, {"status": "complete-declared", "events": []}, inventory, "d" * 64)
        self.assertEqual(result["governance"]["independence"], "unverified")
        self.assertEqual(result["governance"]["trainingLineage"]["coverage"], "partial")

    def test_schema_evolution_missing_rubrics_invalid_ids_and_history(self):
        mutations = [
            lambda s: s.update(schema="mamase.eval-suite.v3"),
            lambda s: s.update(owner=""),
            lambda s: s.update(reviewer="x" * 201),
            lambda s: s.update(permission=""),
            lambda s: s.update(unversionedNewField=True),
            lambda s: s.update(synthetic="yes"),
            lambda s: s["rubrics"].pop("consent"),
            lambda s: s["cases"][0].update(familyId="../not-opaque"),
            lambda s: s["cases"][0].update(source=""),
            lambda s: s["cases"][0].update(requestedOutcome=""),
            lambda s: s["history"].update(status="independent"),
            lambda s: s["history"].update(events=[{**event(), "recordedAt": "invalid"}]),
            lambda s: s["history"].update(events=[{**event(), "familyIds": ["same", "same"]}]),
        ]
        for mutate in mutations:
            suite = copy.deepcopy(SUITE)
            mutate(suite)
            with self.subTest(suite=suite), self.assertRaises(ValueError):
                validate_suite(suite, ROWS)

    def test_concurrent_changes_and_bad_journals_are_not_overwritten(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "history.json"
            with ExposureJournal(path, read_json) as journal:
                path.write_text("changed externally")
                with self.assertRaisesRegex(ValueError, "changed"):
                    journal.record(SUITE, "c" * 64, AT)
            self.assertEqual(path.read_text(), "changed externally")
            with self.assertRaises(ValueError):
                with ExposureJournal(path, read_json):
                    pass
            self.assertFalse(path.with_name("history.json.lock").exists())
            path.unlink()
            path.symlink_to(Path(directory) / "other")
            with self.assertRaisesRegex(ValueError, "symlinks"):
                with ExposureJournal(path, read_json):
                    pass
            self.assertFalse(path.with_name("history.json.lock").exists())

    def test_journal_byte_budget_preserves_readable_history(self):
        families = [f"group-{index:04}" + "x" * 70 for index in range(200)]
        history = {"schema": "mamase.eval-history.v1", "status": "unknown", "events": []}
        limit = 4 * 1024 * 1024
        def serialized(value):
            return (json.dumps(value, indent=2) + "\n").encode()
        while True:
            record = {**event(), "familyIds": families, "suiteSha256": hashlib.sha256(str(len(history["events"])).encode()).hexdigest()}
            proposed = {**history, "events": [*history["events"], record]}
            if len(serialized(proposed)) > limit:
                break
            history = proposed
        suite = copy.deepcopy(SUITE)
        suite["cases"] = [
            {**copy.deepcopy(SUITE["cases"][index % 4]), "id": f"case-{index}", "prompt": f"Unique synthetic case {index}", "familyId": family}
            for index, family in enumerate(families)
        ]
        validate_suite(suite, ROWS)
        with TemporaryDirectory() as directory:
            path = Path(directory) / "history.json"
            source = serialized(history)
            path.write_bytes(source)
            with ExposureJournal(path, read_json) as journal:
                with self.assertRaisesRegex(ValueError, "4 MiB"):
                    journal.record(suite, "c" * 64, AT)
                self.assertEqual(path.read_bytes(), source)
                self.assertEqual(journal.value, history)
            self.assertEqual(read_json(path)[0], history)

    def test_atomic_journal_failure_keeps_original_and_cleans_staging(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "history.tmp"
            with ExposureJournal(path, read_json) as journal:
                journal.record(SUITE, "a" * 64, AT)
            source = path.read_bytes()
            with self.assertRaisesRegex(OSError, "disk failure"):
                with ExposureJournal(path, read_json) as journal:
                    with patch("training.eval_suites.os.fsync", side_effect=OSError("disk failure")):
                        journal.record(SUITE, "b" * 64, AT)
            self.assertEqual(path.read_bytes(), source)
            self.assertEqual(list(Path(directory).iterdir()), [path])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main()
