import { escapeHtml as esc } from "./workspace.js";
import { field, select, button, table } from "./ui.js";
import { suiteAssessment } from "./evaluation-suites.js";
import { TASK_STATES, RESPONSE_JUDGMENTS } from "./human-review.js";

export function suiteFacts(suite, otherSuites = []) {
  const g = suite.governance;
  const assessment = suiteAssessment(suite, otherSuites);
  return `<section class="suite-governance"><h3>Suite provenance and use</h3><p class="warning">${esc(assessment.reason)}</p>
    <dl class="facts"><dt>Suite / version</dt><dd>${esc(suite.name)} / ${esc(suite.version)}</dd><dt>Exact suite SHA-256</dt><dd><code>${suite.sha256}</code></dd>
    ${g?.classification === "declared-v2" ? `<dt>Owner / reviewer (declared)</dt><dd>${esc(g.owner)} / ${esc(g.reviewer)} (${esc(g.reviewStatus)})</dd><dt>Purpose</dt><dd>${esc(g.purpose)}</dd><dt>Source / permission</dt><dd>${esc(g.provenance)} / ${esc(g.permission)}</dd><dt>Intended use</dt><dd>${esc(g.intendedUse)}${g.synthetic ? " - SYNTHETIC NON-PRODUCTION" : ""}</dd><dt>Cases / declared groups</dt><dd>${g.caseCount} cases / ${g.groupCount} groups (not statistical independence)</dd><dt>History / journal</dt><dd>${esc(g.history.status)} / ${esc(g.journalStatus)}</dd><dt>Training family inventory</dt><dd>${esc(g.trainingLineage.coverage)}${g.trainingLineage.sha256 ? ` / <code>${g.trainingLineage.sha256}</code>` : "; parser does not supply task lineage"}</dd><dt>Exposure journal SHA-256</dt><dd><code>${suite.historySha256 || "Unavailable"}</code></dd><dt>Known exposed families</dt><dd>${assessment.exposed.map(esc).join(", ") || "None declared; not proof of absence"}</dd>` : '<dt>Usage / groups</dt><dd>Legacy/development; task groups and prior use unknown.</dd>'}</dl>
    ${g?.classification === "declared-v2" ? `<details><summary>Written rubrics and usage history (${g.history.events.length} events)</summary>${Object.entries(g.rubrics).map(([category, rubric]) => `<p><strong>${esc(category)}</strong>: ${esc(rubric)}</p>`).join("")}${g.history.events.length ? table(["Use", "Task families", "Suite SHA-256", "Recorded / source"], g.history.events.map((event) => [esc(event.use), event.familyIds.map(esc).join(", "), `<code>${event.suiteSha256}</code>`, `${esc(event.recordedAt)}<br>${esc(event.provenance)}`]), "Declared suite usage history") : "<p>No recorded prior history. An empty list is not proof of independence.</p>"}</details>` : ""}
    <p class="help">Exact prompt overlap is blocked by the local evaluator. Paraphrases are not detected; known family exposure still counts. These declarations are not authenticated permission or independence proof.</p></section>`;
}

export function decisionHistory(evaluation) {
  return `<section><h3>Human review opinions</h3>${evaluation.reviews?.length ? evaluation.reviews.slice().reverse().map((review) => `<details><summary>${esc(review.decision)} - ${esc(review.reviewer)} - ${esc(review.recordedAt)}</summary><p class="prose-notes"><strong>Rationale:</strong> ${esc(review.rationale)}</p><p class="prose-notes"><strong>Limitations:</strong> ${esc(review.limitations)}</p><p>Text-only human opinion; no deployment, promotion, identity or tool authorization. ${review.annotations.length} categorical case annotations; deterministic counts unchanged.</p><code>${review.evidence.reportSha256}</code></details>`).join("") : "<p>No human decision recorded for this exact report.</p>"}</section>`;
}

function annotationControls(index, model) {
  const name = model === "base" ? "Base" : "Adapter";
  return `${select(`${name} task state (human text assessment)`, `state-${index}-${model}`, "unknown", TASK_STATES.map((state) => [state, state]))}
    ${select(`${name} response judgment`, `judgment-${index}-${model}`, "unknown", RESPONSE_JUDGMENTS.map((judgment) => [judgment, judgment]))}`;
}

