import { assert, STATUSES } from "./workspace.js";

export const DRAFT_KEY = "mamase.recipe-draft.v1";
export const RUN_PAGE_SIZE = 20;

export function parseRoute(hash) {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [page, id] = path.split("/");
  const params = new URLSearchParams(query);
  const requestedPage = Number(params.get("page") || 1);
  return {
    page: page || "home", id,
    query: params.get("q") || "",
    status: STATUSES.includes(params.get("status")) ? params.get("status") : "all",
    program: params.get("program") || "all",
    sort: ["updated", "created", "name", "progress"].includes(params.get("sort")) ? params.get("sort") : "updated",
    runPage: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
  };
}

export function runUrl(filters) {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.program !== "all") params.set("program", filters.program);
  if (filters.sort !== "updated") params.set("sort", filters.sort);
  if (filters.runPage > 1) params.set("page", filters.runPage);
  return `#/sessions${params.size ? `?${params}` : ""}`;
}

export function selectRuns(runs, filters) {
  const query = filters.query.trim().toLowerCase();
  return runs.filter((run) =>
    (filters.program === "all" || run.recipe.programId === filters.program) &&
    (filters.status === "all" || run.status === filters.status) &&
    `${run.name} ${run.id} ${run.recipe.student}`.toLowerCase().includes(query)
  ).sort((left, right) => {
    let order;
    if (filters.sort === "name") order = left.name.localeCompare(right.name);
    else if (filters.sort === "progress") order = right.step / right.totalSteps - left.step / left.totalSteps;
    else order = Date.parse(right[filters.sort === "created" ? "createdAt" : "updatedAt"]) - Date.parse(left[filters.sort === "created" ? "createdAt" : "updatedAt"]);
    return order || left.id.localeCompare(right.id);
  });
}

export function searchWorkspace(workspace, query) {
  const records = [
    ...workspace.programs.map((item) => ({ label: item.name, kind: "Program", detail: item.description, href: runUrl({ query: "", program: item.id, status: "all", sort: "updated", runPage: 1 }) })),
    ...workspace.datasets.map((item) => ({ label: item.name, kind: "Dataset", detail: `${item.filename} ${item.teacher}`, href: `#/datasets/${item.id}` })),
    ...workspace.runs.map((item) => ({ label: item.name, kind: "Training run", detail: `${item.id} ${item.recipe.student}`, href: `#/sessions/${item.id}` })),
    ...workspace.artifacts.map((item) => ({ label: item.name, kind: "Artifact", detail: item.path, href: `#/checkpoints/${item.id}` })),
  ];
  const term = query.trim().toLowerCase();
  return records.filter((record) => `${record.label} ${record.kind} ${record.detail}`.toLowerCase().includes(term));
}

export function compareEvaluations(first, second) {
  const reasons = [];
  if (!first || !second) return { compatible: false, reasons: ["Choose two recorded evaluations."], delta: null };
  if (first.id === second.id) reasons.push("Choose two different evaluations.");
  if (first.benchmark.trim() !== second.benchmark.trim()) reasons.push("Benchmark and version differ.");
  if (first.maximum !== second.maximum) reasons.push("Score scales differ.");
  if (first.samples !== second.samples) reasons.push("Sample counts differ.");
  if (!first.notes.trim() || !second.notes.trim()) reasons.push("Both evaluations need explicit conditions and sample-set details.");
  else if (first.notes.trim() !== second.notes.trim()) reasons.push("Recorded conditions or sample-set details differ.");
  return { compatible: reasons.length === 0, reasons, delta: reasons.length ? null : (second.score - first.score) / first.maximum * 100 };
}

export function readRecipeDraft(storage, defaults) {
  const source = storage.getItem(DRAFT_KEY);
  if (source === null) return null;
  const value = JSON.parse(source);
  assert(value?.version === 1 && value.draft && !Array.isArray(value.draft), "Unsupported recipe draft.");
  const keys = Object.keys(defaults);
  assert(Object.keys(value.draft).length === keys.length && keys.every((key) =>
    typeof value.draft[key] === "string" && value.draft[key].length <= 2000
  ), "Saved recipe draft has invalid fields.");
  assert(["lora", "distillation"].includes(value.draft.method), "Saved recipe draft has an invalid method.");
  return Object.fromEntries(keys.map((key) => [key, value.draft[key]]));
}
