# Mamase UI and UX audit

Subsequent implementation: managed local MLX-LM execution is now available.
See the README for setup and current execution boundaries. This audit records
the UI baseline before that runtime integration; its original external-only
scope is retained below as historical context.

## Executive assessment

The near-black OpenCoven palette, original distillation illustration, restrained
glass surfaces, and explicit local-training boundary already give Mamase a
coherent identity. The larger usability risks were functional: losing work,
weak handoffs between records, incomplete loss visibility, misleading export
scope, and a rigid overview at short viewport heights.

This audit selected and implemented **11 enhancements** rather than replacing
the visual system. The emphasis is continuity, discoverability, accessible
feedback, and trustworthy interpretation of recorded experiments.

## Scope and method

The review covered Overview, Programs, Datasets, Training runs and run details,
Distillation lab, Model library, Evaluations, Training handbook, Workspace
settings, dialogs, recovery flows, and System/Light/Dark appearance.

Evidence came from reading the rendering/event/persistence code, reproducing
interactions in isolated Chromium contexts, exercising empty and populated
workspaces, and inspecting rendered screenshots. No real user workspace data,
dataset contents, or model files were changed during the review.

This is a heuristic and implementation audit, not a user study, formal WCAG
certification, performance benchmark, or security assessment.

## Findings and implemented enhancements

| # | Priority | Observed issue | Implemented enhancement |
|---|---|---|---|
| 1 | High | Opening the mobile drawer reset an unsubmitted workspace name; method changes moved keyboard focus to `BODY`. | Navigation now updates the shell without rebuilding forms. The mobile drawer marks its modal state, makes background content inert, traps keyboard traversal, and restores focus. Method and format changes retain focus. |
| 2 | High | A partially entered recipe disappeared on reload. | Tab-scoped draft recovery, clear save-state text, draft downloads, explicit discard, and confirmation before replacement. Corrupt drafts are preserved rather than overwritten. |
| 3 | Medium | Dataset import and recipe planning were disconnected; another attempt required manually re-entering a closed run's configuration. Some empty-state actions led to prerequisite errors. | Dataset detail pages link related runs and can start a preselected recipe. The lab imports datasets in place. Run duplication copies configuration without history and suggests a distinct output path. Empty-state/header actions lead to the missing prerequisite. |
| 4 | High | Help text lacked programmatic input associations; errors did not receive focus; imports exposed only a disabled button. | Associated help text, visible required/optional state, invalid-field styling, focused error summaries, native teacher/dataset compatibility validation, a live recipe-readiness summary, and meaningful busy labels with `aria-busy`. Modal field IDs are namespaced to avoid collisions with the page underneath. |
| 5 | Medium | Run filters were not reloadable/shareable, there was no sorting or pagination, and CSV exported all runs regardless of filters. | Hash-URL filters, case-insensitive search, deterministic sorting, 20-row pagination, live result counts, clear-filter recovery, explicit unavailable-program state, and CSV export of all matching rows in the selected order. |
| 6 | Medium | Finding a particular model or dataset required navigating and scanning separate views. | Visible desktop/mobile workspace search with Cmd/Ctrl+K. Local results link directly to records or filtered program runs. Native Tab/Enter navigation and Escape dismissal work without custom keyboard-only widgets. Detail pages identify the record in the browser title. |
| 7 | Medium | Artifact notes were recorded but not displayed; evaluation entry defaulted to the most recent artifact; changing source run left the old suggested path. | Artifact detail pages show notes, file reference, source run, base model, dataset fingerprint, and evaluations. Evaluation entry preselects the artifact. Source-run changes update only untouched path suggestions, preserving custom paths. |
| 8 | High | The evaluation table invited comparison but did not enforce comparability. | Explicit baseline/candidate comparison. Different benchmark versions, score scales, sample counts, missing conditions, or differing conditions block the delta. Compatible results show percentage-point change without declaring a winner. |
| 9 | High | The chart ignored validation loss entirely, including runs with validation-only observations. | Both loss series are rendered with distinct color and line style. Missing series are labeled, zero remains a real observation, the latest validation loss is summarized, and an accessible table exposes exact values. |
| 10 | High | At 320x568 the overview headline overlapped its action row even though the document itself reported no vertical overflow. Valid unbroken model/objective text could also widen run details to over 21,000px. | Very short screens reflow into a scrollable overview; long prose wraps safely. Ordinary viewport-bounded layouts remain intact. Short drawers scroll naturally. Wide tables remain keyboard-scrollable, with correctly contained screen-reader-only action headings. |
| 11 | High | Cross-tab conflict feedback disappeared after a temporary toast, leaving stale forms with no persistent recovery path. | A persistent warning preserves form DOM and offers export/reload recovery. Reload requires confirmation; stale saves still fail without overwriting newer data. |

