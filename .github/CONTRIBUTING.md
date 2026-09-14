# Contributing to Mamase

Start with [the roadmap](https://github.com/OpenCoven/mamase/issues/1) and the
[Reliable local experiments v1 milestone](https://github.com/OpenCoven/mamase/milestone/1).
GitHub issues are the planning source of truth; do not build a second backlog
in the application or keep competing status spreadsheets.

## Turn observations into actionable issues

Search open and closed issues before creating one. Use the bug, improvement, or
experiment form. Each issue needs a user outcome, current evidence, bounded
scope/non-goals, acceptance criteria, a verification plan, and dependencies.
Separate observed facts from hypotheses. Split work that cannot be delivered
and reviewed independently.

Never put private datasets, canonical familiar identity/memory, credentials,
model weights, or raw per-case reports into GitHub, including this private
repository. Reproduce with synthetic data and redact machine-specific paths.
Report hashes and engineering summaries only when appropriate for sharing.

## Triage and order

Reuse `bug`, `enhancement`, and `documentation` for work type. `roadmap` denotes
an outcome tracker, not an implementation task.

| Dimension | Labels and meaning |
| --- | --- |
| Area | `area:lab`, `area:eval`, `area:workspace`, `area:quality`, `area:workflow` |
| Priority | `priority:p1`: core milestone/trust/reliability; `priority:p2`: important follow-up |
| Ready | `status:ready`: scope and acceptance criteria clear, dependencies satisfied |
| Active | `status:in-progress`: an owner is actively implementing a linked branch |
| Blocked | `status:blocked`: native dependency or explicit external decision prevents progress |
| Review | `status:in-review`: implementation and evidence are available, not yet landed |

An open issue without a status label is **backlog**. Use at most one status
label. Closed is the terminal state; do not invent a competing `done` label.
An urgent data-loss or evidence-integrity problem takes precedence; explain
impact and escalation in its issue instead of quietly inflating every priority.

Add implementation issues as native sub-issues of the roadmap. Use GitHub's
native **blocked by** relation for genuine prerequisites and mirror the links
in the body for readers. A roadmap checklist groups delivery; it is not a
dependency graph. Avoid dependency cycles and dependencies that merely mean
"related."

Choose a milestone only when the issue serves its outcome. There is no promised
deadline until a contributor estimates and accepts the work.

## Claim, implement, and review

1. Claim one ready issue with an accountable contributor, branch, and next
   bounded step. For a coding agent, include the sponsoring contributor/session
   and branch in a comment rather than assuming the familiar name is a GitHub
   account.
2. Move it to `status:in-progress`. Respect worktree ownership and existing edits.
   Keep scope changes and newly discovered dependencies in the issue, not only
   in chat.
3. Implement the smallest complete change. Reuse existing helpers and runners;
   preserve local-only behavior, state integrity, and supported backup formats.
4. Record changed paths, exact verification commands/results, remaining
   limitations, and a commit/PR reference. Move to `status:in-review` only when
   the evidence is available. Mark local-only commits explicitly; they are not
   reviewable GitHub links until pushed.
5. Close only after the acceptance criteria are met and implementation lands on
   `main`, normally through the linked PR. For a non-code experiment, close
   after the agreed evidence has been reviewed. Model adoption still needs its
   separate explicit approval.

When blocked, name the missing decision or dependency and the next unblock
action. When a prerequisite closes, re-check readiness and update the status
label; labels do not synchronize themselves with dependency completion.
Remove active-status labels when closing. Use the appropriate closed reason
and rationale for duplicate or not-planned work.

Do not auto-close stale issues, infer completion from a green badge, or report
an unexecuted hardware path as covered. Periodically inspect the milestone for
ownerless active issues, stale blockers, duplicates, and oversized scope.

## Evidence and development commands

The browser workspace uses Node's built-in runner:

```sh
npm test
```

Local ML coverage additionally requires the pinned environment documented in
the README. Run it with `.venv/bin/python` available, or explicitly set
`MAMASE_TRAINING_PYTHON`. A run that skips ML coverage is browser/domain evidence
only. CUDA/QLoRA and full-size models need their own hardware evidence; tiny
synthetic fixtures prove pipeline behavior, not candidate quality.

Treat lower holdout loss, lexical rule passes, human rubric scores, and model
adoption as distinct claims. Never start a costly experiment, collect private
data, change identity, or grant permissions merely because an issue exists.

Useful native tracking views:

```sh
gh issue list --repo OpenCoven/mamase --label status:ready
gh issue list --repo OpenCoven/mamase --label status:blocked
gh issue list --repo OpenCoven/mamase --milestone "Reliable local experiments v1"
```

## Automation and required checks

`.github/workflows/validation.yml` runs the same `scripts/validate.mjs` commands
as the [complete local gate](../README.md#reproducible-validation), on PRs,
pushes to `main`, and manual dispatch. Expected check names are stable:

| Check | Executed scope |
| --- | --- |
| `Node 22 / workspace` | Full existing Node suite; two explicitly excluded optional ML cases |
| `Node 24 / workspace` | Same suite on Node 24, including local WorkOS/auth/hosted fixtures |
| `Python 3.14 / CPU adapters` | Python 3.14.7, exact pinned requirements, actual CPU adapters/evaluator/preflight, zero skips |
| `Chromium / UX and protocol` | Existing `verify-ux.mjs` plus `verify-training.mjs --protocol-fixture`; no real MLX claim |

Permissions are `contents: read`; checkout does not retain credentials. Jobs
have 15/30-minute limits; newer runs cancel superseded runs for the same PR/ref.
No secrets, real model downloads, provider accounts, or private fixtures are
needed. Install dependencies from the committed lockfiles/pins; there is no
cache of familiar data or model outputs.

Only a failed browser job uploads evidence, retained for three days: the gate
summary, a small synthetic failure JSON, and at most one CSS-resolution
viewport PNG capped at 2 MiB. The artifact paths are an explicit allowlist.
No traces, HAR, DOM/storage dumps, console logs, datasets, identity files,
cases/reports, `.lab`, `.mamase`, general workspaces, environments or caches
are uploaded. The runner uses new synthetic browser contexts, disables service
workers and blocks non-loopback requests before transmission. Legacy optional
`MAMASE_SCREENSHOTS` captures are local-only and are not passed through the gate
or included in CI uploads.

A maintainer must first observe all four genuine PR checks, review failure
behavior/evidence, then manually select their exact check names in the intended
branch protection/ruleset if required. This implementation does not change
protections. Billing/provider refusal remains an operator-owned external
blocker; a successful local gate neither bypasses that policy nor supplies
hosted review approval. Missing dependency/interpreter and intentional browser
failure paths are reproducible in `node --test tests/automation.test.js`.

## Accessibility evidence and limits

The existing browser runner checks light, dark, and system-following-light/dark
modes. It measures WCAG relative-luminance contrast (4.5:1 normal text/status
samples, 3:1 focus tokens), opaque computed badge/button colors and key palette
pairs. It checks visible text and Chromium accessibility-tree names for all
six run states and paired regressions, rather than relying on colored dots.
These samples are not a complete WCAG audit of every pixel, gradient,
transparency, hover/disabled state, or browser.

At 320px, 760px, desktop and short landscape sizes, synthetic journeys use Tab,
arrow scrolling in wide table regions, Enter and Escape to reach dataset,
recipe, report, training-result, paired-review and export actions. They check
focus outlines, dialog dismissal/focus return and recoverable errors. Delaying
both `File.text()` and `File.arrayBuffer()` during paired imports, closing and
reopening the dialog, then releasing the old read must leave the exact prior
workspace intact; a subsequent retry succeeds.
Malformed paired JSON must produce content-free diagnostics, never raw file
excerpts in the dialog or toast. A dismissed read must report cancellation
before parsing or validating the previously selected report.

Playwright keyboard events and accessibility snapshots **are not a human
keyboard-only or screen-reader review**. No VoiceOver, NVDA, JAWS, TalkBack,
speech/braille output, switch access, real mobile assistive technology, or
human announcement timing review is claimed. Before declaring assistive-tech
acceptance, record OS/browser/AT versions, use only the keyboard to navigate,
check wide-table scrolling and dialog focus trapping/return, listen to live
error/status announcements, and recover from the delayed-import case without
losing data. Screenshots alone do not establish accessibility.

Issue forms and the PR template activate after these files reach the default
branch. Creating labels and issues alone does not activate local templates.
