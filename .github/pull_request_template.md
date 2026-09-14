## Outcome and linked issue

Link the scoped issue. Use `Closes #...` only when every acceptance criterion is
met and this PR is intended to land on the default branch; otherwise use `Refs`.

## Meaningful changes

Describe the behavior change, compatibility/migration implications, and explicit
non-goals. Call out any deviation from the issue's accepted scope.

## Evidence

Record exact commands and results, the behavior exercised, and any unexecuted
device/platform coverage. Use synthetic or redacted evidence only. A skipped ML
job is not a passing training/evaluation result.

## Risks and recovery

Explain failure handling, recovery/rollback, and remaining limitations.
Distinguish experiment evidence from a separate human model-adoption decision.

## Completion

- [ ] Acceptance criteria and dependency status are current on the linked issue.
- [ ] Private data, identity files, prompts/responses, weights, and credentials are excluded.
- [ ] Existing workspace/theme behavior and supported backup formats are preserved.
- [ ] No fake progress, silent fallback, automatic promotion, or new authority was introduced.
- [ ] Required evidence is recorded; omissions are explicit rather than implied to pass.