## End-to-end behavior

### Planning without losing work

An unfinished recipe survives a reload in the same tab. Opening navigation or
switching appearance does not destroy form elements. Importing a dataset from
the lab validates it atomically, selects it, and preserves the current recipe.
Selecting teacher-generated data supplies its recorded teacher; a mismatch is
explained before saving.

Saving still creates only a planned run. Duplication never copies status,
progress observations, or artifacts into the new run. Replacing a draft and
discarding a draft are explicit decisions, not side effects of navigation.

### Inspecting a trained result

A dataset leads to its experiments. A run leads to its dataset and artifacts.
An artifact leads back to the run and dataset fingerprint, shows registered
notes, and starts an evaluation for that specific artifact. Its manifest retains
the existing recipe, provenance, and evaluation lineage.

Run filters survive reloads. A filtered export matches what the user selected,
including matching records beyond the visible page. Empty search results offer
recovery instead of suggesting that another experiment must be created.

### Interpreting measurements honestly

Training and validation observations are displayed separately. Missing values
are not converted to zero; chart lines connect only recorded points.

Evaluation comparisons are conservative: identical nonempty recorded
conditions are required in addition to matching benchmark/version, sample count,
and score scale. These checks cannot establish that the exact same sample set,
tool version, or execution protocol was actually used. The user must record and
confirm those details. No automatic quality ranking is inferred.

### Recovering from storage problems

Workspace data stays in `localStorage`; recipe drafts use `sessionStorage`.
Drafts are tab-scoped, not a cloud backup or a substitute for saving a run.
Draft write failures remain visible, and corrupt stored drafts are available
for download or explicit discard.

Cross-tab workspace changes are not silently adopted over open forms.
Conflicting saves remain blocked. The recovery export contains the open
workspace's saved records, not unsubmitted settings/dialog field values.
Reloading warns about those unsaved values before discarding them.

## Visual and accessibility decisions retained

The audit retained the canonical `#050409` canvas, `#0f0d14` base surface,
purple action/focus accents, theme bootstrap, and original local SVG artwork.
Glass remains restrained, with solid-surface fallbacks and reduced-transparency,
increased-contrast, forced-color, and reduced-motion accommodations.

The overview remains viewport-bounded on normal screens. At 620px height or
less, scrolling takes priority over squeezing or concealing controls. A visible
storage warning also permits natural scrolling. Data tables use their own
horizontal scrolling regions instead of widening the document.

Native inputs, buttons, links, dialogs, disclosure elements, and semantic tables
remain the foundation. Search results use ordinary links rather than a fragile
custom combobox. Precise loss data is available without interpreting an SVG.

## Regression coverage

The committed `npm run test:e2e` suite starts a private loopback server and
isolated browser contexts. It covers all 11 enhancement journeys, including:

- Form preservation, method focus, draft reload, failed draft writes, corrupt
  draft recovery, explicit replacement, and successful draft cleanup.
- In-lab invalid/valid imports, unique modal IDs, busy state, preserved recipe
  fields, and creation of a genuinely planned run.
- Pagination, filter URL reload, result counts, filtered CSV, and keyboard search.
- Artifact lineage, preselected evaluations, complete manifests, and
  non-destructive path suggestions.
- Compatible/incompatible evaluation selections, validation-only loss, and
  accessible observation data.
- Persistent cross-tab conflicts, rejection of stale saves, and reload recovery.

The suite exercises 127 responsive layout cases across dark/light appearance
and 1440x900, 1024x768, 390x844, 320x640, 320x568, and 844x390 viewports. It checks
actual element overlap, not only document scroll dimensions, and includes
maximum-length unbroken names, model IDs, objectives, and artifact notes.
Targeted Node tests cover the new query, comparison, draft, semantic-markup, loss-rendering, theme,
and asset-server behavior. Existing full training workflows and appearance
regressions were also exercised.

## Boundaries and follow-up research

All 11 selected implementation enhancements are delivered. No hosted trainer,
inference service, cloud synchronization, account system, simulated progress,
model-file verification, or automatic benchmark execution was added.

Remaining product research should involve actual coven members performing
training tasks, assistive-technology testing with screen-reader users, and
evaluation of substantially larger real-world registries. This review does not
claim measured task-time improvements, universal device coverage, or formal
accessibility conformance.
