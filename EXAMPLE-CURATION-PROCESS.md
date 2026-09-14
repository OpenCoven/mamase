# Example-curation and grant-tracking process

This documents the elicit → verify → adopt loop used to build a curated,
Val-approved example dataset for identity-bound adapter training, adapted to
this repo's existing conventions rather than introduced as a parallel system.

It is a process document, not a data store. No canonical lesson content,
elicited example text, or per-example transcript excerpts belong in this
repository. `.github/CONTRIBUTING.md` already prohibits private datasets,
canonical familiar identity/memory, and raw per-case reports in GitHub,
including this private repo; that rule applies to curated training examples
exactly as it applies to evaluation reports. The actual example files live in
the owning familiar's private workspace outside this repo. What this repo
tracks is the *state* of curation (which lesson/slot is adopted, blocked, or
pending) and the *mechanism* (how an adoption is verified), never the content.

## Why adapt instead of reuse verbatim

An earlier draft of this process (workspace-local to one familiar) tracked
lesson/example status in three parallel Markdown files: a master examples
file, a per-lesson worksheet, and a grants ledger. That works for a
single-operator private workspace, but it conflicts with two rules already in
force here:

1. **No second backlog.** CONTRIBUTING.md: "GitHub issues are the planning
   source of truth; do not build a second backlog in the application or keep
   competing status spreadsheets." A worksheet-per-lesson file is exactly the
   competing spreadsheet that rule forbids.
2. **No raw content in the repo.** Even status-only ledgers tend to
   accumulate quoted example text as evidence. GitHub issues here already use
   hashes and summaries instead of raw content for the same reason
   (`human-review.js`'s `sha256` fields; `preflight.py`'s header-only
   inspection). Curation evidence should follow the same pattern.

So: **use GitHub issues for status, hashes for integrity, and keep the
example content itself out of this repo entirely.**

## Per-example loop

1. **Elicit** — pose the lesson's fixed elicitation questions to the human,
   in their own words, inside the private workspace (not this repo).
2. **Verify the elicitation turn** — check the elicitation answer against the
   actual conversation transcript before citing it. Never infer the human's
   answer from the assistant's own suggested reply text.
3. **Compose** — draft a candidate Input/Target pair from the elicited answer
   only, in the private workspace.
4. **Dedup-check** — compare the candidate's underlying mechanic against every
   prior example already adopted for that lesson; confirm it tests something
   distinct.
5. **Present for adoption** — show the candidate to the human; record
   nothing yet, anywhere.
6. **Wait for explicit adoption** — a literal "Adopt as drafted" (or a
   revision request).
7. **Verify the adoption turn** — same transcript check as step 2, applied to
   the adoption message.
8. **Record state, not content:**
   - Content (the full Input/Target/Authorship/Approval entry) is written
     only to the private workspace's example file — never to this repo.
   - This repo gets a **status update on the tracking issue** for that
     lesson (see below): slot count, e.g. "3/5 adopted", and a content hash
     of the recorded example if an integrity check is useful, not the
     example text itself.
9. **Pin the turn index** — if the adoption turn wasn't queryable yet at
   record time, mark the issue comment "pending re-verification" and confirm
   it on the next turn. Never leave that unresolved across a session boundary.

## Tracking in this repo

- One GitHub issue per lesson (or one issue with per-lesson checklist items,
  if the dataset is small enough that per-lesson issues would be noise).
  Use the existing `documentation` or `enhancement` type label plus
  `area:workflow` from the label table in `.github/CONTRIBUTING.md` — do not
  invent new labels for this.
- Issue body/comments record: lesson id, slots filled (e.g. `4/5`), which
  slot is currently in progress, and any blocking dependency — the same
  fields CONTRIBUTING.md already asks every issue to carry (user outcome,
  current evidence, acceptance criteria, dependencies).
- Close the issue (or check its item) only when all slots for that lesson are
  adopted, mirroring the existing "close only after acceptance criteria are
  met" rule.
- If a slot's example content needs to move alongside the codebase's own
  reproducible-evidence pattern, reference it by hash
  (`sha256`, matching the field name already used in `human-review.js` and
  `results.js`) in the issue comment, not by pasting the text.

## What stays workspace-private

- The lesson question sets themselves (content, not process).
- Every drafted or adopted Input/Target pair.
- The elicitation/adoption transcript excerpts used for verification.

## What's genuinely reusable from this repo

- The **hash-then-reference** pattern from `human-review.js` (`sha256`,
  `sameMetadata`) for proving an adopted example matches what was elicited,
  without storing the example itself where it can leak.
- The **review-state vocabulary** (`REVIEW_STATES` in `human-review.js`:
  `approved`, `rejected`, `needs-more-evidence`) as a model for a lesson
  slot's own three states: adopted, rejected-as-drafted,
  needs-re-elicitation — keeping the language consistent across both review
  surfaces in this project.
- CONTRIBUTING.md's existing claim → implement → evidence → close loop as the
  literal issue lifecycle for a lesson, instead of a bespoke one.
