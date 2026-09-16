# Training Handbook Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `#/resources` from six prose cards into a state-aware spine that renders the same receipt `npm run ops -- receipt` produces, and add one action that exports the workspace and copies an agent prompt bound to it.

**Architecture:** `workflow-receipt.mjs` becomes a served browser asset so the page and the CLI share one implementation of step state. `handbook.js` adds presentation only (title, purpose, boundaries) and never recomputes a state. `agent-handoff.js` is a pure string builder. `app.js` renders the model and wires two actions.

**Tech Stack:** Vanilla ES modules, no framework. `node --test` with `--test-concurrency=1`. Playwright for browser tests. Run one test file at a time: `npm test tests/<file>`.

**Spec:** `docs/superpowers/specs/2026-09-16-training-handbook-design.md`

**Branch:** `feature/training-handbook-spine` (already checked out, spec commit `bd4d431` on it)

**Commit rule for every task:** sign commits with `-S`. Verify with `git log -1 --pretty='%h %G?'` — the flag must print `G`.

---

### Task 1: Serve the receipt module to the browser

**Files:**
- Modify: `public-assets.mjs`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/server.test.js`:

```js
test("the receipt module the CLI uses is also served to the browser", async (context) => {
  const server = createAppServer({ auth: createAuthApi({ env: {} }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/workflow-receipt.mjs`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.match(await response.text(), /export function workflowReceipt/);
  // Its imports must already be public, or the browser cannot load it.
  for (const dependency of ["/validation.js", "/training-state.js"]) {
    assert.equal((await fetch(base + dependency)).status, 200, dependency);
  }
});
```

If `createAuthApi` is not already imported in that file, add `import { createAuthApi } from "../auth-api.mjs";` at the top.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/server.test.js`
Expected: FAIL — the `/workflow-receipt.mjs` fetch returns 404.

- [ ] **Step 3: Write minimal implementation**

In `public-assets.mjs`, add one entry after the `training-state.js` line:

```js
  ["/workflow-receipt.mjs", ["workflow-receipt.mjs", "text/javascript"]],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test tests/server.test.js`
Expected: PASS.

Run: `npm test tests/hosted.test.js`
Expected: PASS — the hosted build derives `dist` contents from `publicAssets`, so the new file is copied automatically and the "only public assets" assertion still holds.

- [ ] **Step 5: Commit**

```bash
git add public-assets.mjs tests/server.test.js
git commit -S -m "Serve the workflow receipt module to the browser

The page and npm run ops -- receipt must agree about what step a run is
on. Serving the module is what lets them share one implementation."
git log -1 --pretty='%h %G?'
```

---

### Task 2: The agent prompt builder

**Files:**
- Create: `agent-handoff.js`
- Test: `tests/agent-handoff.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/agent-handoff.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { agentPrompt, handoffFilename } from "../agent-handoff.js";

const run = { id: "run-4f2a", name: "Coven adapter v3" };

test("the prompt names the exported file, the run and the lane", () => {
  const prompt = agentPrompt({ filename: "coven-workspace-2026-09-16.json", run, lane: "peft" });
  assert.match(prompt, /skills\/mamase\/SKILL\.md/);
  assert.match(prompt, /coven-workspace-2026-09-16\.json/);
  assert.match(prompt, /run-4f2a/);
  assert.match(prompt, /Coven adapter v3/);
  assert.match(prompt, /Lane\s*:\s*peft/);
  assert.match(prompt, /npm run ops -- inspect --workspace/);
  assert.match(prompt, /npm run ops -- receipt --workspace .* --run run-4f2a/);
  assert.match(prompt, /nextAction/);
  assert.match(prompt, /explicit go-ahead/i);
});

test("the prompt never carries secrets, workspace contents or invented paths", () => {
  const prompt = agentPrompt({
    filename: "coven-workspace-2026-09-16.json",
    run: { id: "run-1", name: "Adapter" }, lane: "peft",
    // A caller must not be able to leak these into the clipboard.
    capability: { token: "local-training-command-token", enabled: true },
    workspace: { name: "The Coven", datasets: [{ filename: "private-examples.jsonl" }] },
  });
  assert.ok(!prompt.includes("local-training-command-token"));
  assert.ok(!prompt.includes("private-examples.jsonl"));
  assert.ok(!/\/Users\//.test(prompt), "No absolute local path may be asserted");
  assert.match(prompt, /wherever your browser saved it/i);
});

test("run names cannot break the prompt's shape", () => {
  const prompt = agentPrompt({
    filename: "w.json", lane: "peft",
    run: { id: "run-1", name: "Bad\nname\r\nwith\u0007control chars" },
  });
  const runLines = prompt.split("\n").filter((line) => line.startsWith("Run"));
  assert.equal(runLines.length, 1, "A run name must not inject extra lines");
  assert.match(runLines[0], /Bad name with control chars/);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(prompt.replace(/\n/g, "")), "No control characters survive");
});

test("an unselected lane asks for the lane instead of a next action", () => {
  const prompt = agentPrompt({ filename: "w.json", run, lane: "unselected" });
  assert.match(prompt, /lane is not selected/i);
  assert.ok(!prompt.includes("train.py"), "Nothing may suggest training before a lane exists");
});

test("the filename carries the date and stays a safe single segment", () => {
  assert.equal(handoffFilename(new Date("2026-09-16T10:20:30Z")), "coven-workspace-2026-09-16.json");
  assert.ok(!handoffFilename(new Date()).includes("/"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/agent-handoff.test.js`
Expected: FAIL — `Cannot find module '../agent-handoff.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `agent-handoff.js`:

```js
const SAFE = (value, limit = 120) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);

/** A dated, single-segment filename so repeated handoffs stay distinguishable. */
export function handoffFilename(date) {
  return `coven-workspace-${new Date(date).toISOString().slice(0, 10)}.json`;
}

/**
 * The prompt an operator hands to an agent. It names the exported workspace,
 * the run and the lane, and points at the repository's own skill.
 *
 * It carries no workspace contents, no dataset names and no local training
 * command token: workflow-receipt.mjs already forbids copying the token into a
 * receipt, and the same rule applies here. Extra caller arguments are ignored
 * by construction — only the three fields below are read.
 */
export function agentPrompt({ filename, run, lane }) {
  const file = SAFE(filename, 200) || "coven-workspace.json";
  const id = SAFE(run?.id, 80);
  const name = SAFE(run?.name, 120);
  const cleanLane = SAFE(lane, 40);
  const path = `~/Downloads/${file}`;
  const lines = [
    "Use the mamase skill in this repo (skills/mamase/SKILL.md).",
    "",
    `Workspace : ${path}  (wherever your browser saved it)`,
    `Run       : ${id}${name ? ` "${name}"` : ""}`,
    `Lane      : ${cleanLane}`,
    "",
    "Start here:",
    `  npm run ops -- inspect --workspace ${path}`,
    `  npm run ops -- receipt --workspace ${path} --run ${id}`,
    "",
  ];
  // Branch on the sanitised value: a raw lane of "unselected\n" would otherwise
  // display as "unselected" while taking the normal branch and naming train.py.
  if (cleanLane === "unselected") {
    lines.push(
      "This run's lane is not selected, so there is no next action yet.",
      "Report what the receipt says is missing. Do not choose the lane for me.",
    );
  } else {
    lines.push(
      "Do exactly the receipt's nextAction, or report its blockers.",
      "Do not run training/train.py without my explicit go-ahead for this run.",
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/agent-handoff.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add agent-handoff.js tests/agent-handoff.test.js
git commit -S -m "Build the agent handoff prompt

The prompt names the exported workspace, run and lane and points at the
repository's own skill. It carries no workspace contents and no local
training command token, and it never asserts a path it cannot know."
git log -1 --pretty='%h %G?'
```

---

### Task 3: The handbook model

**Files:**
- Create: `handbook.js`
- Test: `tests/handbook.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/handbook.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { handbookModel, STEP_COPY } from "../handbook.js";
import { workflowReceipt } from "../workflow-receipt.mjs";
import { createWorkspace, createRun } from "../workspace.js";

const createdAt = "2026-09-14T00:00:00.000Z";

function workspaceWith(recipeOverrides = {}) {
  const workspace = createWorkspace();
  workspace.datasets.push({
    id: "data", name: "Examples", filename: "data.jsonl", bytes: 100, records: 6,
    format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original",
    holdout: 20, sha256: "a".repeat(64), createdAt,
  });
  workspace.runs.push(createRun({
    id: "run-1", name: "Coven adapter", createdAt,
    recipe: {
      workflow: "cli", method: "lora", programId: workspace.programs[0].id, datasetId: "data",
      student: "./models/local", teacher: "", rank: 4, alpha: 8, learningRate: 0.001,
      epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 128,
      objective: "Learn examples.", outputPath: "./outputs/local",
      familiarId: "fam", instanceId: "inst", ...recipeOverrides,
    },
  }, workspace));
  return workspace;
}

test("an empty workspace teaches the first steps instead of erroring", () => {
  const model = handbookModel(createWorkspace(), {});
  assert.equal(model.empty, true);
  assert.equal(model.run, null);
  assert.ok(model.steps.length, "The empty state is still a path, not a blank page");
  assert.ok(model.steps.every((step) => step.title && step.purpose));
});

test("the model's steps equal the receipt's steps exactly", () => {
  const workspace = workspaceWith();
  const model = handbookModel(workspace, {});
  const receipt = workflowReceipt(workspace, workspace.runs[0]);
  assert.equal(model.lane, receipt.lane);
  assert.deepEqual(
    model.steps.map(({ id, state }) => ({ id, state })),
    receipt.steps.map(({ id, state }) => ({ id, state })),
    "The page must never disagree with npm run ops -- receipt",
  );
  assert.ok(model.next, "This run genuinely has a next step");
  assert.equal(model.next.id, receipt.nextAction.step);
  assert.equal(model.next.state, "next");
  assert.ok(model.next.title, "The next step must go through decorate()");
});

test("every rendered step carries copy, and every receipt step ID is covered", () => {
  const model = handbookModel(workspaceWith(), {});
  for (const step of model.steps) {
    assert.ok(step.title, `${step.id} has no title`);
    assert.ok(step.purpose, `${step.id} has no purpose`);
  }
  for (const id of ["plan", "prepare", "preflight", "train", "evaluate", "human-review", "capability", "launch", "job", "register", "test", "select-lane"]) {
    assert.ok(STEP_COPY[id]?.title, `Missing copy for receipt step ${id}`);
  }
});

test("the managed lane is derived with capability and job, never with a bundle", () => {
  const workspace = workspaceWith({ workflow: "managed", familiarId: "", instanceId: "" });
  const model = handbookModel(workspace, { capability: { enabled: true, available: true, hosted: false } });
  assert.equal(model.lane, "managed-mlx");
  assert.deepEqual(model.steps.map((step) => step.id), ["plan", "capability", "launch", "job", "register", "test", "human-review"]);
});

test("an unselected lane blocks and offers no next action", () => {
  const workspace = workspaceWith({ workflow: undefined, familiarId: "", instanceId: "" });
  const model = handbookModel(workspace, {});
  assert.equal(model.lane, "unselected");
  assert.ok(model.blockers.length);
  assert.equal(model.next, null);
});

test("a run whose dataset was deleted renders a blocker, not a crash", () => {
  const workspace = workspaceWith();
  workspace.datasets = [];
  const model = handbookModel(workspace, {});
  assert.equal(model.next, null);
  assert.equal(model.blockers.length, 1);
  assert.match(model.blockers[0].message, /dataset/i);
});

test("the most recently updated run is adopted and others are offered", () => {
  const workspace = workspaceWith();
  workspace.runs.push({ ...workspace.runs[0], id: "run-2", name: "Newer", updatedAt: "2026-09-15T00:00:00.000Z" });
  workspace.runs[0].updatedAt = "2026-09-13T00:00:00.000Z";
  const model = handbookModel(workspace, {});
  assert.equal(model.run.id, "run-2");
  assert.deepEqual(model.choices.map((choice) => choice.id).sort(), ["run-1", "run-2"]);
  assert.equal(handbookModel(workspace, { runId: "run-1" }).run.id, "run-1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/handbook.test.js`
Expected: FAIL — `Cannot find module '../handbook.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `handbook.js`:

```js
import { workflowReceipt, detectLane } from "./workflow-receipt.mjs";

/**
 * Presentation only. Every state comes from workflow-receipt.mjs; nothing here
 * recomputes or overrides one. `boundaries` is what the step does NOT do — the
 * claims that used to sit inline in the handbook prose.
 */
export const STEP_COPY = {
  plan: {
    title: "Plan a recipe",
    purpose: "Record the dataset, base model and configuration for one attempt.",
    boundaries: "Saving a recipe starts nothing and reserves no hardware.",
  },
  prepare: {
    title: "Prepare the bundle",
    purpose: "Freeze the recipe, dataset split and declared familiar context into a bundle directory.",
    boundaries: "Preparation does not train, download models, or authenticate coven membership. Selected familiar context needs inspect-context review and --context-sha256.",
  },
  preflight: {
    title: "Preflight",
    purpose: "Check readiness without loading weights: sources, model inventory, dependencies, tokenizer and token budget.",
    boundaries: "Read-only. It is not a run report and not an out-of-memory guarantee.",
  },
  train: {
    title: "Train",
    purpose: "Run the identity-bound trainer yourself against the prepared bundle.",
    boundaries: "This is the only step that trains, and it needs your explicit go-ahead for this run. Finishing is not approval to deploy.",
  },
  evaluate: {
    title: "Evaluate",
    purpose: "Compare base and adapter on an independent, versioned suite and import the report.",
    boundaries: "Rule checks are not semantic certification. Independence depends on declared suite lineage and history.",
  },
  "human-review": {
    title: "Human review",
    purpose: "A person reads the private outputs and records a decision.",
    boundaries: "Only a human records a decision. An agent judgment is a recommendation, never a human opinion, and no decision here deploys or promotes anything.",
  },
  launch: {
    title: "Launch on this Mac",
    purpose: "Start a managed MLX job from the saved run, choosing the original dataset file.",
    boundaries: "Launching is a browser action. It is never started by an agent or the CLI.",
  },
  job: {
    title: "Managed job",
    purpose: "Watch reported losses and learning updates until the trainer finishes.",
    boundaries: "Progress is reported learning updates, not time remaining. Cancellation requires explicit approval.",
  },
  register: {
    title: "Register the output",
    purpose: "Bind the finished adapter to this run in the model library.",
    boundaries: "A library entry is not approval to deploy, and an adapter still needs its base model.",
  },
  test: {
    title: "Try it in the playground",
    purpose: "Send the same prompts to the base model and the adapter and read the answers.",
    boundaries: "Replies are experiment evidence, not evaluation scores.",
  },
  "select-lane": {
    title: "Choose a lane",
    purpose: "Bind a familiar and instance for PEFT, or select Train on this Mac for managed MLX.",
    boundaries: "The two lanes produce different evidence and are never merged as one attempt.",
  },
};

const FIRST_RUN = [
  {
    id: "curate", state: "next", title: "Curate the examples",
    purpose: "Import JSONL with messages or prompt/response records, and set a holdout aside before training.",
    boundaries: "Import saves a description and fingerprint, not the examples themselves. Do not train on private material without permission.",
  },
  {
    id: "plan", state: "pending", title: "Plan a recipe",
    purpose: "Choose the dataset, base model and configuration for your first attempt.",
    boundaries: "Saving a recipe starts nothing.",
  },
];

const decorate = (step) => ({ ...step, ...(STEP_COPY[step.id] || { title: step.id, purpose: "", boundaries: "" }) });

/** The run the handbook adopts: an explicit choice, else the most recently updated. */
function subject(workspace, runId) {
  if (!workspace?.runs?.length) return null;
  if (runId) return workspace.runs.find((run) => run.id === runId) || null;
  return [...workspace.runs].sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt))).at(-1);
}

export function handbookModel(workspace, { runId, capability, job } = {}) {
  const run = subject(workspace, runId);
  const choices = (workspace?.runs || []).map(({ id, name }) => ({ id, name }));
  if (!run) return { empty: true, run: null, choices, lane: null, steps: FIRST_RUN, next: FIRST_RUN[0], blockers: [], state: null };
  // `lane` here decides the call shape below (and is reused in the error branch,
  // where no receipt exists to ask). On the success path we return receipt.lane
  // instead, so the module never reports a second, independently computed lane.
  const { lane } = detectLane(run);
  let receipt;
  try {
    receipt = lane === "managed-mlx"
      ? workflowReceipt(workspace, run, { capability, job })
      : workflowReceipt(workspace, run);
  } catch (error) {
    // No receipt produced a state, so report null rather than inventing a
    // plausible one; a consumer reads blockers.length for the blocked case.
    return { empty: false, run, choices, lane, steps: [], next: null, blockers: [{ code: "receipt-unavailable", message: error.message }], state: null };
  }
  const nextStep = receipt.nextAction ? receipt.steps.find((step) => step.id === receipt.nextAction.step) : null;
  return {
    empty: false, run, choices, lane: receipt.lane,
    steps: receipt.steps.map(decorate),
    // The receipt exposes `nextAction` as { step, requiresApproval, command?, note? } —
    // the id is under `.step`, and it is not a step object. Resolve it back to the real step.
    next: nextStep ? decorate(nextStep) : null,
    blockers: receipt.blockers,
    state: receipt.state,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/handbook.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add handbook.js tests/handbook.test.js
git commit -S -m "Derive the handbook from the workflow receipt

The page adds a title, a purpose and the boundaries each step does not
cross. Every state still comes from workflow-receipt.mjs, so the handbook
and npm run ops -- receipt cannot drift; a test asserts they are equal."
git log -1 --pretty='%h %G?'
```

---

### Task 4: Render the spine

**Files:**
- Modify: `app.js` (imports, `ui` object, replace `resourcesPage`)
- Modify: `styles.css`
- Modify: `public-assets.mjs` (serve the two new browser modules)
- Modify: `scripts/verify-ux.mjs` (its assertions target the page being replaced)
- Test: `tests/handbook-ui.test.js`

**Before anything else — the page cannot load without this.** `app.js` now imports
`./handbook.js` and `./agent-handoff.js`, and `public-assets.mjs` is an explicit
allowlist: a module missing from it is a 404 and the page dies on load. Add both:

```js
  ["/handbook.js", ["handbook.js", "text/javascript"]],
  ["/agent-handoff.js", ["agent-handoff.js", "text/javascript"]],
```

**The UX gate asserts against the page you are deleting.** `scripts/verify-ux.mjs`
checks the old prose page by heading text ("Check before loading weights."), a
literal preflight `<pre>`, and a list of caveat substrings. Replacing
`resourcesPage()` breaks all of it. Re-point those assertions at the new spine and
preserve their intent: the boundaries must still be present (now inside the
per-step disclosures), and rendering the handbook must still write nothing to the
workspace.

- [ ] **Step 1: Write the failing test**

Create `tests/handbook-ui.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";
import { createAppServer } from "../server.mjs";
import { createAuthApi } from "../auth-api.mjs";
import { createWorkspace, createRun, STORAGE_KEY } from "../workspace.js";

const createdAt = "2026-09-14T00:00:00.000Z";

export function seeded() {
  const workspace = createWorkspace();
  workspace.datasets.push({
    id: "data", name: "Examples", filename: "data.jsonl", bytes: 100, records: 6,
    format: "prompt-response", kind: "supervised", teacher: "", provenance: "Original",
    holdout: 20, sha256: "a".repeat(64), createdAt,
  });
  workspace.runs.push(createRun({
    id: "run-1", name: "Coven adapter", createdAt,
    recipe: {
      workflow: "cli", method: "lora", programId: workspace.programs[0].id, datasetId: "data",
      student: "./models/local", teacher: "", rank: 4, alpha: 8, learningRate: 0.001,
      epochs: 1, batchSize: 1, accumulation: 1, maxSequence: 128,
      objective: "Learn examples.", outputPath: "./outputs/local",
      familiarId: "fam", instanceId: "inst",
    },
  }, workspace));
  return workspace;
}

async function fixture(context, workspace) {
  const server = createAppServer({ auth: createAuthApi({ env: {} }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(({ value, key }) => localStorage.setItem(key, JSON.stringify(value)), { value: workspace, key: STORAGE_KEY });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, errors, base: `http://127.0.0.1:${server.address().port}` };
}

test("the handbook shows the run's real position and the next command", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  assert.match(await page.locator("#handbook-lane").innerText(), /peft/i);
  const next = page.locator('[data-step-state="next"]').first();
  await next.waitFor();
  assert.match(await next.innerText(), /npm run lab -- prepare/);
  assert.equal(await page.locator('[data-step-state="next"]').count(), 1, "Exactly one next step");
  assert.ok(await page.locator("#handbook-steps details").count(), "Boundaries are disclosed, not inline");
  assert.deepEqual(errors, []);
});

test("an empty workspace renders the first-run path", async (context) => {
  const { page, errors, base } = await fixture(context, createWorkspace());
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  assert.match(await page.locator("#handbook-steps").innerText(), /Curate the examples/);
  assert.equal(await page.locator('[data-action="agent-handoff"]').count(), 0, "No run, nothing to hand off");
  assert.deepEqual(errors, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/handbook-ui.test.js`
Expected: FAIL — `#handbook-steps` never appears.

- [ ] **Step 3: Write minimal implementation**

In `app.js`, add beside the other view imports:

```js
import { handbookModel } from "./handbook.js";
import { agentPrompt, handoffFilename } from "./agent-handoff.js";
```

Add `handbookRun: ""` to the `ui` object literal.

Replace the whole `resourcesPage()` function with:

```js
const STEP_MARK = { done: "✓", next: "▸", blocked: "!", pending: "○", "not-applicable": "–" };

function handbookStep(step, index) {
  return `<li class="handbook-step" data-step-state="${esc(step.state)}" data-step-id="${esc(step.id)}">
    <span class="handbook-mark" aria-hidden="true">${STEP_MARK[step.state] || "○"}</span>
    <div class="handbook-body">
      <h3>${String(index + 1).padStart(2, "0")} · ${esc(step.title)}<span class="handbook-state">${esc(step.state)}</span></h3>
      <p>${esc(step.purpose)}</p>
      ${step.requiresApproval ? `<p class="handbook-approval">${icon("local")} Needs your explicit go-ahead.</p>` : ""}
      ${step.command ? `<div class="handbook-command"><pre>${esc(step.command)}</pre>${button("Copy", "copy-command", "copy", "small quiet", `data-command="${esc(step.command)}" aria-label="Copy the ${esc(step.title)} command"`)}</div>
        ${hosted ? '<p class="help">Run this on your Mac. This hosted site cannot run or monitor training.</p>' : ""}` : ""}
      ${step.note ? `<p class="help">${esc(step.note)}</p>` : ""}
      ${step.boundaries ? `<details class="disclosure"><summary>What this does not do</summary><p>${esc(step.boundaries)}</p></details>` : ""}
    </div></li>`;
}

function handbookState() {
  return handbookModel(workspace, {
    runId: ui.handbookRun,
    ...(training.available ? { capability: training.available } : {}),
  });
}

function resourcesPage() {
  const model = handbookState();
  const picker = model.choices.length > 1 && model.run
    ? `<label class="handbook-picker">Run <select name="handbook-run">${model.choices.map((choice) => `<option value="${esc(choice.id)}" ${choice.id === model.run.id ? "selected" : ""}>${esc(choice.name)}</option>`).join("")}</select></label>`
    : "";
  return `${header("Training handbook", model.run ? button("Hand off to an agent", "agent-handoff", "download", "primary") : "", "Where this run stands, and the next thing to do.")}
    <section class="card handbook-card">
      <div class="handbook-top">
        <p id="handbook-lane" class="eyebrow">${model.empty ? "NEW WORKSPACE" : `LANE: ${esc(model.lane)} · ${esc(model.run.name)}`}</p>
        ${picker}
      </div>
      ${model.blockers.length ? `<div class="notice" role="status"><div><strong>Blocked</strong>${model.blockers.map((item) => `<p>${esc(item.message)}</p>`).join("")}</div></div>` : ""}
      <ol id="handbook-steps" class="handbook-steps">${model.steps.map(handbookStep).join("")}</ol>
      <p class="help handbook-boundary">${model.empty ? "Import a dataset to begin." : "This page reads your saved workspace. It never inspects prepared bundles on disk; pass --bundle to npm run ops -- receipt to verify those files."}</p>
    </section>
    <section class="card"><h2>Work with an agent</h2>
      <p>This repository ships a skill at <code>skills/mamase/SKILL.md</code>. Handing off exports your workspace and copies a prompt naming that file, this run and its lane.</p>
      <p class="help">The prompt carries no dataset contents and no local training command token. An agent may plan, prepare and read evidence; only you approve training, and only a human records a review decision.</p>
    </section>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/handbook-ui.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Add the styles**

Append to `styles.css`:

```css
.handbook-card { padding: 22px; }
.handbook-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.handbook-picker { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--muted); }
.handbook-steps { list-style: none; margin: 18px 0 0; padding: 0; }
.handbook-step { display: flex; gap: 14px; padding: 16px 0; border-top: 1px solid var(--line); }
.handbook-step:first-child { border-top: none; padding-top: 4px; }
.handbook-mark { flex-shrink: 0; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; background: var(--selected); font-size: 12px; }
.handbook-step[data-step-state="pending"] { opacity: .66; }
.handbook-body { min-width: 0; flex: 1; }
.handbook-body h3 { margin: 2px 0 6px; font-size: 14px; display: flex; gap: 10px; align-items: baseline; }
.handbook-state { font: 9px/1.5 var(--font-mono); text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); }
.handbook-body > p { margin: 0 0 8px; color: var(--muted); }
.handbook-command { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0; }
.handbook-command pre { flex: 1; min-width: 0; margin: 0; overflow-x: auto; }
.handbook-approval { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.handbook-boundary { padding-top: 14px; margin-top: 16px; border-top: 1px solid var(--line); }
.handoff-prompt { width: 100%; font: 11px/1.6 var(--font-mono); resize: vertical; }
```

- [ ] **Step 6: Verify layout at every breakpoint**

Run: `npm run test:e2e`
Expected: PASS with no horizontal overflow. The `overflow-x: auto` on `.handbook-command pre` is what keeps a long command from scrolling the page at 320px — do not remove it.

- [ ] **Step 7: Commit**

```bash
git add app.js styles.css tests/handbook-ui.test.js
git commit -S -m "Render the handbook as a state-aware spine

Six prose cards become one path showing where this run stands. Every
caveat moves into a per-step disclosure with its wording intact rather
than being cut."
git log -1 --pretty='%h %G?'
```

---

### Task 5: Wire the handoff and copy actions

**Files:**
- Modify: `app.js` (actions map, click dispatcher, change handler)
- Test: `tests/handbook-ui.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/handbook-ui.test.js`:

```js
test("handing off exports the workspace and copies a prompt naming it", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Hand off to an agent" }).click();
  const download = await waiting;
  assert.match(download.suggestedFilename(), /^coven-workspace-\d{4}-\d{2}-\d{2}\.json$/);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.includes(download.suggestedFilename()), "The prompt must name the file just exported");
  assert.match(copied, /run-1/);
  assert.match(copied, /skills\/mamase\/SKILL\.md/);
  assert.deepEqual(errors, []);
});

test("a denied clipboard still exports and shows the prompt to copy by hand", async (context) => {
  const { page, errors, base } = await fixture(context, seeded());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true,
    });
  });
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Hand off to an agent" }).click();
  await waiting;
  await page.locator("dialog[open]").waitFor();
  assert.match(await page.locator("dialog[open]").innerText(), /skills\/mamase\/SKILL\.md/);
  assert.deepEqual(errors, []);
});

test("switching runs re-derives the spine without writing anything", async (context) => {
  const workspace = seeded();
  workspace.runs.push({ ...workspace.runs[0], id: "run-2", name: "Second attempt", updatedAt: "2026-09-15T00:00:00.000Z" });
  const { page, errors, base } = await fixture(context, workspace);
  const before = JSON.stringify(workspace);
  await page.goto(`${base}/#/resources`);
  await page.locator("#handbook-steps").waitFor();
  assert.match(await page.locator("#handbook-lane").innerText(), /Second attempt/);
  await page.selectOption('select[name="handbook-run"]', "run-1");
  await page.locator('#handbook-lane:has-text("Coven adapter")').waitFor();
  const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  assert.equal(stored, before, "Choosing a run is view state and must not write");
  assert.deepEqual(errors, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/handbook-ui.test.js`
Expected: FAIL — no `agent-handoff` action, so the click reports "This action is unavailable."

- [ ] **Step 3: Write minimal implementation**

In `app.js`, add to the `actions` map:

```js
  "agent-handoff": async () => {
    const model = handbookState();
    assert(model.run, "Save a recipe before handing this workspace to an agent.");
    const filename = handoffFilename(now());
    download(filename, exportWorkspaceBackup(workspace, now()));
    const prompt = agentPrompt({ filename, run: model.run, lane: model.lane });
    try {
      await navigator.clipboard.writeText(prompt);
      notify(`Workspace exported as ${filename}. The agent prompt is on your clipboard.`);
    } catch {
      openModal("Copy the agent prompt", `<p>The workspace was exported as <code>${esc(filename)}</code>, but this browser refused clipboard access. Copy the prompt below.</p><textarea class="handoff-prompt" rows="14" readonly>${esc(prompt)}</textarea>`);
    }
  },
  "copy-command": async (element) => {
    const command = element.dataset.command || "";
    assert(command, "This step has no command to copy.");
    try {
      await navigator.clipboard.writeText(command);
      notify("Command copied.");
    } catch {
      openModal("Copy the command", `<textarea class="handoff-prompt" rows="4" readonly>${esc(command)}</textarea>`);
    }
  },
```

These two actions are `async`, and the click dispatcher currently calls actions synchronously inside a `try`. A rejection after the first `await` would be unhandled, so change the dispatcher body from `action(element);` to:

```js
    const result = action(element);
    if (result && typeof result.then === "function") result.catch((error) => notify(error.message, true));
```

In the `change` handler, add a branch before the final `else return;`:

```js
  else if (event.target.name === "handbook-run") { ui.handbookRun = event.target.value; render(); return; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/handbook-ui.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app.js tests/handbook-ui.test.js
git commit -S -m "Hand the current run to an agent in one action

The button exports the workspace and copies a prompt naming that exact
file, the run and its lane, so the pair cannot disagree. A refused
clipboard still exports and shows the prompt to copy by hand."
git log -1 --pretty='%h %G?'
```

---

### Task 6: Document it and validate the whole suite

**Files:**
- Modify: `README.md`
- Test: full suite

- [ ] **Step 1: Document the handbook and handoff**

In `README.md`, after the section describing the browser workspace, add:

```markdown
### Training handbook

`#/resources` renders the same receipt as `npm run ops -- receipt` without
`--bundle`: the run's lane, each step's state, and the single next action. It
reads the saved workspace only — it never inspects prepared bundles on disk, so
bundle fingerprints and preflight results appear only when you pass `--bundle`
to the CLI receipt.

**Hand off to an agent** exports the workspace and copies a prompt naming that
file, the run and its lane, pointing at the repository's own skill
(`skills/mamase/SKILL.md`). The prompt carries no dataset contents and no local
training command token. An agent may plan, prepare and read evidence; training
still needs your explicit go-ahead, and only a human records a review decision.
```

- [ ] **Step 2: Run the whole Node suite**

Run: `npm test`
Expected: PASS, 0 failures. The count rises from 202 by the tests added here.

- [ ] **Step 3: Run the UX gate**

Run: `npm run test:e2e`
Expected: PASS with no horizontal overflow and no contrast regression.

- [ ] **Step 4: Confirm the page and the CLI still agree**

Run: `npm test tests/handbook.test.js`
Expected: PASS — the drift test is the guarantee that this change did not fork step derivation.

- [ ] **Step 5: Commit, verify signatures, open the pull request**

```bash
git add README.md
git commit -S -m "Document the state-aware handbook and agent handoff"
git log origin/main..HEAD --pretty='%H %G?' | awk '$2 != "G" {print "UNSIGNED:", $0}'
git push -u origin feature/training-handbook-spine
gh pr create --base main --title "Make the training handbook a state-aware spine with agent handoff"
```

Nothing may print from the `awk` line. If something does, sign the missing commits before pushing.

---

## Self-review notes

- **Spec coverage.** Architecture → Tasks 1–3. Browser receipt semantics → Task 3 (`workflowReceipt` called without `bundle`, and with `capability`/`job` only on the managed lane) plus its drift test. Step model → Task 3 `STEP_COPY`, covering all eleven receipt step IDs. Caveats relocated → Task 4 `handbookStep` disclosure. Run selection and empty state → Task 3 `subject`/`FIRST_RUN`, Task 4 picker, Task 5 no-write test. Handoff → Tasks 2 and 5, including the token and contents exclusion tests. Hosted → Task 4. Error handling → Task 3 missing-dataset test. Testing → every task.
- **Type consistency.** `handbookModel(workspace, { runId, capability, job })` returns `{ empty, run, choices, lane, steps, next, blockers, state }`, and Tasks 4 and 5 read exactly those fields. `agentPrompt({ filename, run, lane })` and `handoffFilename(date)` match their call sites. Decorated steps keep the receipt's `id`, `state`, `command`, `note` and `requiresApproval`, and gain `title`, `purpose`, `boundaries`.
- **Known risk carried from the spec.** Serving `.mjs` to the browser blurs the `.js` browser / `.mjs` node convention. Renaming the module would touch the CLI, the skill and its references, so it stays out of scope.

---

## Post-implementation note

Every task in this plan was implemented and passed a two-stage review (spec
compliance, then code quality). The reviews found nine defects that originated
in this document. They are corrected above, but the pattern is worth recording
because it was consistent.

**Seven came from writing the plan off `grep` output instead of reading
`workflow-receipt.mjs` end to end:**

1. The receipt exposes `nextAction`, not `next` — and its shape is
   `{ step, requiresApproval, command?, note? }`, not a step object, so the id
   is under `.step`. The planned `next` field was dead and its assertion
   compared two `undefined`-derived nulls.
2. The managed lane emits a `capability` step: seven steps, not six.
   `STEP_COPY` needs twelve entries, not eleven.
3. `validateRecipe` rejects `workflow: ""`; `undefined` is how a run reaches the
   unselected lane.
4. `handbookModel`'s return contract omitted `state` on two of three branches.
5. `app.js` imports `handbook.js` and `agent-handoff.js`, but neither was added
   to `public-assets.mjs`. That file is an explicit allowlist — without the
   entries the browser 404s on load and the feature is unreachable.
6. `scripts/verify-ux.mjs` asserts against the prose page this work deletes, by
   heading text and caveat substrings.
7. Test fixtures that spread a run with a new `updatedAt` throw, because
   `validateWorkspace` recomputes `updatedAt := createdAt` and asserts equality.

**Two came from the plan's own code:**

8. `agentPrompt` rendered the Lane line from the sanitised value but branched on
   the raw one, so `lane: "unselected\n"` displayed as `unselected` while taking
   the training branch. The later fix to allowlist the two action lanes closed a
   second door: a missing lane also failed open into that branch.
9. The condensation dropped setup information. The page told a user to run
   `.venv/bin/python training/preflight.py` without saying where `.venv` comes
   from, while `app.js:316` still told them setup lived here. The honesty claims
   survived; the usable path did not.

**What the tests did not catch.** Every defect above was found by review, never
by a green suite. Two suites were actively misleading: the prompt builder's
tests failed on copy-edits while surviving the removal of its length clamp, and
the handbook model's step-coverage test read as a receipt check while being a
hardcoded list a new step id would sail past. Mutation testing — change the
implementation, see which tests notice — found more real problems than reading
the code did, and is the technique worth carrying forward.