export function reviewBody(review, evaluation, otherSuites) {
  const c = evaluation.comparison;
  return `<div class="review-evidence">
    <p class="warning">LOCAL TEXT-ONLY INSPECTION. Closing, Escape or navigation clears per-case text and unsaved annotations. Nothing is uploaded. Saved decisions contain bounded metadata only; do not quote private text in rationale or limitations.</p>
    <p><strong>Deterministic rule scores: base ${c.basePassed} / ${c.samples}; adapter ${c.adapterPassed} / ${c.samples}; ${c.regressions} regressions.</strong> Human annotations never change rule outcomes or denominators.</p>
    <dl class="facts"><dt>Report SHA-256</dt><dd><code>${c.reportSha256}</code></dd><dt>Training result SHA-256</dt><dd><code>${c.resultSha256}</code></dd><dt>Bundle / dataset SHA-256</dt><dd><code>${c.bundleSha256}</code><br><code>${c.datasetSha256}</code></dd><dt>Familiar / instance</dt><dd>${esc(c.familiarId)} / ${esc(c.instanceId)}</dd><dt>Adapter reference</dt><dd><code>${esc(c.adapterPath)}</code></dd><dt>Decoding</dt><dd>Greedy; ${c.decoding.maxNewTokens} new tokens; seed ${c.decoding.seed}; ${c.device}</dd></dl>
    ${suiteFacts(c.suite, otherSuites)}
    <p>Evidence kind: generated text and case-sensitive string rules. External execution receipts are unsupported. Execution evidence stays <strong>unknown</strong>; receipt adequacy is not applicable. A tool-boundary label, acknowledgement or exit-zero claim is not proof that a task completed. Truthfully reporting a permission block can be a correct response. Fingerprints bind imported evidence; this browser does not recheck model files on disk or authenticate declarations.</p>
    <label class="check-label"><input type="checkbox" name="regressionsOnly"> Show regressions only (all cases remain in the denominator)</label>
    <p id="review-visible-count" role="status">${c.samples} of ${c.samples} cases shown</p>
    ${review.report.cases.map((row, index) => `<article class="review-case card" data-review-case data-regression="${row.base.passed && !row.adapter.passed}">
      <h3>${esc(row.id)} - ${esc(row.category)}${row.base.passed && !row.adapter.passed ? " - REGRESSION" : ""}</h3>
      <p><strong>Requested outcome:</strong> ${esc(row.requestedOutcome || "Not declared in this legacy report; assess against the prompt without inventing execution evidence.")}</p>
      ${row.familyId ? `<p><strong>Declared family / source:</strong> ${esc(row.familyId)} / ${esc(row.source)}</p>` : ""}
      <p><strong>Prompt</strong></p><pre>${esc(row.prompt)}</pre>
      <details><summary>Frozen deterministic rules</summary><pre>${esc(JSON.stringify(row.checks, null, 2))}</pre></details>
      <div class="review-pair">${["base", "adapter"].map((model) => `<section aria-label="${model === "base" ? "Base" : "Adapter"} response for ${esc(row.id)}">
        <h4>${model === "base" ? "Base" : "Adapter"} - rule ${row[model].passed ? "PASS" : "FAIL"}</h4><pre>${esc(row[model].response) || "(empty generated text)"}</pre>${annotationControls(index, model)}</section>`).join("")}</div>
      <p class="help">Rule outcome is a literal generated-text check, not semantic correctness or verified safe tool use. Task state and response judgment below are human interpretations only.</p></article>`).join("")}
    ${decisionHistory(evaluation)}
    <h3>Record a separate human opinion</h3>
    ${field("Reviewer", "reviewer", "", { attrs: 'maxlength="200" autocomplete="off"' })}
    ${select("Human decision", "decision", "needs-more-evidence", [["needs-more-evidence", "Needs more evidence"], ["approved", "Approved (review opinion only)"], ["rejected", "Rejected"]])}
    ${field("Rationale (metadata only; no private quotations)", "rationale", "", { textarea: true, attrs: 'maxlength="2000" rows="3" autocomplete="off"' })}
    ${field("Limitations (metadata only; no private quotations)", "limitations", "", { textarea: true, attrs: 'maxlength="2000" rows="3" autocomplete="off"' })}
    <label class="check-label"><input type="checkbox" name="confirmTextOnly" required> I understand this is a text-only opinion, not approval to deploy, promote, rewrite identity or grant tools.</label>
    <p class="help">Quota failures keep this review open for retry. Stale workspace snapshots require reloading and selecting the exact report again. No per-case text is recoverable from a backup.</p>
    <div class="actions">${button("Export open workspace", "export-workspace", "download", "small")}${button("Reload workspace", "reload-workspace", "", "small")}</div>
    <div class="modal-footer">${button("Close without saving", "close-dialog", "", "quiet")}<button class="button primary" type="submit">Record review opinion</button></div></div>`;
}

export function reviewAnnotations(review, input) {
  return review.cases.map((row, index) => ({
    caseId: row.id, caseSha256: row.sha256,
    ...Object.fromEntries(["base", "adapter"].map((model) => [model, {
      taskState: input[`state-${index}-${model}`], responseJudgment: input[`judgment-${index}-${model}`],
      executionEvidence: "unknown", receiptAdequacy: "not-applicable",
    }])),
  }));
}
