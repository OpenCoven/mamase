import { assert, text, date, id, digest } from "./validation.js";
import { evaluationFromReport } from "./results.js";
import { validateFamiliarContext } from "./context-summary.js";
import { validateSuiteSummary } from "./evaluation-suites.js";

export const REVIEW_STATES = ["approved", "rejected", "needs-more-evidence"];
export const TASK_STATES = ["unknown", "completed", "incomplete", "blocked"];
export const RESPONSE_JUDGMENTS = ["unknown", "truthful-within-scope", "incorrect-or-out-of-scope", "unclear"];

export async function sha256(bytes) {
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readReviewFile(file) {
  assert(file instanceof File && file.size > 0, "Choose a nonempty local evaluation report.");
  assert(file.size <= 20_000_000, "Evaluation report exceeds the 20 MB limit.");
  // Hash and parse the same read, not two potentially different file snapshots.
  const bytes = await file.arrayBuffer();
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let report;
  try {
    report = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SyntaxError("Evaluation report is not valid JSON. Select the original local report.");
  }
  return { report, reportSha256: await sha256(bytes) };
}

function sameMetadata(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameMetadata(left[key], right[key]));
}

export async function prepareReview(workspace, evaluationId, report, reportSha256) {
  const evaluation = workspace.evaluations.find((item) => item.id === evaluationId);
  assert(evaluation?.comparison, "Import the matching paired report and training result before reviewing.");
  assert(reportSha256 === evaluation.comparison.reportSha256, "This is not the exact imported report. Changed reports, weights, suites or context need a separate import and review.");
  const artifact = workspace.artifacts.find((item) => item.id === evaluation.artifactId);
  assert(artifact, "The reviewed artifact is missing.");
  const parsed = evaluationFromReport(report, { id: evaluation.id, sha256: reportSha256 }, artifact);
  assert(sameMetadata(parsed.comparison, evaluation.comparison), "The stored evaluation differs from this report. Reload and import matching evidence before review.");
  const cases = [];
  for (const row of report.cases) {
    cases.push({ id: row.id, sha256: await sha256(new TextEncoder().encode(JSON.stringify(row))) });
  }
  return { evaluationId, reportSha256, report, cases };
}

function binding(evaluation) {
  const c = evaluation.comparison;
  assert(c, "Human decisions require a paired report, not a manual score.");
  return {
    evaluationId: evaluation.id, artifactId: evaluation.artifactId,
    reportSha256: c.reportSha256, resultSha256: c.resultSha256,
    bundleSha256: c.bundleSha256, datasetSha256: c.datasetSha256,
    adapterPath: c.adapterPath, familiarId: c.familiarId, instanceId: c.instanceId,
    suite: validateSuiteSummary(c.suite, c.samples),
    decoding: { ...c.decoding }, samples: c.samples, device: c.device,
    ...(c.familiarContext === undefined ? {} : { familiarContext: validateFamiliarContext(c.familiarContext, c) }),
  };
}

function modelAnnotation(input) {
  assert(input && TASK_STATES.includes(input.taskState), "Choose a valid human task-state assessment.");
  assert(RESPONSE_JUDGMENTS.includes(input.responseJudgment), "Choose a valid human response judgment.");
  assert(input.executionEvidence === "unknown" && input.receiptAdequacy === "not-applicable", "External execution receipts are unsupported; execution evidence must remain unknown.");
  return {
    taskState: input.taskState, responseJudgment: input.responseJudgment,
    executionEvidence: "unknown", receiptAdequacy: "not-applicable",
  };
}

export function validateHumanDecision(input, evaluation) {
  assert(input?.schema === "mamase.human-review.v1", "Unsupported human review schema.");
  const expected = binding(evaluation);
  assert(sameMetadata(input.evidence, expected),
  "Human decision evidence changed; decisions cannot transfer to another report, suite, weights or lineage.");
  assert(REVIEW_STATES.includes(input.decision), "Choose approved, rejected, or needs-more-evidence.");
  assert(input.evidenceKind === "human-review-of-generated-text" && input.authorization === "none", "Human review is a text-only opinion, never execution evidence or deployment authorization.");
  assert(Array.isArray(input.annotations) && input.annotations.length === evaluation.samples, "Retain an annotation for every case; do not alter the deterministic denominator.");
  const seen = new Set();
  const annotations = input.annotations.map((annotation) => {
    const caseId = id(annotation?.caseId);
    assert(!seen.has(caseId), "Duplicate case annotation.");
    seen.add(caseId);
    return {
      caseId, caseSha256: digest(annotation.caseSha256, "Review case"),
      base: modelAnnotation(annotation.base), adapter: modelAnnotation(annotation.adapter),
    };
  });
  return {
    schema: "mamase.human-review.v1", id: id(input.id), recordedAt: date(input.recordedAt),
    reviewer: text(input.reviewer, "Human reviewer", 200),
    decision: input.decision, rationale: text(input.rationale, "Review rationale", 2000),
    limitations: text(input.limitations, "Review limitations", 2000),
    evidence: expected, evidenceKind: "human-review-of-generated-text", authorization: "none", annotations,
  };
}

export function recordHumanDecision(workspace, review, input) {
  const evaluation = workspace.evaluations.find((item) => item.id === review.evaluationId);
  assert(evaluation?.comparison?.reportSha256 === review.reportSha256, "The reviewed report changed. Reopen its exact evidence.");
  assert((evaluation.reviews?.length || 0) < 100, "This evaluation has reached its 100-decision history limit.");
  assert(input.annotations?.length === review.cases.length && review.cases.every((item, index) =>
    input.annotations[index]?.caseId === item.id && input.annotations[index]?.caseSha256 === item.sha256),
  "Case annotations do not match the selected report.");
  const decision = validateHumanDecision({
    ...input, schema: "mamase.human-review.v1", evidence: binding(evaluation),
    evidenceKind: "human-review-of-generated-text", authorization: "none",
  }, evaluation);
  return {
    ...workspace,
    evaluations: workspace.evaluations.map((item) => item.id === evaluation.id
      ? { ...item, reviews: [...(item.reviews || []), decision] } : item),
  };
}
