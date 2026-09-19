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
| 12 | High | A scripted keyboard-only pass over the six core flows found that every form submission that did not navigate left focus on `<body>`: the toast announced the outcome, so nothing on screen revealed it, but the keyboard returned to the first Tab stop — nineteen of them from the settings form. | `submitForm` records a re-findable selector for the control the keyboard was on and restores it once the page is rebuilt: a dialog returns to the control that opened it, an in-page form to its own submit button, and anything else to `#main`. Pinned in `scripts/verify-ux.mjs` for both shapes. |
| 13 | Medium | Training progress was a polite live region updated once per reported step, throttled to 200ms — up to five queued announcements a second, so a screen reader reads a backlog instead of the run. | Shown and announced are now separate: `#live-progress-text` still changes every step and is no longer a live region, `#live-progress-announcement` announces each tenth of the way and on any status change, and the exact count stays on demand through the progress bar's `aria-valuetext`. Over a 500-step run this is 11 announcements instead of 501, measured in `tests/training-state.test.js`. |
| 14 | High | Applying the rule that decides whether a live region is spoken — it must exist and be exposed before its content changes — showed that every routine toast was a hidden region shown with its text, and switched between polite and assertive as it was filled: "Workspace name saved", "Recipe saved", every import and export outcome, was rendered and never announced. The run-status region lived inside the panel that is rebuilt on every state change and vanished with the progress block, so a run completing, failing or being cancelled was never announced either; and the cancelled status arrived while the confirmation dialog was still open, into an inert page. The playground rebuilt its status line with "Reply complete" in it. The two preview dialogs' summaries were live regions rendered with the dialog, which announces nothing. | Toasts are two always-present regions at a fixed politeness, emptied rather than hidden, with a repeat cleared and re-set so it is heard. The run-status region is part of the run page, outside the rebuilt panel, records what was already true when the page opened as a baseline rather than news, announces every milestone and status change including the terminal ones, and holds an announcement made behind a modal dialog until it closes. The playground says the outcome into the existing region and rebuilds one task later. The preview summaries are the dialogs' accessible descriptions, read on entering. `scripts/ux-announcements.mjs` applies the rule in both gates; `tests/ux-announcements.test.js` proves it. |
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
- Structure and keyboard reachability on every route, including the not-found
  states reached from a stale link: exactly one `h1`, no skipped heading levels,
  an accessible name and a visible focus indicator on every Tab stop, no
  positive `tabindex`, no focusable control inside `[aria-hidden]` or `[inert]`,
  one `main` landmark and a name on every `nav`. None of these change a pixel,
  so no contrast, layout or screenshot assertion notices when one breaks.
- The bypass link is the first Tab stop of a fresh load and moves focus into
  `#main`; closing a dialog by Escape, its close button, or Cancel returns focus
  to the control that opened it.
- A submission that rebuilds the page in place hands focus back rather than
  dropping it on `<body>` — both an in-page form and a dialog that saves without
  navigating. The toast announces the outcome either way, so nothing visible
  revealed that a keyboard user had been returned to the first Tab stop.

The sweep itself lives in `scripts/ux-structure.mjs` and is proved by
`tests/ux-structure.test.js`, which drives it against pages built to contain one
defect each. A green gate is not evidence that a check works — an app-wide
mutation trips an earlier assertion in `scripts/verify-ux.mjs` long before the
sweep runs — so each check is shown to fail on the defect it names, and to stay
quiet on the lookalikes that are not defects: a disabled button, a hidden
heading, `tabindex="0"`, a bypass link that reveals itself by moving, and a page
that never styled focus and so keeps the browser's own ring.

Structure is what the tree contains. Whether a change to it is spoken is a
separate question with one answer: a live region is announced when its content
changes after the region is already exposed, and role="alert" is announced on
appearance. `scripts/ux-announcements.mjs` records every live-region change in
the gate with that verdict and the reason when it would be silent, and the two
gates assert it at the moments the review protocol asks about — a save, a
conflict, readiness while typing, the two previews, a run starting, ending,
cancelled and failed, a playground reply completing. It found that the toast,
the run's terminal status, the playground outcome and the preview summaries were
all rendered and none of them spoken (finding 14). The rule is proved by
`tests/ux-announcements.test.js` against pages built to contain each shape of
change, including the one the tree cannot distinguish: the same id, in the same
place, with the same role, removed and recreated with new text.

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

The structural checks above are automated observation and do not establish that
an announcement is useful. `docs/accessibility-review-protocol.md` is the script
for the human keyboard-only and screen-reader pass that does; issue #44 tracks it.

Remaining product research should involve actual coven members performing
training tasks, assistive-technology testing with screen-reader users, and
evaluation of substantially larger real-world registries. This review does not
claim measured task-time improvements, universal device coverage, or formal
accessibility conformance.
