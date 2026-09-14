# Managed MLX lane (Train on this Mac)

Receipt lane `managed-mlx`. Steps: plan → capability → launch → job → register →
test → human-review. The skill never launches, cancels or resumes a job; those are
browser actions with the browser-held command token.

## Capability (read-only)

```bash
npm run ops -- receipt --workspace ... --run run-1 --server http://127.0.0.1:3000
```

`--server` must be a loopback URL. The receipt performs GETs only, follows no
redirects, drops the `token` field, and classifies `runtime.state`:

| state | meaning | what you do |
|---|---|---|
| `available` | local MLX runtime probe passed | next action `launch` (approval required, in the UI) |
| `busy` | another job holds the runtime | wait; do not cancel without explicit approval |
| `unavailable` | probe failed | blocker `runtime-unavailable`; report install steps, do not retry in a loop |
| `disabled` | server not started with `npm run dev` | blocker `runtime-disabled` |
| `unsupported` | hosted deployment | blocker `hosted-disabled`; this lane does not exist here |
| `unreachable` / `unknown` | no answer / not queried | before launch: query again; after launch: look the job up, never relaunch |

Capabilities never prove the model or memory is ready.

## Launch and job

The human launches from the Mamase UI (`POST /api/training/jobs`). The workspace
records `run.localJobId` (`job-<uuid>`). While `job.status` is `starting`,
`running` or `cancelling`, the receipt's next action is `job` (wait). If the
response was lost, `nextAction.step: "job"` with `lookup: GET /api/training/runs/<runId>`
— look it up by run ID. Only when the server answers and does not know the job is
it `job-missing` (check `outputRoot` or a different server; still no relaunch).

Terminal states are honest: `completed` → `register`; `failed` → blocker
`job-failed` (MLX does not resume optimizer state; the run stays failed and a new
run is planned only if the user wants one); `cancelled` → `job-cancelled`.

## Register (reconcile the finished job)

```bash
curl -s http://127.0.0.1:3000/api/training/runs/run-1 > job.json      # { job }
npm run ops -- import-job --workspace ... --expected-revision <sha256> --file job.json
```

Uses the browser's `mergeTrainingJob` guards: identity, progress-history prefix,
`localJobId` consistency and `artifact-<jobId>` naming. Outcomes: `changed`,
`unchanged` (already reflected — duplicate imports are safe), `blocked` with
`job-active`, `record-missing` or `job-conflict`. A conflict means the record does
not belong to this run; report it, do not edit either side.

## Test and hand off

`nextAction.step: "test"` points to the local Model playground (`#/testing`).
Replies there are experiment evidence, not evaluation scores. Managed runs have no
paired PEFT evaluation, so no review decision can be recorded against them and the
receipt's `human-review` step stays `pending` permanently: `trained` with
`nextAction.step: "test"` is the terminal receipt state for this lane. The human
decides outside the receipt whether to plan an identity-bound PEFT experiment next;
`evidence-ready` exists only on the PEFT lane.
