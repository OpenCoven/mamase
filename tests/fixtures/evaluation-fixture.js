import { createHash } from "node:crypto";
import { createWorkspace, createRun, recordProgress, importTrainingResult, importEvaluationReport } from "../../workspace.js";
import { syntheticSuiteTemplate } from "../../evaluation-suites.js";

export const at = "2026-09-14T12:00:00.000Z";
export const hash = (value) => createHash("sha256").update(value).digest("hex");

export function reviewFixture() {
  let workspace = createWorkspace();
  workspace.datasets.push({
    id: "synthetic-data", name: "Synthetic only", filename: "synthetic.jsonl", records: 10, bytes: 1000,
    format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original synthetic fixtures.",
    holdout: 20, sha256: hash("dataset"), createdAt: at,
  });
  let run = createRun({
    id: "synthetic-run", name: "Synthetic review", createdAt: at,
    recipe: { method: "lora", programId: "coven", datasetId: "synthetic-data", student: "fixture-model", teacher: "",
      familiarId: "fixture-bot", instanceId: "synthetic-coven", adapter: "lora", rank: 4, alpha: 8,
      learningRate: 0.001, epochs: 1, batchSize: 1, accumulation: 4, maxSequence: 512,
      outputPath: "/synthetic/bundle/adapter", objective: "Verify software contracts, not model quality." },
  }, workspace);
  for (const [status, step] of [["running", 0], ["completed", 2]]) {
    run = recordProgress(run, { status, step, totalSteps: 2, loss: null, evalLoss: 2, note: "", recordedAt: at });
  }
  workspace.runs.push(run);
  const result = {
    schema: "mamase.training-result.v1", runId: run.id, bundleSha256: hash("bundle"),
    familiar: { familiarId: "fixture-bot", instanceId: "synthetic-coven" },
    baseModel: { label: "fixture-model", files: { "model.safetensors": hash("base") } },
    adapter: { path: "/synthetic/bundle/adapter", technique: "lora", files: { "adapter_model.safetensors": hash("adapter"), "adapter_config.json": hash("config") } },
    datasetSha256: hash("dataset"), holdoutSha256: hash("holdout"), optimizerSteps: 2,
    evaluation: { metric: "completion-token-weighted-negative-log-likelihood", samples: 2, baseLoss: 2, adapterLoss: 2, delta: 0 },
    trainableParameters: 10, totalParameters: 100, promotion: "not-authorized",
  };
  const resultHash = hash(JSON.stringify(result));
  workspace = importTrainingResult(workspace, result, { id: "synthetic-artifact", sha256: resultHash, createdAt: at });
  const suite = syntheticSuiteTemplate();
  const { cases, name, version, schema, history, ...declarations } = suite;
  const familyIds = cases.map((row) => row.familyId).sort();
  const report = {
    schema: "mamase.evaluation-report.v1", runId: run.id, createdAt: at,
    resultSha256: resultHash, bundleSha256: result.bundleSha256, datasetSha256: result.datasetSha256,
    familiar: result.familiar, adapterPath: result.adapter.path,
    suite: {
      name, version, schema, sha256: hash(JSON.stringify(suite)), historySha256: null,
      governance: { ...declarations, classification: "declared-v2", independence: "known-exposure",
        caseCount: 4, groupCount: 4, familyIds, knownExposedFamilyIds: familyIds,
        history, journalStatus: "unavailable", trainingLineage: { coverage: "unavailable", sha256: null },
        limitations: "Synthetic text-only fixtures. No authenticated independence or execution evidence." },
    },
    decoding: { doSample: false, numBeams: 1, maxNewTokens: 16, seed: 42 },
    device: "cpu", promotion: "not-authorized",
    cases: cases.map((row, index) => ({
      ...row, prompt: `${row.prompt} PRIVATE_CASE_SENTINEL_${index} <img src=x onerror="window.reviewInjected=true">`,
      checks: [{ type: "equals", value: "SYNTHETIC_PASS" }],
      base: { response: index < 2 ? "SYNTHETIC_PASS" : "PRIVATE_BASE_SENTINEL", passed: index < 2 },
      adapter: { response: index === 1 || index === 2 ? "SYNTHETIC_PASS" : "PRIVATE_ADAPTER_SENTINEL <script>window.reviewInjected=true</script>", passed: index === 1 || index === 2 },
    })),
    summary: { samples: 4, basePassed: 2, adapterPassed: 2, regressions: 1 },
  };
  const source = JSON.stringify(report);
  workspace = importEvaluationReport(workspace, report, { id: "synthetic-evaluation", sha256: hash(source), createdAt: at });
  return { workspace, report, source, suite, result };
}
