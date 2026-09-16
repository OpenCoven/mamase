# Training handbook: a state-aware spine with agent handoff

Date: 2026-09-16
Status: approved design, not yet implemented

## Problem

`#/resources` is six cards of dense prose. Every card mixes instruction with
"this is not that" caveats, so the page reads as an essay and answers no
practical question. It is identical for a fresh workspace and for one with a
trained adapter awaiting review, and it never mentions that the repository
already ships an agent path: `skills/mamase/SKILL.md` plus `npm run ops`.

## Goals

1. The handbook answers "where am I and what is next" from the reader's own
   workspace.
2. Fewer words on screen without deleting a single honest limitation.
3. One action hands the current state to an agent that can act on it.

## Non-goals

- Running commands from the browser. The handbook shows commands; the operator
  or their agent runs them.
- Replacing `npm run ops -- receipt`. The page reuses it, and must never
  disagree with it.
- Changing training, evaluation or review behaviour. This is a presentation
  and handoff change.

## Architecture

Three units. The first already exists.

| Unit | Purpose | Depends on |
|---|---|---|
| `workflow-receipt.mjs` | Computes lane, per-step state, blockers and `next`. Already powers the CLI. Gets added to `public-assets.mjs` so the page imports the same file. | `validation.js`, `training-state.js` (both already browser assets) |
| `handbook.js` (new, pure) | Presentation model: receipt steps + static copy → `{lane, run, steps[], next, blockers}`. No DOM, no fetch. | `workflow-receipt.mjs` |
| `agent-handoff.js` (new, pure) | Builds the handoff prompt string. Pure function, exact output asserted in tests. | none |

