import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { syntheticSuiteTemplate, validateSuiteSummary, suiteAssessment } from "../evaluation-suites.js";
import { reviewFixture, hash } from "./fixtures/evaluation-fixture.js";
import { compareEvaluations } from "../experience.js";
import { validateWorkspace } from "../workspace.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.MAMASE_TRAINING_PYTHON || "python3";

test("Python suite evolution, exact leakage, declared lineage and journal continuity", () => {
  const result = spawnSync(python, ["tests/suite_contract_fixture.py"], {
    cwd: root, input: JSON.stringify(syntheticSuiteTemplate()), encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
});

test("actual Python suite metadata round-trips through browser validation", () => {
  const result = spawnSync(python, ["-c", `
import json, sys
from training.eval_suites import suite_summary
suite = json.load(sys.stdin)
print(json.dumps(suite_summary(suite, "a" * 64)))
`], { cwd: root, input: JSON.stringify(syntheticSuiteTemplate()), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(validateSuiteSummary(summary, 4), { ...summary, historySha256: null });
  assert.equal(suiteAssessment(summary).independence, "known-exposure");
  assert.equal(suiteAssessment({ name: "legacy", version: "1", sha256: hash("legacy") }).independence, "unverified");
});

test("local imported histories retain known exposure across renamed/version-bumped suites", () => {
  const { report } = reviewFixture();
  const renamed = structuredClone(report.suite);
  renamed.name = "New label";
  renamed.version = "3";
  renamed.sha256 = hash("new version");
  Object.assign(renamed.governance, {
    intendedUse: "final", reviewStatus: "reviewed", synthetic: false, knownExposedFamilyIds: [], independence: "mechanically-eligible",
    history: { status: "complete-declared", events: [] }, journalStatus: "complete-declared",
    trainingLineage: { coverage: "complete-declared", sha256: hash("inventory") },
  });
  renamed.historySha256 = hash("history");
  const valid = validateSuiteSummary(renamed, 4);
  assert.equal(suiteAssessment(valid).independence, "mechanically-eligible");
  assert.equal(suiteAssessment(valid, [report.suite]).independence, "known-exposure");
  assert.equal(suiteAssessment(valid, [report.suite]).exposed.length, 4);
  assert.match(suiteAssessment(valid).reason, /not authenticated/);
});

test("malformed or strengthened suite summaries are rejected rather than silently upgraded", () => {
  for (const mutate of [
    (s) => { s.schema = "mamase.eval-suite.v99"; },
    (s) => { s.governance.independence = "mechanically-eligible"; },
    (s) => { s.governance.groupCount = 2; },
    (s) => { s.governance.familyIds.pop(); },
    (s) => { s.governance.rubrics.task = ""; },
    (s) => { s.governance.permission = ""; },
    (s) => { s.governance.trainingLineage.coverage = "complete-declared"; },
    (s) => { s.governance.history.status = "verified"; },
    (s) => { s.governance.journalStatus = "complete-declared"; },
  ]) {
    const { workspace } = reviewFixture();
    mutate(workspace.evaluations[0].comparison.suite);
    assert.throws(() => validateWorkspace(workspace));
  }
});

test("matching paired conditions compare despite descriptive note evolution; mismatches explain why", () => {
  const { workspace } = reviewFixture();
  const first = workspace.evaluations[0];
  const second = structuredClone(first);
  second.id = "separate-evaluation";
  second.notes = "Updated explanatory copy, not scoring conditions.";
  assert.equal(compareEvaluations(first, second).compatible, true);
  for (const [mutate, reason] of [
    [(e) => { e.comparison.suite.version = "changed"; }, /version/],
    [(e) => { e.comparison.suite.name = "changed"; }, /name/],
    [(e) => { e.comparison.suite.sha256 = hash("changed"); }, /fingerprint/],
    [(e) => { e.samples++; }, /Sample counts/],
    [(e) => { e.comparison.decoding.maxNewTokens++; }, /decoding/],
  ]) {
    const other = structuredClone(second);
    mutate(other);
    const result = compareEvaluations(first, other);
    assert.equal(result.compatible, false);
    assert.equal(result.delta, null);
    assert.match(result.reasons.join(" "), reason);
  }
});
