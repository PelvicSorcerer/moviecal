# MOV-162 PR-autonomy rollout

Automatic readiness and merge are deliberately disabled until a human enables
the rollout. The implementation is an extra dispatcher pass; disabling it does
not change Linear tracking, manual PR handling, worker routing, or CI.

## Intended outcome and rollout stages

[PR #540](https://github.com/PelvicSorcerer/moviecal/pull/540) shipped the
disabled-by-default policy, durable action ledger, bounded GitHub adapter, and
policy tests. That proves the mechanism exists; it does **not** accept the
mechanism for ongoing operation. The shipped policy preserves `docs/**` and
allows only approved low-risk helpers in `src/**` with deterministic coverage
in `test/**`; sensitive application behavior remains fail-closed.

The supervised rollout has four distinct gates:

1. [MOV-271](https://linear.app/moviecal/issue/MOV-271/docs-align-technical-architecture-with-shipped-collaboration-and)
   proves automatic readiness, ordinary GitHub auto-merge, and replay behavior
   with the existing docs-only policy.
2. [MOV-273](https://linear.app/moviecal/issue/MOV-273/expand-pr-autonomy-to-low-risk-application-code-and-tests)
   is manually reviewed and merged to add the owner-approved low-risk
   application-code/test policy and its deny matrix. It consumes no autonomy
   action.
3. [MOV-274](https://linear.app/moviecal/issue/MOV-274/reject-impossible-release-dates-in-the-formatting-helper)
   proves the expanded policy on a genuine pure-helper code fix—not a fixture.
4. [MOV-272](https://linear.app/moviecal/issue/MOV-272/review-pr-autonomy-pilot-evidence-and-decide-operating-mode)
   records `Go`, `Hold`, or `Roll back` after reviewing all evidence.

A `Go` is the graduation point: it authorizes turning the system on for later
real PRs that satisfy the approved docs/application/test policy, without
another per-PR rollout approval. It does not authorize any excluded category.
Until `Go`, and after any `Hold` or `Roll back`, global PR autonomy stays
disabled.

## Current constrained policy

Only a dispatcher-owned, same-repository `agent/MOV-NNN-*` PR may qualify. Its
Linear issue must carry `agent-ready`, `risk:low`, and `execution:mac`. The PR
must contain all of the following in Readiness Evidence:

- `Autonomy: eligible`
- `Human testing: not-required`
- non-empty local-agent evidence
- a non-empty no-human-testing rationale

All required checks must be successful on the observed head SHA, with no
stale/missing/skipped check evidence or requested changes. The selected review
control is the current-SHA required `lane-review` check; no approval is
substituted for that independent review gate. Any automatic repair activity
refuses both actions.

`human-only`, `area:auth`, `area:calendar`, `area:database`,
`area:deployment`, and security-sensitive work is excluded. The only allowed
paths are `docs/**` plus non-sensitive `src/**` and `test/**`; a sensitive or
outside-allowlist path denies the whole diff. `Autonomy: disabled` in the issue
or PR and the `autonomy:disabled` issue label are per-item kill switches.

## Owner-approved first code boundary

MOV-273 may preserve `docs/**` eligibility and add low-risk files under
`src/**` with their associated deterministic unit coverage under `test/**`.
This is a fail-closed allow/deny policy, not blanket permission for both roots.
If any changed path is denied, the whole PR is denied.

The first code policy must exclude at least:

- `.github/**`, `tools/**`, `scripts/**`, `supabase/**`, `ios/**`, `e2e/**`,
  repository configuration, and every root outside `docs/**`, `src/**`, and
  `test/**`;
- API/server boundaries under `src/app/api/**`;
- auth, sign-in, session, middleware, token, calendar, feed, Supabase,
  database, real-stack, private-watchlist data access, cron, deployment, and
  security-sensitive implementation and matching tests;
- browser E2E, visual/accessibility/platform interaction, and anything whose
  issue declares `Human testing: required`;
- issues carrying `human-only`, `area:auth`, `area:calendar`,
  `area:database`, `area:deployment`, a security-sensitive classification,
  missing/incorrect route or risk labels, or either kill switch; and
- any diff with automatic repair activity, incomplete evidence, stale or
  missing current-SHA checks, requested changes, or an exhausted action cap.

MOV-273 must encode deterministic path matchers and policy-matrix tests for
every allowed class, denied class, and mixed diff. Adding a new allowed class
later requires separate owner-approved governance work; an unrecognized path
is denied.

## Recorded baseline

This table is the approved starting point. The live ledger and installed
launchd configuration were rechecked on 2026-09-21.

| Evidence | Recorded result | Rollout meaning |
|---|---|---|
| [MOV-162](https://linear.app/moviecal/issue/MOV-162) / [PR #540](https://github.com/PelvicSorcerer/moviecal/pull/540) | Implementation and policy tests merged. | Mechanism implemented; neither automatic merge nor code autonomy accepted. |
| `~/.config/moviecal/pr-autonomy-ledger.json` | Exactly one entry: `MOV-264:542:e04724f8109b7c5d6e6c556ab21ada9371c2f17f:ready`, outcome `applied`, completed `2026-09-18T18:45:47.666Z`. | Durable baseline count `B = 1`; automatic ready is proven once. |
| [MOV-264](https://linear.app/moviecal/issue/MOV-264/mov-162-disposable-docs-only-pr-autonomy-rollout-fixture) | Linear records `ready` on PR #542 at the same SHA and metric `1/1`. | Ledger and Linear side effects agree. |
| [PR #542](https://github.com/PelvicSorcerer/moviecal/pull/542) | The owner merged it manually at `2026-09-18T18:46:05Z`; no `merge` ledger entry exists. | Automatic merge is **unproven** and must not be credited to autonomy. |
| Installed dispatcher launchd configuration | `MOVIECAL_PR_AUTONOMY` and `MOVIECAL_PR_AUTONOMY_MAX_ACTIONS` are absent. | Global autonomy was disabled after the exercise and remains disabled. |

Any difference between this table and live state is an abort condition, not
permission to adjust the cap in place.

## MOV-275 publication and state-stability recovery

The supervised MOV-271 pilot exposed two fail-closed gaps before its first
merge action: the dispatcher-created draft omitted the repository's structured
`Readiness Evidence`, and GitHub-to-Linear synchronization changed the issue
from `In Review` to `Agent Working` immediately after the authorized ready
action. The rollout was stopped with global autonomy disabled; its original
SHA and ledger rows were preserved.

MOV-275 makes the publisher render the repository PR contract itself. It
copies `Human testing` and `Autonomy` only from an explicit, internally
consistent Manual Verification declaration and records local verification as
passing only when the structured worker transcript proves the exact completed
`npm run verify` command exited successfully. Missing, failed, malformed, or
ambiguous evidence is emitted as incomplete/disabled and remains a draft.

For a successful ready action, the retained registry records the exact
dispatcher-owned issue, PR, branch, repository, and SHA. On the next sweep,
only that still-open, now-ready tuple may recover the exact `Agent Working`
regression to `In Review`; the correction is written once and then becomes a
no-op. No other state, branch, repository, or PR receives this authority.
Keep both autonomy environment variables absent while this governance change
is manually reviewed and merged.

## MOV-274 evidence-capture and worker-sandbox test hygiene (MOV-277)

MOV-274 produced a genuine, correctly-scoped PR (#561, all checks green) that
nonetheless rendered `Autonomy: disabled`, for reasons entirely in the
dispatcher rather than in that PR's own diff. First, the worker ran `npm run
verify 2>&1 | tail -300` to shorten its own output; `readiness-evidence.mjs`'s
exact-literal-command match (by design, MOV-275) then found no matching
transcript event and rendered the local-agent evidence incomplete, even
though verification genuinely passed. Second, the same run hit a real `git
EPERM` inside a handful of `tools/dispatcher/test/**/*.integration.test.mjs`
fixtures that shell out to a real `git` binary — `worker-guard.mjs`'s own
Seatbelt profile already denies the worker that exact capability, so those
fixtures cannot succeed once reached from inside a worker's own `npm run
verify`, independent of anything about MOV-274's change.

MOV-277 fixed both, without touching the evidence contract, PR #561, or
either autonomy environment variable: the worker brief now tells every
worker to run `npm run verify` as its own exact, unwrapped command and names
the consequence of piping or wrapping it; and the affected fixture suites now
skip cleanly (not fail) when a new `MOVIECAL_WORKER_SANDBOX` signal on the
worker's own sanitized environment says they are running inside that same
sandbox, while keeping full coverage on macOS/CI and any human/local `npm run
verify` outside it. See `docs/operators/local-execution.md` §Security model
and `docs/planning/testing-lanes.md` §Dispatcher sandbox-exec integration.
This does not itself advance the rollout sequence below — MOV-274 code ready
is still the next row a supervised poll may attempt, on a clean redrive or
equivalent low-risk pilot.

## Action budget and sequence

The cap is the total durable ledger count, not a per-run allowance. The only
permitted rollout sequence is:

| Stage | Required starting count | Enabled configuration | Required result |
|---|---:|---|---|
| MOV-271 ready | 1 | switch `true`, cap `2` | one `ready`/`applied` row; count 2 |
| MOV-271 merge | 2 | switch `true`, cap `3` | one `merge`/`applied` row; count 3 |
| MOV-271 replay | 3 | switch `true`, cap `3` | no row, mutation, or duplicate comment |
| MOV-273 policy implementation | 3 | switch absent | manual review/merge; count remains 3 |
| MOV-274 code ready | 3 | switch `true`, cap `4` | one `ready`/`applied` row; count 4 |
| MOV-274 code merge | 4 | switch `true`, cap `5` | one `merge`/`applied` row; count 5 |
| MOV-274 replay | 5 | switch `true`, cap `5` | no row, mutation, or duplicate comment |

Remove both environment variables from the installed launchd plist and unload
then load the service after every enabled poll. Confirm the disabled
configuration before inspecting evidence or advancing to the next row.

Before each ready or merge poll, record the candidate PR number and head SHA;
verify the exact labels, route, risk, Readiness Evidence, changed paths, review
state, lack of repair activity, and complete current-SHA required checks; and
enumerate every other retained review worktree. The named pilot must be the
only entry that evaluates to an action. Record a refusal reason for every other
entry.

Do not raise the cap after a refusal, failure, unexpected reservation, changed
SHA, or unrelated action. A failed reservation consumes durable budget and
requires human review and a newly approved plan.

## Abort and rollback

Abort before or during either pilot if the baseline/count differs; the named
pilot is not the sole actionable entry; its issue, PR, branch, repository,
paths, labels, evidence, review state, or current-SHA checks drift; repair
activity appears; the head SHA changes between ready and merge; a ledger row
is missing, duplicated, left `in-progress`, failed, or targets anything else;
a GitHub or Linear side effect disagrees with the ledger; the service cannot be
confirmed disabled; or the owner cannot continuously supervise the poll.

Rollback steps are independent of ordinary dispatch:

1. Remove `MOVIECAL_PR_AUTONOMY` and
   `MOVIECAL_PR_AUTONOMY_MAX_ACTIONS` from the installed launchd configuration,
   unload and load `~/Library/LaunchAgents/com.moviecal.dispatcher.plist`, and
   confirm both keys are absent from the live service configuration.
2. Add `autonomy:disabled` to the issue or an exact `Autonomy: disabled` marker
   to the issue or PR when an item-level stop is also needed.
3. If GitHub auto-merge was already requested, disable it through normal GitHub
   controls. Do not manually merge a pilot while its evidence is being judged.
4. Preserve the ledger and dispatcher logs. Record the trigger, last known
   configuration, PR/SHA, ledger count and rows, GitHub state, Linear comments,
   and whether normal disabled polling continued.

Never delete or rewrite the ledger during rollback: reservations are evidence
and prevent same-SHA/action retries.

## Exit criteria and final operating decision

The rollout is acceptable only when all of the following are true:

- MOV-270 was owner-approved and merged before MOV-271 was unblocked.
- MOV-271 produced exactly one ready and one merge action on one unchanged SHA,
  and its replay produced no additional side effect.
- MOV-273 was manually reviewed and merged with the approved allow/deny matrix,
  complete policy tests, global autonomy disabled, and ledger count still 3.
- MOV-274 produced exactly one ready and one merge action on one unchanged code
  PR SHA, and its replay produced no additional side effect.
- The complete ledger has exactly five explained rows: the earlier MOV-264
  ready action, MOV-271 ready and merge, and MOV-274 ready and merge.
- GitHub shows ordinary required-check-gated auto-merge for both pilots, while
  Linear comments, GitHub state, logs, and ledger `actions/cap` metrics agree.
- Every refusal, failure, manual intervention, rollback action, and
  configuration change is classified; there is no unexplained mutation.
- Global autonomy is disabled again and ordinary reconciliation still works
  when MOV-272 begins its review.

MOV-272's evidence packet must include immutable PR URLs and head SHAs,
current-SHA required checks, relevant Linear action comments, the complete
redacted ledger, dispatcher top-level logs for every supervised poll, the
merged MOV-273 policy/test evidence, replay results, and any item-level kill
switch or GitHub auto-merge cancellation used.

MOV-272 then records exactly one owner decision:

- **Go:** turn the system on for later real eligible docs, low-risk application
  code, and associated unit-test PRs without per-PR rollout approval. Record a
  finite new total action cap above 5, review cadence, rollback owner, and the
  exact unchanged or narrower allow/deny matrix.
- **Hold:** keep global autonomy disabled until named corrective work and a new
  review are complete.
- **Roll back:** keep global autonomy disabled, apply any item-level stop or
  code rollback required, and record the reason and recovery condition.

Expanding the approved code boundary or removing an exclusion is not implied by
`Go`; it requires separate owner-approved governance work.

## Metrics and review

Every applied or failed action is durably reserved with its issue, PR, SHA,
action, timestamp, and outcome. Applied actions also post a Linear comment with
the running `actions/cap` metric. The rollout review date is **2026-10-02**. At
or before that review, MOV-272 records attempted/applied/failed counts, refusal
reasons, rollback use, the owner decision, the initial operating cap and
cadence for `Go`, and the retained allow/deny matrix.
