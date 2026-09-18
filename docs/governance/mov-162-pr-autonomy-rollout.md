# MOV-162 PR-autonomy rollout

Automatic readiness and merge are deliberately disabled until a human enables
the rollout. The implementation is an extra dispatcher pass; disabling it
does not change Linear tracking, manual PR handling, worker routing, or CI.

## Initial allowlist

Only a dispatcher-owned, same-repository `agent/MOV-NNN-*` PR may qualify.
Its Linear issue must carry `agent-ready`, `risk:low`, and `execution:mac`.
The PR may change only `docs/**` and must contain all of the following in
Readiness Evidence:

- `Autonomy: eligible`
- `Human testing: not-required`
- non-empty local-agent evidence
- a non-empty no-human-testing rationale

All required checks must be successful on the observed head SHA, with no
stale/missing/skipped check evidence or requested changes. The selected review
control is the current-SHA required `lane-review` check; no approval is
substituted for that independent review gate. Any automatic repair activity
refuses both actions.

`human-only`, auth, calendar, database, deployment, and security labels, plus
paths outside `docs/**`, are excluded. `Autonomy: disabled` in the issue or PR
is a per-item kill switch.

## Staged enablement and rollback

1. Keep `MOVIECAL_PR_AUTONOMY` unset for the normal manual workflow.
2. For the first supervised draft-ready action, set
   `MOVIECAL_PR_AUTONOMY=true` and `MOVIECAL_PR_AUTONOMY_MAX_ACTIONS=1`.
3. Inspect the Linear action metric, PR, current SHA, and
   `~/.config/moviecal/pr-autonomy-ledger.json`, then unset the global switch.
4. A later supervised merge exercise needs a cap that covers both recorded
   actions. It must have current-SHA required checks, including
   `lane-review`, before GitHub auto-merge is requested.

Rollback is immediate: unset `MOVIECAL_PR_AUTONOMY`, or write
`Autonomy: disabled` on the relevant issue/PR. Do not delete the ledger during
an incident; it is evidence and prevents accidental retries. GitHub auto-merge
can be disabled on the affected PR through normal GitHub controls if it was
already requested.

## Metrics and review

Every applied or failed action is durably reserved with its issue, PR, SHA,
action, timestamp, and outcome. Applied actions also post a Linear comment
with the running `actions/cap` metric. The rollout review date is **2026-10-02**.
At that review, record in MOV-162 the number of attempted/applied/failed
actions, all refusal reasons, any rollback use, and whether the docs-only
allowlist should remain unchanged.
