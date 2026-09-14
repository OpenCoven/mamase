import test from "node:test";
import assert from "node:assert/strict";
import { reviewFixture, at, hash } from "./fixtures/evaluation-fixture.js";
import { prepareReview, recordHumanDecision, readReviewFile } from "../human-review.js";
import { reviewAnnotations, reviewBody } from "../review-view.js";
import { validateWorkspace, saveWorkspace } from "../workspace.js";
import { exportWorkspaceBackup, parseWorkspaceBackup } from "../backups.js";

function decision(review, state = "approved") {
  const fields = Object.fromEntries(review.cases.flatMap((_, index) => ["base", "adapter"].flatMap((model) => [
    [`state-${index}-${model}`, index === 3 ? "blocked" : "unknown"],
    [`judgment-${index}-${model}`, index === 3 ? "truthful-within-scope" : "unclear"],
  ])));
  return { id: "human-opinion", recordedAt: at, reviewer: "Synthetic operator", decision: state,
    rationale: "The blocked response is truthful; format failure remains a failure.",
    limitations: "Text only; no external receipts or verified files. Not an adoption decision.",
    annotations: reviewAnnotations(review, fields) };
}

test("human review binds exact raw report and all case hashes without storing generated text", async () => {
  const { workspace, report, source } = reviewFixture();
  const file = new File([source], "renamed-local-report.json");
  const read = await readReviewFile(file);
  assert.equal(read.reportSha256, hash(source));
  const review = await prepareReview(workspace, "synthetic-evaluation", read.report, read.reportSha256);
  assert.equal(review.cases[0].sha256, hash(JSON.stringify(report.cases[0])));
  const originalCounts = structuredClone(workspace.evaluations[0].comparison);
  const saved = validateWorkspace(recordHumanDecision(workspace, review, decision(review)));
  assert.deepEqual(saved.evaluations[0].comparison, originalCounts);
  assert.equal(workspace.evaluations[0].reviews, undefined);
  const opinion = saved.evaluations[0].reviews[0];
  assert.equal(opinion.authorization, "none");
  assert.equal(opinion.annotations[3].adapter.taskState, "blocked");
  assert.equal(opinion.annotations[3].adapter.responseJudgment, "truthful-within-scope");
  assert.equal(opinion.annotations[3].adapter.executionEvidence, "unknown");
  let stored;
  saveWorkspace({ setItem: (_key, value) => { stored = value; } }, saved);
  const backup = exportWorkspaceBackup(saved, at);
  for (const serialized of [stored, backup, JSON.stringify(saved)]) {
    for (const privateText of ["PRIVATE_CASE_SENTINEL", "PRIVATE_BASE_SENTINEL", "PRIVATE_ADAPTER_SENTINEL", "SYNTHETIC_PASS", '"prompt"', '"response"', '"checks"', '"requestedOutcome"']) {
      assert.ok(!serialized.includes(privateText), privateText);
    }
  }
  assert.deepEqual(parseWorkspaceBackup(backup).workspace, saved);
  assert.deepEqual(parseWorkspaceBackup(JSON.stringify(saved)).workspace, saved);
  const reordered = JSON.parse(JSON.stringify(saved, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => right.localeCompare(left))) : value));
  assert.deepEqual(parseWorkspaceBackup(JSON.stringify(reordered)).workspace, saved);
  assert.deepEqual(await prepareReview(reordered, "synthetic-evaluation", report, hash(source)), review);
  const markup = reviewBody(review, workspace.evaluations[0], []);
  assert.ok(markup.includes("&lt;img") && markup.includes("&lt;script&gt;"));
  assert.ok(!markup.includes("<script>"));
});

