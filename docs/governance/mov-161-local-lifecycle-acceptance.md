# MOV-161: local lifecycle acceptance and recovery runbook

This is the operating ledger for the human-led acceptance of the local-first
delivery lifecycle. It records live, disposable exercises and deterministic
coverage separately. Nothing in this document makes Linear Coding Sessions,
Agent Sessions, or automatic readiness/merge a prerequisite for the local
path.

## Safety boundary

- Use only disposable Linear issues, `agent/MOV-<id>-*` branches, draft pull
  requests, and dev-only credentials. Never exercise against a product issue,
  protected branch, production environment, or user data.
- Keep the dispatcher at its normal one-worker concurrency. Do not create an
  interactive worktree below the dispatcher's managed worktree root.
- Before every live exercise, run `npm run dispatcher:doctor` and `npm run
  dispatcher:dry-run`. Record only their pass/fail summaries; never capture
  environment variables, tokens, webhook credentials, or raw service dumps.
- The normal observation surfaces are the Linear issue's state and comments,
  the disposable PR, the managed-worktree registry, and the per-issue log
  directory. Agent Sessions are optional presentation only.
- Cancel the Linear fixture and close its draft PR without merging after each
  non-merge drill. Remove its clean dispatcher-owned worktree through normal
  reconciliation or the documented operator procedure.

## Baseline

