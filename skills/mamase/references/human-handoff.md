# Human handoff

The workflow ends when a human can review. It does not end with a deployment,
identity change or tool grant, and you never perform those.

## Produce the handoff artifacts

```bash
npm run ops -- receipt --workspace ... --run run-1 [--bundle .lab/experiment] --out .lab/agent/receipt-run-1.json
npm run ops -- export-backup --workspace ... --out .lab/agent/backup.json
```

- The receipt is the resumable record: lane, fingerprints, steps with evidence,
  blockers, `nextAction`, and `handoff` text stating what a human still has to do.
- The backup is `mamase.workspace-backup.v1`, importable in the UI under **Settings**. It
  carries records and fingerprints, not dataset bytes or case text.

## Summary to the human

State, in this order: lane and `familiarContext.scope`; run/dataset/bundle/result/
report fingerprints; each executed step and its evidence IDs; open blockers with
their codes; your recommendation labelled as such, with limitations. Point to the
review surface (the evaluation's **Human review opinions** section in Results) and to the receipt
`nextAction.requiresApproval` flag.

## After the human decides

The decision appears as `evaluations[].reviews[]` in the next backup / workspace
import. `receipt` then reports `human-review: done` and `state: "evidence-ready"`.
`needs-more-evidence` is a normal outcome: plan the next experiment as a **new**
run; never reopen or rewrite the reviewed one.
