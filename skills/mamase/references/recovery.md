# Recovery

Start every recovery with `inspect` (revision) and `receipt` (state). The receipt
already encodes the recovery path; follow it rather than reasoning from memory.

| Symptom | Receipt says | Do | Never |
|---|---|---|---|
| Stale revision | exit 2 `stale-revision` | re-`inspect`, retry with the new revision if the intent still holds | force-write, edit the file |
| `.lock` present | exit 2 `workspace-locked` | wait, then report if it persists | delete a lock you did not create |
| Dataset bytes changed | `source-changed` | tell the user; register the new bytes as a **new** dataset ID and plan a new run | re-add under the old ID |
| Recipe edited after prepare | `recipe-changed` | export the saved recipe again and prepare a new bundle | patch `bundle.json` |
| Result from another bundle | `bundle-changed` | keep both attempts distinct | delete either |
| Managed launch response lost | `job` step, `lookup: GET /api/training/runs/<runId>` | look up by run ID, then `import-job` | relaunch |
| Server does not know the job | `job-missing` | check `outputRoot` / other server | relaunch |
| Job failed / interrupted | `job-failed`, `state: "failed"` | report; a new run only on request | resume, retrain to "fix" the record |
| Job cancelled | `job-cancelled` | report | treat partial outputs as an adapter |
| Duplicate import (progress, result, job, backup) | `unchanged` | nothing — this is the idempotent path | re-import with altered IDs |
| Import conflict | `progress-conflict`, `run-conflict`, `dataset-conflict`, `job-conflict` | report both sides by ID | rewrite either record |
| Runtime missing | `runtime-unavailable`, `runtime-disabled`, `hosted-disabled`, preflight exit 1 | report the blocker with its remedy | poll in a loop, switch lanes silently |

Rules that hold across every row: stable IDs are reused, journals are append-only,
workspaces are never regenerated from memory, and a failed attempt stays failed in
the record. If the receipt gives `nextAction: null` with blockers, the correct
action is a report to the human.