`resourcesPage()` in `app.js` renders the model. Two new actions:
`agent-handoff` (export the workspace, then copy the prompt) and `copy-command`
(copy one step's command verbatim, no surrounding prose). Both report success
or failure through the existing `notify` toast.

Reusing `workflow-receipt.mjs` rather than re-deriving step state is the point
of the design: the page and `npm run ops -- receipt` cannot drift, because
there is one implementation.

### Browser receipt semantics

`workflowReceipt(workspace, run, { bundle, capability, job })` already defines
the case the browser is in:

- **PEFT lane** asserts `capability === undefined && job === undefined`. The
  browser passes neither.
- **`bundle === undefined`** is a supported mode, not a degraded one: `prepare`
  is `next`, or `done` with the fingerprint taken from the latest imported
  result's lineage, carrying the module's own note that `--bundle` verifies the
  prepared files. `bundle === null` (a named directory with no readable
  `bundle.json`) is the blocked case and the browser never produces it.
- **Managed MLX lane** asserts `bundle === undefined` and accepts `capability`
  and `job`, both of which the browser already holds via `TrainingClient`.

So the page renders the identical receipt an operator gets from
`npm run ops -- receipt` without `--bundle`. Filesystem-only evidence (bundle
SHA-256 of prepared files, preflight output) is absent by definition of that
mode, and the page says so in the step note rather than implying verification.

### Step model

Step IDs come from the module, not from this document:

- **PEFT**: `plan`, `prepare`, `preflight`, `train`, `evaluate`, `human-review`
- **Managed MLX**: `plan`, `launch`, `job`, `register`, `test`, `human-review`
- **Unselected**: `plan` (done), `select-lane` (blocked)

States are `done`, `next`, `pending`, `blocked`, `not-applicable`. `next` is
`null` whenever blockers exist — the page then shows the blockers and no next
action, matching the receipt contract the skill already relies on.

`handbook.js` adds per-step presentation only: a title, one sentence of
purpose, and the boundaries text, held in one constant map keyed by step ID and
covering every ID above. An unrecognised step ID renders with its raw ID and no
copy rather than being dropped, so a future receipt step cannot silently vanish
from the page. `handbook.js` must not recompute or override a state.

## What the page renders

```
Training handbook                        [ Hand off to an agent ]

Lane: PEFT · run-4f2a "Coven adapter v3"

✓ 01  Plan a recipe      saved 2d ago
▸ 02  Prepare bundle     ← next
      npm run lab -- prepare --recipe recipe.json ...      [copy]
      ▸ What this does not do
○ 03  Preflight          read-only readiness; not an OOM guarantee
○ 04  Train              requires your explicit approval
○ 05  Evaluate
○ 06  Human review       only a human records the decision
```

Blocked runs render the blocker message in place of a next action.

## Caveats are relocated, not deleted

Every "this is not that" claim currently inline moves into a per-step
`<details>` labelled *What this does not do*, wording preserved. Where the
receipt module already carries a `note`, that note is the source and the
static copy must not contradict it. This codebase's voice is deliberately
anti-overclaim; trimming prose must not become trimming honesty.

## Run selection and empty state

The handbook renders one run at a time: the most recently updated, with a
`<select>` in the existing form style listing the others when more than one
exists. Selection is view state only — it is not persisted and writes nothing. With no runs, it renders the first-run path — import a
dataset, then save a recipe — which is the teaching version of the same spine.
That empty state is the handbook for a new workspace, not an error.

## Agent handoff

One button, both effects named on it. It exports the workspace through the
existing `exportWorkspaceBackup`, then copies a prompt naming that exact
filename:

```
Use the mamase skill in this repo (skills/mamase/SKILL.md).

Workspace : ~/Downloads/<exported filename>  (wherever your browser saved it)
Run       : <run id> "<run name>"
Lane      : <lane>

Start here:
  <the sequence that imports a backup into a workspace file, then reads it>

Do exactly the receipt's nextAction, or report its blockers.
Do not run training/train.py without my explicit go-ahead for this run.
```

**Corrected after implementation.** This spec originally wrote those two lines as
`ops -- inspect --workspace <the exported file>` followed by `ops -- receipt
--workspace <the exported file>`. Both fail. `exportWorkspaceBackup` writes
`mamase.workspace-backup.v1` with keys `{schema, exportedAt, workspace}`, while
`ops.mjs`'s `--workspace` loader requires `mamase.workspace-file.v1` and rejects
any key outside `{schema, workspace}`. A backup is `import-backup`'s input, not a
workspace file — so the prompt must `init` a workspace file, `inspect` it for the
revision, `import-backup` the export with `--expected-revision`, and only then
`receipt`. The implementation carries the working sequence; this block states the
shape rather than restating commands that can drift from it again.

**Why no review caught it.** Twelve tests asserted the prompt's text, a spec
review checked it against these requirements, a quality review mutation-tested
it, and a security review threw thirty-six injection payloads at it. None of them
ran the command. Every layer was correct in isolation and the artifact they
jointly produced did not work. The guard that closes this is a test which
extracts the command lines from the generated prompt and executes them against a
real export — asserting behaviour, not wording.

Rules:

- The prompt never carries the local training command token.
  `workflow-receipt.mjs` already states that rule for receipts; the prompt
  inherits it.
- The prompt never embeds workspace contents, dataset text or local paths
  beyond the export filename.
- Clipboard denial falls back to the existing modal with the prompt in a
  selectable textarea. The export still happens, and the modal says so.

## Hosted deployments

Commands cannot run on a hosted deployment. They render marked "run this on
your Mac", reusing the existing hosted messaging, and the handoff stays
available — it is how work reaches the machine that can do it.

## Error handling

- `workflowReceipt` asserts the run's dataset is present in the workspace. A
  run whose dataset was deleted must render as a blocked step with that
  message, never an unhandled throw that blanks the page.
- A workspace that fails to load already sets `storageError`; the handbook
  defers to that existing path.
- Capability lookup failure leaves managed-lane runtime state unknown; the
  page shows the existing capability error rather than inventing a state.

## Testing

- `tests/handbook.test.js` — step derivation across synthetic workspaces: no
  runs, planned run, imported result, managed job active, evaluated, reviewed,
  lane unselected, missing dataset. Asserts at most one `next`, and none when
  blockers exist.
- **Drift test** — for the same workspace, the page model's step IDs and states
  equal `workflowReceipt(...)` with `bundle` omitted. This is the guarantee
  that the page and the CLI cannot diverge.
- Prompt test — exact string; asserts no command token, no dataset text, no
  local path beyond the export filename; escaping of run names.
- Browser test — handbook renders for each lane, handoff both downloads and
  copies, clipboard-denied fallback shows the modal, empty state renders, and
  the hosted variant marks commands.

## Risks

- **Serving `.mjs` to the browser.** Browser modules in this repo are `.js` and
  node modules are `.mjs`; `workflow-receipt.mjs` is already a hybrid (it
  imports two `.js` browser modules). Adding it to `public-assets.mjs` is a
  served-file change only, but the naming convention becomes less clean.
  Renaming it is out of scope and would touch the CLI and the skill.
- **Download path is a guess.** The prompt can name the file but not the
  directory the browser chose, so it says so rather than asserting a path.
