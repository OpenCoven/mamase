import { assert, text, number, date, id, digest } from "./validation.js";

export const EVAL_CATEGORIES = ["task", "identity", "consent", "tool-boundary"];

function notPromoted(value) {
  assert(value === "not-authorized", "Results cannot authorize model promotion.");
  return value;
}

export function validateTrainingLineage(input, run, dataset) {
  assert(input && run.status === "completed", "Import the completed run report before its training result.");
  const lineage = {
    resultSha256: digest(input.resultSha256, "Training result"),
    bundleSha256: digest(input.bundleSha256, "Bundle"),
    datasetSha256: digest(input.datasetSha256, "Dataset"),
    holdoutSha256: digest(input.holdoutSha256, "Holdout"),
    familiarId: id(input.familiarId), instanceId: id(input.instanceId),
    student: text(input.student, "Base model", 200),
    adapter: text(input.adapter, "Adapter technique", 20),
    baseLoss: number(input.baseLoss, "Base holdout loss", 0, 1_000_000),
    adapterLoss: number(input.adapterLoss, "Adapter holdout loss", 0, 1_000_000),
    samples: number(input.samples, "Holdout samples", 1, 1_000_000, true),
    optimizerSteps: number(input.optimizerSteps, "Optimizer steps", 1, 1_000_000_000, true),
    promotion: notPromoted(input.promotion),
  };
  assert(lineage.datasetSha256 === dataset.sha256, "Training result dataset does not match this run.");
  for (const key of ["familiarId", "instanceId", "student", "adapter"]) {
    assert(lineage[key] === run.recipe[key], `Training result ${key} does not match this run.`);
  }
  assert(lineage.optimizerSteps === run.step, "Training result steps do not match the completed run.");
  assert(lineage.samples === Math.max(1, Math.floor(dataset.records * dataset.holdout / 100)), "Training result holdout count does not match the dataset.");
  return lineage;
}

function fileInventory(files, label) {
  assert(files && typeof files === "object" && !Array.isArray(files), `${label} file fingerprints are required.`);
  const entries = Object.entries(files);
  assert(entries.length > 0 && entries.length <= 10000, `${label} file inventory is invalid.`);
  for (const [name, hash] of entries) {
    text(name, `${label} filename`, 1000);
    digest(hash, `${label} file`);
  }
  assert(entries.some(([name]) => name.endsWith(".safetensors")), `${label} safetensors fingerprints are required.`);
}

export function artifactFromTrainingResult(result, metadata, run, dataset) {
  assert(result?.schema === "mamase.training-result.v1", "Expected a mamase.training-result.v1 result.json.");
  assert(result.runId === run.id, "Training result belongs to another run.");
  assert(result.evaluation?.metric === "completion-token-weighted-negative-log-likelihood", "Unsupported training holdout metric.");
  fileInventory(result.baseModel?.files, "Base model");
  fileInventory(result.adapter?.files, "Adapter");
  digest(result.adapter.files["adapter_config.json"], "Adapter configuration");
  const trainable = number(result.trainableParameters, "Trainable parameters", 1, Number.MAX_SAFE_INTEGER, true);
  assert(trainable < number(result.totalParameters, "Total parameters", 1, Number.MAX_SAFE_INTEGER, true), "Expected a frozen base with trainable adapters.");
  const lineage = validateTrainingLineage({
    resultSha256: metadata.sha256, bundleSha256: result.bundleSha256,
    datasetSha256: result.datasetSha256, holdoutSha256: result.holdoutSha256,
    familiarId: result.familiar?.familiarId, instanceId: result.familiar?.instanceId,
    student: result.baseModel.label, adapter: result.adapter.technique,
    baseLoss: result.evaluation.baseLoss, adapterLoss: result.evaluation.adapterLoss,
    samples: result.evaluation.samples, optimizerSteps: result.optimizerSteps, promotion: result.promotion,
  }, run, dataset);
  const delta = result.evaluation.delta;
  assert(typeof delta === "number" && Number.isFinite(delta) && Math.abs(delta - (lineage.adapterLoss - lineage.baseLoss)) < 1e-10, "Training result loss delta is inconsistent.");
  return {
    id: metadata.id, runId: run.id, name: `${run.name.slice(0, 90)} adapter`, kind: "adapter",
    path: text(result.adapter.path, "Local adapter path", 1000),
    notes: "Imported local training result. Holdout loss is not an independent behavioral benchmark. Promotion is not authorized.",
    createdAt: metadata.createdAt, lineage,
  };
}

function counts(input) {
  assert(input && typeof input === "object", "Evaluation counts are required.");
  const samples = number(input.samples, "Evaluation samples", 1, 200, true);
  const basePassed = number(input.basePassed, "Base passes", 0, samples, true);
  const adapterPassed = number(input.adapterPassed, "Adapter passes", 0, samples, true);
  const regressions = number(input.regressions, "Regressions", Math.max(0, basePassed - adapterPassed), Math.min(basePassed, samples - adapterPassed), true);
  return { samples, basePassed, adapterPassed, regressions };
}

