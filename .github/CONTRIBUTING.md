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

Issue forms and the PR template activate after these files reach the default
branch. Creating labels and issues alone does not activate local templates.