| Recorded | Result |
|---|---|
| 2026-09-17 | `dispatcher doctor` passed: Linear and GitHub authenticated; the worker guard was enforced; `moviecal-ios-runner` was online; Agent Sessions and live steering were off. |
| 2026-09-17 | `dispatcher dry-run` reported no `Ready for Agent` issues and made no mutations. |
| 2026-09-17 | Deterministic transition coverage passed: `npm run lane:unit` (82 files, 1,206 tests) and `npm run lane:integration` (19 files, 151 tests). The integration lane requires the host macOS sandbox; it is not valid inside the coding sandbox. |
| 2026-09-17 | Disposable child [MOV-239](https://linear.app/moviecal/issue/MOV-239/mov-161-fixture-manual-polling-lifecycle-marker) was created in `Spec Ready` as a manual hold. It has no delegation, worktree, branch, worker attempt, or pull request. |
| 2026-09-17 | Both Loops were individually disabled through Linear while Agent Sessions stayed off. MOV-239 was moved to `Ready for Agent` and manually delegated to `moviecal-dispatcher`; it was never handled by either Loop. |
| 2026-09-17 | MOV-239 first exercised the routing boundary: `model:strong` without an `upgrade:*` condition moved it to `Needs Human Decision` with no worktree, branch, worker, or PR. Replacing that fixture label with `model:default` and requeuing it produced one claim, one managed worktree, one `agent/MOV-239-*` branch, and one Claude worker attempt. |
| 2026-09-17 | The claimed worker safely escalated MOV-239 to `Needs Human Decision` with no push or PR after the command audit falsely classified its required read-only `cat AGENTS.md` orientation as an AGENTS.md edit. Its one unpushed fixture file is preserved in the failed managed worktree. [MOV-240](https://linear.app/moviecal/issue/MOV-240/allow-required-read-only-agentsmd-orientation-in-worker-audit) is the held security-boundary follow-up. |
| 2026-09-17 | Both Loops were restored individually after the drill. MOV-239 is not eligible while escalated, and MOV-240 remains in `Spec Ready`; restoration could not trigger a new worker. |
| 2026-09-18 | MOV-240 merged in [PR #502](https://github.com/PelvicSorcerer/moviecal/pull/502); the fixture-only [MOV-241](https://linear.app/moviecal/issue/MOV-241) read-only-orientation drill succeeded. The dispatcher service now runs merged master (9ac7f96). MOV-161 is unblocked and moved back to `Backlog`; MOV-239 is still `Needs Human Decision` with its unpushed fixture file preserved and has not yet been redriven to a normal publication. |
| 2026-09-18 | `dispatcher doctor` and `dispatcher dry-run` re-run clean against merged master; both Loops manually disabled in Linear. Fresh disposable fixture [MOV-242](https://linear.app/moviecal/issue/MOV-242) created, delegated to `moviecal-dispatcher`, and claimed: one worktree, one `agent/MOV-242-*` branch, one Claude worker attempt. The worker hit a second, distinct guard false positive (`find -newer AGENTS.md`) and safely escalated to `Needs Human Decision` with no push or PR. [MOV-243](https://linear.app/moviecal/issue/MOV-243) is the new held follow-up. |
| 2026-09-18 | MOV-243 merged ([PR #506](https://github.com/PelvicSorcerer/moviecal/pull/506); unit 1224, integration 151). Redrive [MOV-244](https://linear.app/moviecal/issue/MOV-244) claimed cleanly on merged master (8fe1bda) and hit a third guard false positive, this time a `canonicalize()` placeholder-collision parser bug rather than missing command coverage; safely escalated with no push or PR. [MOV-245](https://linear.app/moviecal/issue/MOV-245) is the held follow-up ([PR #509](https://github.com/PelvicSorcerer/moviecal/pull/509)); local unit 1228, integration 151 pass. |

The fallback configuration for all fixtures below is therefore ordinary
polling plus Linear state/comments. The Loop and Agent Session controls are
changed independently and restored before any subsequent fixture starts.

## Transition ledger

Each row requires an actual identifier/link before it may be marked observed.
`Deterministic evidence` names the regression suite that must pass even when
the live step is inherently operator-driven.

| Scenario | Expected durable result | Deterministic evidence | Live evidence | Status |
|---|---|---|---|---|
| Loop intake | Exactly one Triage issue is enriched; it never delegates or starts execution. | `tools/dispatcher/test/promoter.test.mjs` | MOV-156 fixture ledger | Observed — MOV-156 |
| Bounded Loop-to-Mac handoff | On an eligible triggering issue, the Loop sets only `delegate = moviecal-dispatcher`; replay is a no-op. | `tools/dispatcher/test/dispatch-eligibility.test.mjs` | MOV-220 fixture ledger, PR #487 | Observed — MOV-220 |
| Local execution | One eligible manually delegated fixture creates one managed worktree, one agent branch, one worker attempt, and one draft PR. | `tools/dispatcher/test/run-loop-e2e.test.mjs` | MOV-239: one worktree, branch, and worker; publication blocked without push/PR by false guard finding. MOV-242 redrive (post-MOV-240): same clean claim/worktree/branch, but a second, distinct guard false positive blocked publication again. MOV-244 redrive (post-MOV-243): same clean claim, third distinct false positive (parser bug, not coverage gap). MOV-246 redrive (post-MOV-245): one worktree, one `agent/MOV-246-*` branch, one worker attempt, one draft PR ([#511](https://github.com/PelvicSorcerer/moviecal/pull/511)) whose diff contained only the named fixture file; closed unmerged after evidence recorded | Observed — MOV-246 |
| iOS execution | A disposable iOS-scoped fixture follows the same claim/publication lifecycle and records its required iOS lane evidence. | `tools/dispatcher/test/worker-routing.test.mjs` | Pending MOV-161 fixture | Pending |
| Cross-platform split and coordination parent | A coordination parent remains non-executable; independently routed children preserve their blocking order. | `tools/dispatcher/test/dependency-gate.test.mjs` | MOV-156 fixture ledger (`MOV-224`, `MOV-228`–`MOV-230`) | Observed — MOV-156 |
| Manual + polling fallback | With both Loops disabled and Agent Sessions off, manual specification, delegation, polling, comment/state publication, and GitHub reconciliation complete one local fixture. | `tools/dispatcher/test/run-loop-e2e.test.mjs` | MOV-239: both Loops disabled; manual Ready/delegate; polling produced one claim and durable comment/state publication. MOV-242 and MOV-244 redrives: identical fallback behavior each time, still blocked short of normal PR publication. MOV-246: both Loops still disabled; manual Ready/delegate; polling produced one claim, durable comment/state publication, a draft PR, and closed-unmerged reconciliation (worktree marked `abandoned`) | Observed — MOV-246 |
| Mac-offline recovery | A delegated Ready-for-Agent fixture creates no local artifact while the daemon is stopped, then creates exactly one attempt after restart. | `tools/dispatcher/test/run-loop-e2e.test.mjs` | MOV-220 fixture ledger, PR #492 | Observed — MOV-220 |
| Worker crash + restart recovery | A stopped worker leaves no duplicate attempt; startup reconciliation returns clean work to Ready for Agent or escalates preserved work. | `tools/dispatcher/test/startup-recovery.integration.test.mjs` | Pending MOV-161 fixture | Pending |
| Closed-unmerged PR | Reconciliation preserves PR/branch evidence and moves a non-terminal issue to Needs Human Decision. | `tools/dispatcher/test/pr-reconcile.test.mjs` | Pending MOV-161 fixture | Pending |
| Bounded CI repair | A safe CI failure receives no more than the configured repair budget across fresh head SHAs. | `tools/dispatcher/test/run-loop-e2e.test.mjs`, `tools/dispatcher/test/repair-ledger.test.mjs` | Pending MOV-161 fixture | Pending |
| Trusted review repair | A trusted actionable review can trigger the bounded repair lifecycle; untrusted review cannot. | `tools/dispatcher/test/repair-lifecycle.integration.test.mjs`, `tools/dispatcher/test/repair-policy.test.mjs` | Pending MOV-161 fixture | Pending |
| Sensitive escalation | A security-sensitive failure moves only the fixture to Needs Human Decision with an auditable reason and no repair/publication. | `tools/dispatcher/test/security-policy.test.mjs` | MOV-239: false-positive AGENTS.md safety finding, checksummed audit, no push, PR, or repair | Observed — MOV-239 |
| Repair-budget exhaustion | Further safe repair is refused after the persisted budget is spent, including after restart. | `tools/dispatcher/test/run-loop-e2e.test.mjs` | Pending MOV-161 fixture | Pending |
| Merge completion | GitHub is the merge authority; a merged disposable PR reaches Done via sync or the idempotent reconciliation backstop. | `tools/dispatcher/test/pr-reconcile.test.mjs` | Pending MOV-161 fixture | Pending |

## Fixture procedure

1. Create a disposable issue with a narrow, documentation-only change, exact
   acceptance criteria, Testing Expectations, `Human testing: not-required`
   rationale, `execution:mac`, and no `human-only` or coordination label.
2. For manual/polling fallback, disable the two Loops in Linear and verify
   Agent Sessions remain off. Manually delegate only that fixture to
   `moviecal-dispatcher`; do not change its route after the claim begins.
3. Observe the claim, worktree, branch, draft PR, and lifecycle comments. Use
   `dispatcher dry-run` before and after; compare identifiers rather than
   interpreting an absence of logs as a pass.
4. For a stop/restart drill, stop only the daemon, make the named fixture
   eligible, verify it is still artifact-free, then restore the daemon and
   wait for one claim. Do not stop a worker mid-write unless the scenario
   explicitly targets crash recovery.
5. For failure drills, use the fixture harnesses and deliberately harmless
   repository changes. Do not forge security logs, modify credentials, or
   produce a failing change on `master`.
6. Preserve links and outcomes in this ledger. Cancel/close cleanup fixtures;
   the single merge-completion fixture is the sole exception and must be a
   reviewable documentation-only PR.

## Independent disablement

| Component disabled | Required fallback | Verification |
|---|---|---|
| Intake Loop | Human/Triage intake plus the deterministic promoter remain available. | Create/specify the disposable fixture manually; dry-run remains non-mutating. |
| Local-handoff Loop | A human can assign `moviecal-dispatcher`; polling remains the only worker trigger. | Manual delegation produces the same one-attempt lifecycle. |
| Agent Sessions / stream | Linear state and app-actor comments remain the complete lifecycle surface. | Keep `MOVIECAL_AGENT_SESSIONS` unset; observe every transition in Linear. |
| Dispatcher daemon | Eligible work stays durably queued in Linear; no local artifacts appear until restart. | Offline recovery fixture. |
| Automatic repair | A failed fixture waits for human decision; no automatic retry is attempted. | Sensitive-escalation fixture. |
| Automatic readiness/merge | Draft PR remains draft until a human evaluates evidence; GitHub rules govern merge. | Merge-completion fixture. |

## Observed exception and required action

MOV-239 must not be requeued while [MOV-240](https://linear.app/moviecal/issue/MOV-240/allow-required-read-only-agentsmd-orientation-in-worker-audit) is unresolved. Its failed registry entry and unpushed
`docs/governance/mov-161-manual-polling-fixture.md` are retained evidence of
the false-positive guard finding. The follow-up must prove that read-only
orientation is allowed without permitting any protected-path write, then a
fresh disposable fixture (or the explicitly reclaimed clean MOV-239 worktree)
must complete the ordinary draft-PR path before this ledger can mark either
local execution or the manual/polling fallback as passed.

MOV-240 merged (#502) and the redrive fixture [MOV-242](https://linear.app/moviecal/issue/MOV-242) reproduced a clean claim/worktree/branch, then hit a **second, distinct** guard false positive: `find . -maxdepth 3 -newer AGENTS.md ...` (using the protected path only as a read-only `-newer` comparison argument) was classified as an edit. The guard fail-closed correctly — no push, no PR, `Needs Human Decision`, checksummed audit preserved at `/Users/adammoore/Library/Logs/moviecal-dispatcher/MOV-242-mov-161-fixture-local-execution-manual-p/security-audit.json` (sha256 `57a852407d827c75990a08263f1dd3868769d26971eb0e1b0e9cab2b3de14631`). [MOV-243](https://linear.app/moviecal/issue/MOV-243) is the held follow-up for this reference-argument pattern; it merged as [PR #506](https://github.com/PelvicSorcerer/moviecal/pull/506).

A second redrive, [MOV-244](https://linear.app/moviecal/issue/MOV-244), reproduced the same clean claim/worktree/branch on merged master (8fe1bda) and hit a **third** false positive with a different root cause: `grep -n -i "npm install\|node_modules\|npm ci" ... AGENTS.md` was misclassified as an edit. Unlike MOV-240/MOV-243 (missing command coverage), this traced to a parser bug in `canonicalize()` shared by the whole guard — its placeholder for an escaped shell operator (`\|` → `__literal_operator_|__`) embedded the operator's own character, so `shellSegments()` re-split on the placeholder text and fragmented the command, defeating the MOV-240 read-only carve-out. Verified fail-closed in the observed case; [MOV-245](https://linear.app/moviecal/issue/MOV-245) is the held follow-up, with regression coverage added for both directions (a hidden real write after an escaped operator still hard-denies). MOV-245 is [PR #509](https://github.com/PelvicSorcerer/moviecal/pull/509), pending CI at time of writing.

Both Loops remain manually disabled in Linear for the duration of this redrive sequence; they have not yet been restored.

## Completion rule

MOV-161 may be completed only when every ledger row is observed or has a
separate explicit blocking follow-up issue, the deterministic suites are green,
and a human has reviewed the final ledger and Needs Me surface. The resulting
evidence must demonstrate that a user can determine both current state and
required action from Linear, while GitHub remains authoritative for checks,
review, merge, and reconciliation.