export function validateComparison(input, artifact) {
  const lineage = artifact.lineage;
  assert(input && lineage, "Import this adapter's training result before its paired evaluation.");
  for (const key of ["resultSha256", "bundleSha256", "datasetSha256", "familiarId", "instanceId"]) {
    assert(input[key] === lineage[key], `Evaluation ${key} does not match the imported training result.`);
  }
  assert(input.adapterPath === artifact.path, "Evaluation adapter path does not match the imported artifact.");
  const suite = {
    name: text(input.suite?.name, "Suite name", 100),
    version: text(input.suite?.version, "Suite version", 80),
    sha256: digest(input.suite?.sha256, "Suite"),
  };
  assert(input.decoding?.doSample === false && input.decoding.numBeams === 1 && input.decoding.seed === 42, "Expected paired greedy decoding with seed 42.");
  const decoding = { doSample: false, numBeams: 1, seed: 42, maxNewTokens: number(input.decoding.maxNewTokens, "Maximum new tokens", 1, 512, true) };
  const summary = counts(input);
  assert(Array.isArray(input.categories) && input.categories.length === EVAL_CATEGORIES.length, "All four evaluation categories are required.");
  const categories = EVAL_CATEGORIES.map((category) => {
    const entries = input.categories.filter((entry) => entry?.category === category);
    assert(entries.length === 1, `Expected one ${category} summary.`);
    return { category, ...counts(entries[0]) };
  });
  for (const key of Object.keys(summary)) {
    assert(categories.reduce((sum, category) => sum + category[key], 0) === summary[key], `Evaluation ${key} does not match category totals.`);
  }
  assert(["cpu", "mps", "cuda"].includes(input.device), "Unsupported evaluation device.");
  return {
    reportSha256: digest(input.reportSha256, "Evaluation report"),
    resultSha256: lineage.resultSha256, bundleSha256: lineage.bundleSha256,
    datasetSha256: lineage.datasetSha256, familiarId: lineage.familiarId, instanceId: lineage.instanceId,
    adapterPath: artifact.path, suite, decoding, ...summary, categories, device: input.device,
    promotion: notPromoted(input.promotion),
  };
}

function rulePasses(response, check) {
  assert(check && ["equals", "contains", "not_contains"].includes(check.type), "Unsupported evaluation check.");
  assert(typeof check.value === "string" && check.value.trim().length > 0 && check.value.length <= 2000, "Checks need 1-2000 characters.");
  if (check.type === "equals") return response === check.value;
  if (check.type === "contains") return response.includes(check.value);
  return !response.includes(check.value);
}

export function evaluationFromReport(report, metadata, artifact) {
  assert(report?.schema === "mamase.evaluation-report.v1", "Expected a mamase.evaluation-report.v1 report.");
  assert(report.runId === artifact.runId, "Evaluation belongs to another run.");
  assert(Array.isArray(report.cases) && report.cases.length >= 4 && report.cases.length <= 200, "Expected 4-200 evaluation cases.");
  const seenIds = new Set();
  const seenPrompts = new Set();
  const categories = EVAL_CATEGORIES.map((category) => ({ category, samples: 0, basePassed: 0, adapterPassed: 0, regressions: 0 }));
  for (const row of report.cases) {
    const caseId = id(row?.id);
    const prompt = text(row.prompt, "Evaluation prompt", 16000);
    assert(!seenIds.has(caseId) && !seenPrompts.has(prompt), "Duplicate evaluation case or prompt.");
    seenIds.add(caseId);
    seenPrompts.add(prompt);
    const category = categories.find((item) => item.category === row.category);
    assert(category, "Unsupported evaluation category.");
    assert(Array.isArray(row.checks) && row.checks.length >= 1 && row.checks.length <= 20, "Each case needs 1-20 checks.");
    for (const model of ["base", "adapter"]) {
      assert(typeof row[model]?.response === "string" && row[model].response.length <= 64000, "Invalid model response.");
      // Evaluate every rule, including those after a failure, to validate the whole report.
      const passed = row.checks.map((check) => rulePasses(row[model].response, check)).every(Boolean);
      assert(row[model].passed === passed, `Recorded ${model} pass does not match its response and checks.`);
      category[`${model}Passed`] += Number(passed);
    }
    category.samples++;
    category.regressions += Number(row.base.passed && !row.adapter.passed);
  }
  const summary = counts(report.summary);
  const comparison = validateComparison({
    ...report, ...summary, categories, reportSha256: metadata.sha256,
    familiarId: report.familiar?.familiarId, instanceId: report.familiar?.instanceId,
  }, artifact);
  return {
    id: metadata.id, artifactId: artifact.id,
    benchmark: `${comparison.suite.name} / ${comparison.suite.version}`,
    score: comparison.adapterPassed, maximum: comparison.samples, samples: comparison.samples,
    notes: "Independent paired string-rule checks, not a semantic judge or deployment approval. Full prompts and outputs remain in the local report.",
    createdAt: date(report.createdAt), comparison,
  };
}