test("changed report, suite, decoding, weights and context cannot inherit a decision", async () => {
  const { workspace, report, source } = reviewFixture();
  const review = await prepareReview(workspace, "synthetic-evaluation", report, hash(source));
  const saved = recordHumanDecision(workspace, review, decision(review));
  for (const mutate of [
    (r) => { r.cases[0].adapter.response += " changed"; },
    (r) => { r.suite.version = "renamed"; },
    (r) => { r.familiarContext = { schema: "synthetic-future-context", sha256: hash("context") }; },
    (r) => { r.resultSha256 = hash("new weights"); },
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    await assert.rejects(prepareReview(workspace, "synthetic-evaluation", changed, hash(JSON.stringify(changed))), /exact imported report/);
  }
  await assert.rejects(prepareReview(workspace, "synthetic-evaluation", report, hash(`${source}\n`)), /exact imported report/);
  for (const mutate of [
    (e) => { e.comparison.reportSha256 = hash("different report"); },
    (e) => { e.comparison.suite.sha256 = hash("different suite"); },
    (e) => { e.comparison.decoding.maxNewTokens++; },
    (e) => { e.reviews[0].evidence.resultSha256 = hash("weights"); },
    (e) => { e.reviews[0].authorization = "deploy"; },
    (e) => { e.reviews[0].annotations.pop(); },
    (e) => { e.reviews[0].annotations[0].adapter.executionEvidence = "verified"; },
    (e) => { e.reviews[0].annotations[0].adapter.taskState = "success"; },
    (e) => { e.reviews[0].reviewer = ""; },
    (e) => { e.reviews[0].rationale = "x".repeat(2001); },
    (e) => { e.reviews[0].limitations = ""; },
  ]) {
    const invalid = structuredClone(saved);
    mutate(invalid.evaluations[0]);
    assert.throws(() => validateWorkspace(invalid));
  }
});

test("selected context is visible during review and remains bound through backup recovery", async () => {
  const { workspace, report, source } = reviewFixture({ selectedContext: true });
  const review = await prepareReview(workspace, "synthetic-evaluation", report, hash(source));
  assert.match(reviewBody(review, workspace.evaluations[0], []), /Familiar context: Selected sources/);
  const saved = recordHumanDecision(workspace, review, decision(review));
  assert.deepEqual(saved.evaluations[0].reviews[0].evidence.familiarContext, report.familiarContext);
  assert.deepEqual(parseWorkspaceBackup(exportWorkspaceBackup(saved, at)).workspace, saved);
  const changed = structuredClone(saved);
  changed.artifacts[0].lineage.familiarContext.sha256 = hash("changed-context");
  changed.evaluations[0].comparison.familiarContext.sha256 = hash("changed-context");
  assert.throws(() => validateWorkspace(changed), /Human decision evidence changed/);
  await assert.rejects(prepareReview(changed, "synthetic-evaluation", report, hash(source)), /context/i);
});

test("annotations cannot forge case associations, drop denominators or add execution receipts", async () => {
  const { workspace, report, source } = reviewFixture();
  const review = await prepareReview(workspace, "synthetic-evaluation", report, hash(source));
  for (const mutate of [
    (input) => { input.annotations[0].caseSha256 = hash("unrelated case"); },
    (input) => { input.annotations[0].caseId = "another-case"; },
    (input) => { input.annotations.pop(); },
    (input) => { input.annotations[0].adapter.receiptAdequacy = "sufficient"; },
  ]) {
    const input = decision(review);
    mutate(input);
    assert.throws(() => recordHumanDecision(workspace, review, input));
  }
  for (const state of ["approved", "rejected", "needs-more-evidence"]) {
    assert.equal(recordHumanDecision(workspace, review, decision(review, state)).evaluations[0].reviews[0].decision, state);
  }
  await assert.rejects(readReviewFile(new File([], "empty.json")), /nonempty/);
  await assert.rejects(readReviewFile(new File(["{"], "bad.json")), SyntaxError);
  await assert.rejects(readReviewFile(new File(['{"prompt":PRIVATE_CASE_SENTINEL}'], "private-invalid.json")), (error) => {
    assert.equal(error.message, "Evaluation report is not valid JSON. Select the original local report.");
    return true;
  });
  await assert.rejects(readReviewFile(new File([new Uint8Array([0xff])], "invalid-utf8.json")), TypeError);
  await assert.rejects(readReviewFile(new File([new Uint8Array(20_000_001)], "large.json")), /20 MB/);
});
