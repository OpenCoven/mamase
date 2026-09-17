# Keyboard-only and screen-reader review protocol

Date: 2026-09-16
Tracks: [#44](https://github.com/OpenCoven/mamase/issues/44)

This is the script for the half of #44 that a machine cannot run. `npm run
test:e2e` observes structure: it can prove a button has an accessible name and
that a heading level does not skip. It cannot judge whether what a screen reader
says at that moment tells you what happened. That judgement is the whole point
of this pass, and it is why the `limitations` string in `scripts/validate.mjs`
says human review was not executed — a sentence that stays true for every run of
the gate, including after you finish this document.

## Before you start

```sh
npm ci
npm start           # http://127.0.0.1:4173
```

Seed a workspace with real shape rather than an empty one, or most flows below
have nothing to exercise: import a dataset, save a recipe, and record progress
against it. `npm run ops -- receipt` tells you which step the workspace is on if
you lose track.

Two passes, in this order, because they fail differently:

1. **Keyboard only.** Unplug or ignore the mouse. Trackpad included. If you
   reach for the pointer, that is the finding — record it and continue.
2. **Screen reader.** VoiceOver is sufficient: `Cmd+F5` to toggle, `Ctrl+Opt`
   is the VO modifier, `Ctrl+Opt+U` opens the rotor (headings, landmarks, form
   controls), `Ctrl+Opt+A` reads continuously from the cursor.

Record every finding in the table at the bottom as you go. Do not batch them
up at the end; the specific keystroke is the part you forget first.

## What the automated gate already covers

Do not re-verify these by hand. `scripts/verify-ux.mjs` asserts them on every
route, and a human repeating them finds nothing:

- Exactly one `h1` per page, and no skipped heading levels.
- Every visible Tab stop has an accessible name and a visible focus indicator.
- No positive `tabindex`, and no focusable control inside `[aria-hidden]` or
  `[inert]`.
- Exactly one `main` landmark; every `nav` landmark is named.
- The first Tab of a fresh load reaches "Skip to content", and activating it
  moves focus into `#main`.
- Closing a dialog by Escape, the close button, or Cancel returns focus to the
  control that opened it.
- Contrast in light, dark and system appearance; status conveyed by more than
  colour; no horizontal overflow at 320px, 760px, desktop or short landscape.

Your job is the part underneath all of that: **is the announcement true, timely
and sufficient to act on?**

## Flows

Each flow lists what to do and the question only a person can answer. Work
through them in order; later flows depend on state the earlier ones create.

### 1. Workspace creation and recovery

Settings → **Workspace identity** → change the name → **Save name**. Then
**Export workspace**, **Reset local workspace**, and **Restore backup** from the
exported file.

- Does the screen reader say the name was **saved**, or only re-read the field?
  Until this was checked by rule it did neither: the toast was a hidden region
  shown with its text, which is never announced. It is now two regions that are
  always present, `#toast-status` (polite) and `#toast-alert` (assertive). The
  gate asserts the save would be spoken; you can confirm that it is.
- On restore, is the preview (source format, collection counts) announced
  *before* the confirm button, or does the reader meet the confirm first?
- Reset is destructive. Is that conveyed before activation, not after?

### 2. Identity-bound preparation

Playground → fill the recipe: **Familiar ID**, **Coven instance ID**, dataset,
base model, hyperparameters → **Save recipe & review**. Submit once with a
required field deliberately left blank.

- When validation rejects the form, does focus move to the offending field, and
  is the error read with it — or is the error announced with focus still on the
  submit button, leaving you to hunt for which field failed?
- `#recipe-readiness` announces plan readiness as you type. Is it useful, or
  does it interrupt you mid-field?

### 3. Training launch and interruption

Open the saved run → **Start training**, then interrupt it: cancel it from the
page, or stop the local trainer process. Managed MLX only; a terminal-trained
run reports through import instead, which flow 4 covers.

Progress is deliberately split here, and this flow is where that split gets its
only real test:

| Element | Changes | Announced |
|---|---|---|
| `#live-progress-text` | every reported step | no — visible only |
| `#live-progress-announcement` | each tenth, and on any status change, including completed, cancelled and failed | yes, politely |
| `#live-progress-bar` `aria-valuetext` | every reported step | on demand, when you ask |

The announcement region is part of the run page, not of the training panel,
because the panel is rebuilt on every state change and a region rebuilt with
its text is new to a screen reader rather than changed. What was already true
when you opened the page is not announced; what changes after that is. A
status that arrives while a dialog is still open — the launch or the cancel
confirmation — is held and said when the dialog closes, because the page
behind a modal dialog is inert.

- Is one announcement per tenth the right cadence — too sparse to follow, or
  still too much? It was one per reported step, throttled to 200ms, which is up
  to five queued announcements a second; over a 500-step run the split takes 501
  announcements down to 11.
- When you ask the progress bar for its value, do you get the exact count
  (`aria-valuetext`), or only the percentage the browser computes?
- When the run is interrupted, does the reader learn it **stopped** at once, and
  does it distinguish cancelled from failed? A status change is supposed to
  announce immediately rather than wait for the next tenth. The gate now
  asserts that "cancelled, N% — …" and "failed, N% — …" followed by the
  trainer's reason would each be spoken; before it did, neither was, because
  the region vanished with the progress block. What you can add is whether
  hearing "cancelled" and then the toast "Cancellation requested" in that
  order is confusing.

### 4. Paired report import, including the delayed-import dialog-close path

Evaluations → **Import paired report**. Then repeat it, closing the dialog
*while the import is still resolving* — this is the path #6 fixed and the one
most likely to strand a non-visual user.

- `#report-summary` is the dialog's accessible description, read on entering
  it: "N new · N duplicates · N conflicts". It was a live region rendered with
  the dialog, which announces nothing. If you closed the dialog early, the
  outcome is a toast — is it announced, and does it say enough?
- Where is focus after the dialog closes on its own rather than by your action?
- Replaying an identical report is a no-op. Does the reader convey "nothing
  changed" as clearly as it conveys a successful import? Silence reads as
  failure.

### 5. Human review decision recording

There is no Review page; the decision is a dialog. Evaluations → an evaluation
that already has an imported paired report → **Inspect report** → select the
original `evaluation-report.json` from disk → record an **Approved (review
opinion only)** and a **Rejected**, each with a rationale.

- The decision is the one thing on this site a machine must never record. Is it
  unambiguous, by ear alone, which candidate you are deciding on?
- Are the evidence and the limitations read before the decision buttons?
- Per-case text is temporary and is cleared on close or navigation. Is that
  conveyed before you start typing a rationale, or only discovered by losing it?
- After recording, is the new state announced, or must you go looking?

### 6. Backup restore preview

Settings → restore a backup, including a legacy v1 file and a deliberately
corrupt one.

- `#restore-summary` is the dialog's accessible description, read on entering
  it, and says that nothing has been saved. For the corrupt file, does the
  reader convey that **nothing was changed**? An atomic failure that sounds like
  a partial one is worse than a crash.
- Is the version mismatch (v1 vs current) audible, or only visible?

## What a keyboard-only sweep already established

A scripted keyboard-only pass over these flows ran before this document was
finalised. It is not the pass this issue asks for — it cannot judge whether an
announcement is useful — but it settles the mechanical questions so you do not
spend the session on them:

- Every flow above is completable with Tab, Enter, Space and Escape. No step
  needed a pointer, and no control was unreachable.
- Rejecting the recipe form moves focus to the first invalid field, marks every
  invalid field `aria-invalid`, and `#recipe-readiness` names exactly what is
  missing.
- Both destructive dialogs focus their confirmation control on open and return
  focus to the opener on Escape.
- The review evidence dialog moves focus to its own title once evidence loads,
  and puts provenance, cases and limitations ahead of the decision controls in
  reading order.
- One defect was found and fixed: **every submission that did not navigate left
  focus on `<body>`** — the toast announced the outcome, so nothing on screen
  revealed it, but the keyboard returned to the first Tab stop, nineteen of them
  from the settings form.

So the open questions are the ones about judgement, which is the whole point:
cadence, sufficiency, and whether an outcome that sounds like success was one.

## What the announcement rule already established

A later pass applied the one rule that decides whether a live region is spoken
at all: it announces a change to content it already exposes, not content it
appears with, and at the politeness it had when it was registered. A region
inserted with its text, unhidden with its text, or removed and recreated with
new text looks identical in the accessibility tree to one that was announced.
`scripts/ux-announcements.mjs` records every live-region change in the gate
with that verdict, and it found that most of what the flows above rely on was
rendered and never spoken: every routine toast, the run reaching completed,
cancelled or failed, the playground's "Reply complete", and both preview
summaries. All of those are fixed and pinned. The rule is a model of assistive
technology, not a screen reader: it settles whether an outcome is handed to
one, and nothing about how it sounds.

Two things it raised for you rather than settled:

- After a cancel, the order heard is the held status ("cancelled, 0% — 0 of 4
  learning updates reported") and then the toast ("Cancellation requested for
  the local trainer"). Both are true; is the second one noise?
- Opening a run that is already training announces nothing until the next
  tenth or status change, on the grounds that what is already true is not
  news. The panel heading and the progress bar carry the current state on
  request. Is silence on arrival right?

One the sweep could not answer and is worth your attention: the warning that
per-case review text is temporary appears on the file-selection dialog, before
any evidence loads, and is gone by the time you are typing a rationale in the
next dialog. That is the same for sighted users, so it is a design question
rather than an accessibility defect — but it is a rationale you can lose.

## Review handoff

Track reviewer ownership and timing in [#44](https://github.com/OpenCoven/mamase/issues/44).
The automated keyboard and accessibility-tree passes have run; the outstanding
acceptance criterion is a person listening with VoiceOver. Plan a separate
session for the six flows above. Use synthetic records and a dedicated browser
profile so resets and restores do not touch your working data.

Before starting, record the tested commit (and whether the checkout is dirty),
macOS version, browser version, reviewer, and date. Mark a flow blocked when its
fixtures or local runtime are unavailable. Do not count a blocked or scripted
flow as a completed human pass.

After the account snapshot integration in #53 is available, also check the
Workspace settings account controls: save confirmation, restore preview,
conflict and unavailable-storage messages. Confirm that the announcements
clearly distinguish a local save, an account snapshot save, and a local restore.
Use a synthetic test account and database. Keep any unexecuted snapshot coverage
separate from the original six-flow acceptance criteria.

Copy this receipt into #44 after the session:

```text
Reviewer:
Date:
Commit / dirty checkout:
macOS / browser / VoiceOver:
1. Workspace creation and recovery: pass / finding / blocked
2. Identity-bound preparation: pass / finding / blocked
3. Training launch and interruption: pass / finding / blocked
4. Paired report import: pass / finding / blocked
5. Human review decisions: pass / finding / blocked
6. Backup restore preview: pass / finding / blocked
Account snapshots (#53, additional coverage): pass / finding / not run
Announcement cadence, interruption, and clarity:
Finding issue links:
Remaining blockers:
```

## Recording findings

One row per finding. File each as an issue with these columns filled in; link
the issues back to #44.

| Flow | Step / keystroke | Element | What happened | What should happen | Pass |
|---|---|---|---|---|---|
| | | | | | keyboard / screen reader |

## After the pass

1. File the findings as issues with reproduction steps.
2. For each finding the automated runner **could** have caught and did not, add
   a regression to `scripts/verify-ux.mjs`. This is the durable half: a human
   pass that leaves the runner unchanged has to be repeated from scratch next
   time.
3. Leave the `limitations` string in `scripts/validate.mjs` alone. It states
   that human review was not executed *by the gate*, which no single review
   makes untrue. Change it only if that claim itself stops being accurate.
