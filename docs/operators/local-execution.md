# Local Mac execution

Read `AGENTS.md` first. This document covers the local-Mac execution path: how a Linear work item becomes a running agent in an isolated git worktree on this machine, and what every worker (human or agent) needs to know about that environment. It replaces the former per-platform operator guides (`claude-code.md`, `codex.md`) and the cloud-orchestrator model (`codex-orchestration.md`, `multi-platform-dispatch-policy.md`), which are retained under `docs/operators/archive/` as historical reference.

> **This is the active execution adapter's operator guide.** `docs/governance/hybrid-execution-architecture.md` is the authoritative architecture: Linear owns desired lifecycle state, GitHub owns delivered state, and the Mac dispatcher is the only enabled implementation adapter. Linear Coding Sessions are isolated in **Deferred Linear cloud execution option** and remain `Icebox`; they are not a dependency or default for non-iOS work. iOS/Xcode work is permanently Mac-only.

See `docs/governance/linear-information-architecture.md` for the Linear workspace design this path is driven by, and `docs/operators/worker-routing.md` for how a worker binary and model are selected per issue.

## What changed from the cloud-agent model

The previous system assumed agents ran in degraded cloud containers: no `gh` CLI, GitHub GraphQL blocked by a network proxy, no Docker, no persistent local state. None of that applies here. This Mac has a full `gh` install, direct GitHub API access, a real filesystem, and a real process supervisor. Do not carry forward workarounds written for that constrained environment — they produce strictly worse behavior locally (e.g. avoiding `gh` in favor of a comment-command workflow when `gh` is simply available).

**Not to be confused with the deferred cloud option.** The "cloud-agent model" retired above is the old multi-platform GitHub-Project-era arrangement (Cursor Cloud, Copilot, cloud Codex). Linear Coding Sessions are a distinct, currently disabled option. The lesson that survives is narrow: never assume an execution environment's capabilities; prove them against an explicit contract before enabling them.

## Architecture

```
  Linear issue (Ready for Agent, delegated)
        │
        ▼
  moviecal-dispatcher  (local Node process, launchd-managed)
        │  preflight gates (below)
        ├─ git worktree add ~/code/worktrees/moviecal/<LINEAR-ID>-<slug>
        │     branch: agent/<LINEAR-ID>-<slug>, from origin/master
        ├─ symlink .env.local → ~/.config/moviecal/env.local
        ├─ select worker + model (docs/operators/worker-routing.md)
        ├─ generate a brief from the Linear issue + AGENTS.md
        ├─ spawn the worker headlessly, capture stdout/stderr to a run log
        │
        │  worker: implement → npm run verify → (browser lane if applicable)
        │          → commit → push → gh pr create --draft
        │
        ├─ progress reported to Linear as comments + state transitions
        └─ worktree slot released
        │
        ▼
  GitHub PR ("Fixes MOV-123")  →  CI (verify, browser-verify, supabase-verify)
        │
        ▼
  Dispatcher observes CI → updates Linear (In Review / check results)
        │
        ▼
  GitHub auto-merge on green required checks → Linear moves to Done automatically
```

Draft is a hard handoff boundary, not an intermediate state the dispatcher may
clear. An authorized human reviewer promotes it only after applying
`docs/planning/manual-versus-automated-testing-policy.md` and completing the
PR's structured `Readiness Evidence`. Low-risk work may be promoted without a
human test run only when the issue explicitly says `Human testing:
not-required`, all acceptance criteria have automated or reproducible
local-agent evidence, and no mandatory human gate applies. Missing evidence or
a missing marker keeps the PR draft.

The trusted publisher, not the worker, renders this section when it creates a
draft. It accepts `npm run verify` as passing local-agent evidence only from a
completed successful structured transcript event and saves a dispatcher-owned
evidence record next to that transcript. Any absent, failed, malformed, or
ambiguous command record is rendered incomplete and makes `Autonomy: disabled`.
**The match is on the exact literal command text.** A worker that pipes,
redirects, or wraps the command (`npm run verify 2>&1 | tail -300`, `npm run
verify || true`, and similar) to shorten its own output produces a transcript
event whose command no longer matches `npm run verify` exactly, so it is
credited as no durable evidence at all — even though verification genuinely
passed (MOV-274's autonomy-pilot blocker). The worker brief (`brief.mjs`)
tells every worker, implementation and repair alike, to run the command
verbatim and names this consequence; there is no leniency to add on the
evidence-capture side without weakening the fail-closed contract MOV-275
built.

Dispatcher code lives in `tools/dispatcher/` in this repository (TypeScript, using the repo's existing Node 24 + Vitest toolchain). Runtime config lives outside the repo at `~/.config/moviecal/` (mode 700) — API keys and `.env.local` must never be committed. Run logs live at `~/Library/Logs/moviecal-dispatcher/`, retained 90 days.

## Dispatch trigger

The dispatcher polls Linear for issues in workflow state `Ready for Agent`, then claims only the ones that satisfy **both** halves of the boundary below (MOV-143, `tools/dispatcher/src/dispatch-eligibility.mjs`). (A future phase may register a Linear Agent App for webhook-driven dispatch instead of polling; both share the same downstream pipeline.)

| Question | Single authority | Where it lives |
|---|---|---|
| **Which** adapter may execute this issue? | the materialized `execution:*` label on the Linear issue | Linear label group `execution:{cloud,mac,none}` (MOV-142) |
| **Who** may write to this issue's lifecycle locally? | the `moviecal-dispatcher` delegate | Linear's `delegate` field on the issue |

Inference (`inferExecutionRoute`) is **advisory only** and never satisfies the route half — a route that was merely inferrable but never applied is treated as no route at all. There is exactly one routing authority (the label) and exactly one local dispatcher writer (the `moviecal-dispatcher` delegate); an issue must name both to be dispatched here.

Anything else is one of two outcomes, and the difference matters:

- **Skipped, silently, with no Linear write at all** — `execution:cloud` (the cloud adapter's issue), `execution:none` (a coordination parent that must never produce a PR), or delegated to somebody else. The dispatcher is not that issue's writer, and a 30-second poll loop commenting on every pass would be both noise and a boundary violation. `dispatcher dry-run` is where you see these decisions.
- **Moved to `Needs Human Decision` with a comment** — the issue *is* delegated here (so this dispatcher is its writer) but carries no `execution:*` label, more than one, or one that contradicts the issue (`execution:cloud` on iOS/Xcode work, `execution:none` on executable work). No adapter can safely run it; a human fixes the route and moves it back to `Ready for Agent`.

**A workflow-state change is not a claim.** Moving an issue to `Agent Working` *reports* that work started; it does not reserve the issue, and nothing in the dispatcher may treat it as though it did. Linear's API offers no compare-and-set on workflow state, so two pollers could both "win" that transition and neither would learn it lost. Exclusivity comes from exactly one route and one delegate naming exactly one executor — and, within the Mac lane, from the worktree path already existing (§Preflight gates, gate 7).

Because routing and delegation are ordinary Linear fields a human can change at any moment — including while a queued issue waits for a concurrency slot — the dispatcher **re-reads the issue immediately before it commits** (`LinearClient.issueSnapshot`) and re-runs the same gate against that fresh snapshot. If the delegate was removed, the route changed, the issue left `Ready for Agent`, or it is no longer readable, the result is a safe no-op: no worktree, no state change, no comment. It simply reappears in a later poll if it becomes eligible again.

**Delegation is a prerequisite, not a formality.** An issue that is specced, promoted, and correctly labeled `execution:mac` still will not run until it is delegated to `moviecal-dispatcher` in Linear. `dispatcher doctor` prints the identity being matched, and `dispatcher dry-run` prints each queued issue's delegate and eligibility, so an empty run is diagnosable rather than mysterious. The identity is matched against the app's workspace name and, when set, `LINEAR_APP_ACTOR_ID` from `~/.config/moviecal/linear-app.env` (MOV-122); either identifier qualifies. Setting that variable to the actor's real UUID (it currently holds the app *name*) tightens the match.

**Bounded automatic handoff (MOV-220).** The enabled **Moviecal local
handoff** Linear Loop watches only `Moviecal` issues entering `Ready for
Agent`. It rechecks the full local boundary and, for a complete unblocked
non-human-only, non-coordination issue carrying exactly `execution:mac`, may
set only `delegate = moviecal-dispatcher`. It cannot start a Coding Session or
worker, cannot choose `execution:cloud`, and cannot make other issue changes.
An already-matching delegate is a no-op. Disable that Loop to return to manual
delegation; the polling dispatcher and every gate in this section are
unchanged. Configuration and live stop/replay/offline evidence are recorded in
`docs/governance/mov-220-loop-to-mac-handoff-validation.md`.

Linear itself refuses this Loop's delegation on an unowned issue: "moviecal-dispatcher works on behalf of a person. Assign a workspace member to the issue first, then delegate." Before MOV-359, nothing in the local flow ever set an assignee, so a fully specced issue promoted without one reached this rejection and the Loop moved it to `Needs Human Decision`. §Automated promotion's configured-human-owner step (below) is what closes that gap: the promoter fills a missing assignee immediately before the `Ready for Agent` transition this Loop reacts to, so the delegation it attempts here always finds an owner already in place.

## Automated promotion

`Ready for Agent` is filled automatically, not by hand (MOV-129), and the dispatcher now runs **priority propagation before promotion** (MOV-366). Poll-cycle order is:

1. `reconcileWorktrees`
2. `reconcileParents` (`dispatcher reconcile-parents [--dry-run]`) — derives parent completion from real Linear sub-issue state (MOV-172)
3. `propagatePriorities` (`dispatcher priorities [--dry-run] [--once]`)
4. `promotePass` (`dispatcher promote [--dry-run]`)
5. `auditIssuesPass` (`dispatcher audit-issues [--dry-run]`) — comment-only issue-completeness audit, gated to `MOVIECAL_ISSUE_SPEC_AUDIT_INTERVAL_MS` (24 hours by default); the standalone command always runs immediately
6. dispatch scan over `Ready for Agent`, each issue passing through preflight

**Parent completion (MOV-172).** Never infer an issue is complete because a merged PR mentions its ID. A split must create one real Linear sub-issue per PR before those PRs open, and each PR's `Linear: MOV-NNN` reference must be sourced from that real issue object—not copied from PR text, a GitHub number, or a pattern. The reconciliation pass completes an active parent only when every child is terminal and at least one is `Done`/`Released`; `Canceled`/`Duplicate` children do not block but cannot independently drive completion. A completed parent with an open child is moved to `Needs Human Decision` with the child named. `assertParentCompletable()` also blocks the dispatcher's merged-PR backstop from directly completing such a parent.

Priority propagation is dependency-aware and transitive on `blocks` edges (`A blocks B blocks C` raises both `A` and `B` from `C`). Priority comparisons use `rank(priority)` where `0 -> Infinity` so ordering is `1 (Urgent) < 2 < 3 < 4 < 0 (No priority)`. Effective priority for an issue is the most important value across itself plus every incomplete downstream dependent it blocks.

- Graph traversal includes all non-terminal issues, including `Icebox` and `Triage`, so transitive chains are computed correctly.
- Terminal workflow-state types (`completed`, `canceled`, `duplicate`; e.g. `Done`, `Released`, `Canceled`, `Duplicate`) never contribute to upstream raises and are never written.
- Writable targets are only: `Backlog`, `Blocked`, `Spec Ready`, `Ready for Agent`, `Agent Working`, `In Review`, `Needs Input`, `Needs Human Decision`.
- `Icebox`/`Triage` are never auto-written. If one would be raised, the dispatcher logs: `MOV-X (<state>) blocks <priorityLabel> MOV-Y — not auto-raising, review`.
- Cycles are handled safely as a single mutually-reachable set; the pass logs the cycle once and continues.
- Ownership of propagated values is tracked in `~/.config/moviecal/priority-propagation.json` (`{ "<issueId>": { "lastPropagated": <value>, "manualFloor": <value> } }`; legacy numeric entries are still read). This enables idempotent no-op re-runs, preserves the manual floor for later relaxations, and allows relaxing only when propagation still owns the value (`current === lastPropagated`).

After propagation, `dispatcher run` executes the promoter over every issue in `Backlog` and `Blocked`. An issue is moved to `Ready for Agent` when **all** of:

- it is **not** labeled `human-only`;
- its description has a non-empty **acceptance-criteria** section (heading matching `/^#+\s*acceptance criteria/i`);
- its description has a non-empty **Testing Expectations** section (`/^#+\s*testing expectations/i`);
- every issue that `blocks` it is in a completed/canceled state (`Done`, `Released`, `Canceled`, `Duplicate`), resolved via the same `inverseRelations` data the dependency gate uses;
- **in `enforce` mode only** (MOV-303/MOV-307), it satisfies the issue-completeness contract — labels, project, and milestone. In `report` mode, the shipped default, this clause does not apply and promotion behaves exactly as it did before;
- it already carries an assignee, **or** the configured human owner can be resolved and written to it (MOV-359, below) — an issue that fails every other clause is never even checked for this one.

For a `Blocked` issue there is one extra condition: its most recent `**Dispatcher preflight failed:**` comment must name an unresolved-relation reason (now resolved). An issue blocked for any other reason — a missing secret, a worktree collision, a human's decision — is left alone.

On promotion the promoter first fills a missing assignee (below), then comments `Auto-promoted to Ready for Agent — …` (which, via the app-actor identity from MOV-122, notifies the repo owner). It is idempotent: a promoted issue is no longer in `Backlog`/`Blocked`, so a second pass does nothing, and an issue that already has an assignee is never reassigned or recommented.

### Configured human owner before handoff (MOV-359)

The handoff Loop (§Dispatch trigger, MOV-220) cannot delegate an issue Linear considers unowned. Rather than require a human or authoring agent to set an assignee by hand on every issue, the promoter fills exactly one gap: an otherwise-promotable issue (every clause above except this one) that has **no assignee at all** is assigned the single operator-configured human owner, immediately before the `Ready for Agent` write — never after, since a state transition with no assignee behind it would still race the Loop's own rejection.

- **Configuration.** `MOVIECAL_DEFAULT_OWNER_EMAIL`, resolved by `resolveDefaultOwnerEmail()`. Unset by default — the initial operator value is Adam Moore's workspace email, set only in this Mac's own environment, never committed to the repo. Unset or blank reads as "no owner configured", not as a hardcoded fallback person.
- **Validation.** The configured email must resolve to a workspace member who is active, human (not an app/bot actor), and has access to the `Moviecal` team. Any of those failing — including the lookup itself failing — is treated identically to a missing assignee write: the issue is held out of `Ready for Agent`.
- **Preserving an existing owner.** An issue that already has any assignee is never touched — no lookup, no write, no re-check on a later pass. This is the one narrowly-scoped exception to the "nothing is ever auto-filled" rule in `docs/governance/linear-information-architecture.md` §Issue completeness contract; every other field that rule covers (labels, project, milestone, state) is still never guessed at by the dispatcher.
- **Write + readback.** The assignment mutation and its readback happen together (`LinearClient.assignIssue`) — a bare `success: true` is not trusted; the returned assignee id must match the one requested before the promoter proceeds to the `Ready for Agent` transition.
- **Failure is retryable, not noisy.** A missing/invalid owner or a failed assignment withholds promotion with a specific, per-pass console reason (`owner assignment: …`) — it never posts a Linear comment, so a persistent misconfiguration does not spam the issue every 30-second poll. Because a fresh assigner is built at the start of every promote pass, a transient failure (an expired credential, a momentary Linear API error) is retried automatically on the next cycle with no special-cased recovery.
- **Dry-run.** `dispatcher promote --dry-run` reports the planned assignee (and the promotion that would follow) without writing either.
- **Never inferred.** The owner is always the one configured email — never the issue's creator, never an app/bot workspace user, and never applied to an issue the promoter would not otherwise promote (unready, `human-only`, coordination, or still blocked).

See `tools/dispatcher/src/owner-assignment.mjs` for the pure eligibility/validation logic and `promoter.mjs`'s `promoteEligible` for how it is sequenced against the `Ready for Agent` write.

### Issue completeness (MOV-303/MOV-307/MOV-308)

The contract itself — the per-kind label schema, the project rule, the milestone opt-out marker, and the fact that relations are required but not machine-checked — lives in `docs/governance/linear-information-architecture.md` §Issue completeness contract. `tools/dispatcher/src/issue-spec.mjs` is its only machine-checkable expression. Its consumers are the promoter, dispatch preflight, and the audit pass.

**Mode.** `MOVIECAL_ISSUE_SPEC_MODE` = `off` | `report` | `enforce`, resolved by `resolveIssueSpecMode()` and printed by `dispatcher doctor`. It defaults to **`report`**, and an unrecognized value reads as `report` rather than `enforce` — a typo must never silently stall the queue. Raising it to `enforce` is the owner's step, taken only once the existing backlog has been backfilled; merging the contract itself therefore changes no live promotion or dispatch behavior.

| Mode | Promoter | Preflight | Audit pass |
|---|---|---|---|
| `off` | contract ignored | contract ignored | does not run — nothing read or written |
| `report` (default) | promotes as before; violations are logged | dispatches as before; violations are logged | comments on each non-compliant issue |
| `enforce` | an incomplete issue is not promoted | an incomplete issue fails to `Blocked` with every missing item named | comments on each non-compliant issue |

Preflight runs before every dispatch, no matter how the issue entered `Ready for Agent`. Its batch fetch requests the project and milestone fields the completeness validator needs.

**The audit pass (MOV-308).** The promoter only ever looks at `Backlog` and `Blocked`. The audit covers everything else that is open — `human-only`, coordination, `Spec Ready`, `Icebox`, and every started state — which is most of the workspace. The in-loop pass runs at most once per configured interval; `dispatcher audit-issues [--dry-run]` / `npm run dispatcher:audit-issues` always runs immediately.

- **Which issues.** The caller resolves the state list from workflow-state *type* (`backlog`, `unstarted`, `started`), never from a hardcoded name list, so a state added to this workspace later is audited automatically while `triage`, `completed`, and `canceled` stay out by construction.
- **What it writes.** Exactly one comment per non-compliant issue, headed `**Issue completeness contract — this issue is missing required fields (MOV-303).**`, naming which kind's rules were applied and every missing item. `addComment` is its **only** write: it never calls `moveToState` or `updateIssuePriority`, and never touches a label, project, or milestone. That is asserted structurally in `dispatcher-wiring.test.mjs`, not just by review — and it matches the contract's own "nothing is ever auto-filled" rule, since a dispatcher-written guess at a label or project would be indistinguishable from a real one the moment it landed.
- **Don't repeat yourself.** Each comment carries a hidden fingerprint marker (`<!-- moviecal-issue-spec-audit:<codes> -->`) naming the *set* of missing items by code rather than by message wording. A later pass over an unchanged set writes nothing at all; a changed set gets exactly one new comment; and an issue that becomes compliant goes quiet — there is deliberately no "resolved" comment, because silence is the normal state of a healthy workspace. The marker is read from the issue's most recent audit comment, so the promoter's own comments landing on the same issue in between change nothing.
- **Read-only guarantees.** `dispatcher audit-issues --dry-run` evaluates and reports but writes nothing, and `MOVIECAL_ISSUE_SPEC_MODE=off` returns before a Linear client is even built — that mode reads nothing either.
- **Locking.** A mutating standalone `dispatcher audit-issues` takes the dispatcher's singleton lock (exit 2 if the daemon already holds it), exactly as `priorities` and `reconcile-parents` do. `--dry-run` never contends for it, so previewing the audit against a running daemon is always safe.
- **Cadence.** A successful audit persists its completion time in `~/.config/moviecal/issue-spec-audit-state.json`. Missing or corrupt schedule state triggers one audit; a failed pass is retried next cycle. A manual, non-dry-run audit resets the same clock.

**Pending:** `AGENTS.md`'s "Planning-object changes" bullet still needs a one-line pointer to the contract for anyone filing an issue. `AGENTS.md` is a worker-protected path (§Security model), so a dispatched worker cannot write it — that line is an owner edit.

**Execution routing.** `execution:{cloud,mac,none}` is a mutually-exclusive
Linear label group, provisioned idempotently by
`tools/dispatcher/scripts/provision-linear-workspace.mjs` (MOV-142).
`tools/dispatcher/src/execution-routing.mjs` provides the pure inference and
validation logic (`inferExecutionRoute`, `resolveExecutionRoute`,
`isCoordinationIssue`). It affects two things:

- **the promoter** — an issue that infers `execution:none` (i.e. carries
  `type:coordination`) never auto-promotes, because a coordination parent must
  not produce its own PR. This one is inference-based and needs no label.
- **dispatch** — the route must be *materialized* as a label, and must be
  `execution:mac`, before the local dispatcher will claim the issue (MOV-143).
  See §Dispatch trigger for the full gate, including the delegation half.

Note the asymmetry: promotion tolerates an unlabeled issue, dispatch does not.
An issue can therefore be promoted into `Ready for Agent` and then sit there
until a route is applied — visible in `dispatcher dry-run`, and escalated to
`Needs Human Decision` on the next dispatch pass if it is already delegated to
`moviecal-dispatcher`.

`blocks` relations plus the preflight gates below do all **sequencing**; the promoter only judges **readiness**. There is no per-issue human promotion step. To hold a specced issue out of the automated flow, move it to `Spec Ready` — the promoter never touches that state.

## Preflight gates

These run **after** the §Dispatch trigger gate has established that the issue is this adapter's to claim at all — "is this issue ours?" is a separate question from "is our issue ready?", and conflating them produces `Blocked` comments on issues that belong to another lane. Before starting work on an issue, all of the following must pass, or the issue moves to `Blocked` with a comment naming the failed gate:

1. No unresolved `blocked by` relations.
2. Not labeled `human-only`.
3. In `enforce` mode, it satisfies the issue-completeness contract; in `report`/`off`, violations remain visible but do not block dispatch.
4. Not labeled `needs-secrets` unless the named local secret is actually present.
5. If the issue is in the **iOS Companion App** project: the self-hosted macOS runner (`moviecal-ios-runner`, labels `self-hosted, macOS, ios`) is online.
6. A concurrency slot is free (default: **1** simultaneous worktree). The Mac
   dispatcher is intentionally single-flight until a real nonblocking job
   supervisor can account for child process groups and resource limits.
7. `origin/master` is fetched.
8. The target worktree path is unused. This is also what makes overlapping poll cycles safe: a second cycle that sees the same issue collides here and reports `Blocked` rather than spawning a second worker. It is a real filesystem mutex — unlike the `Agent Working` state change, which is only a report (§Dispatch trigger). One exception (MOV-181): if the occupying entry is *this same issue's own* retained worktree from a prior attempt that already reached a terminal status (`failed`/`abandoned`/`merged`), it is reclaimed instead of blocking, provided it is clean (MOV-185: uncommitted/untracked changes or commits not yet on the remote-tracking branch keep it blocked instead, with a reason naming the dirty path) — see the retention-policy paragraph below for why. Any other occupant (a different issue's worktree, an active/in-review entry, or an untracked path) still fails closed exactly as before. This exception applies only to the live `dispatcher run` path — `dispatcher run --dry-run` deliberately keeps the plain check, since reclaiming is a real `git worktree remove` and the dry-run preview promises to change nothing.

## Worktree lifecycle

- **Path:** `~/code/worktrees/moviecal/<LINEAR-ID>-<slug>`
- **Branch:** `agent/<LINEAR-ID>-<slug>`, branched from `origin/master`
- The Linear issue identifier appears in both the path and the branch name, so ownership is always unambiguous from either side.
- Ownership is recorded in `~/.config/moviecal/worktrees.json`: identifier, branch, dispatcher/worker PIDs, worker, model, start time, Linear issue URL, and dispatcher/repository provenance. Writes use a fsync + rename transaction and retain a `.bak`; a malformed primary state file is recovered from that backup or the dispatcher refuses to mutate anything. Repair admission requires that provenance to match the live PR's same-repository head branch and SHA; legacy, fork, stale, and unknown branches fail closed.
- The mutating `dispatcher run` command takes `~/.config/moviecal/dispatcher.lock` using exclusive file creation. A second live instance exits without touching Linear, worktrees, branches, or registry state. A stale lock is reclaimed only when its recorded PID no longer exists.
- `.env.local` is a **symlink** to `~/.config/moviecal/env.local`, never a copy — one file to rotate, and no credential material ever lands inside a git-tracked tree.
- **Cleanup:** on merge, the worktree is removed and the remote branch deleted. On failure, the worktree is retained for 7 days for inspection, then pruned. `dispatcher gc` (also runnable manually) prunes stale entries and orphaned worktrees. **Requeue exception (MOV-181):** the 7-day retention window exists for human inspection, but moving the same issue back to `Ready for Agent` before that window elapses is itself the signal that inspection is done — so a preflight collision against that same issue's own terminal-status worktree reclaims it (§Preflight gates, gate 7) rather than blocking the retry. Only the local git worktree and its local `agent/*` branch are removed; the remote branch is left alone (a draft PR may still reference it), and `~/Library/Logs/moviecal-dispatcher/<id>/` — the actual forensic record (`stdout.log`, `stderr.log`, `security-audit.json`, `manifest.json`) — is untouched, since `git worktree remove` only ever touches the worktree's own files. **Dirty-worktree guard (MOV-185):** the MOV-181 reclaim above shipped without checking whether the retained worktree actually held unrecovered work — a real gap, surfaced by a 2026-09-14 near-miss where a worker (MOV-172) hit a rate limit mid-task and landed in `failed` with 44 turns of genuine, still-uncommitted implementation work sitting in the worktree; only a human manually noticing and committing/pushing it averted a silent `--force` removal on the next requeue. `WorktreeManager.isPathFreeForIssue()` now runs the same clean-check MOV-173 specifies for the sibling abandoned-worktree case before reclaiming: `git status --porcelain` (uncommitted/untracked changes) and a local-vs-remote-tracking-branch commit comparison (unpushed commits), no `git fetch` involved. A dirty terminal-status worktree is left untouched and the preflight collision still blocks, but with a specific reason (`reclaimBlockedReason()`) naming the worktree path and the kind of unsaved work found, instead of the generic "worktree path already in use" message every other collision case gets. A clean terminal-status worktree — the common case, since most failures happen before any file changes — is still reclaimed exactly as MOV-181 describes above.
- **Reconciliation (`pr-reconcile.mjs`):** once a worker's PR is found, the worktree entry records `prNumber`/`prUrl`/the issue's Linear id alongside its `"review"` status. Every `dispatcher run` poll cycle (via `cmdRunOnce`, before processing new issues) sweeps every worktree in `"review"` and checks its PR's real state (`gh pr view <n> --json state,mergedAt`): merged → marked `"merged"` (so the next `gc` cleans it up); closed without merging → marked `"abandoned"` (7-day retention path, same as a worker failure). Before this existed, a merged PR's worktree just sat there indefinitely — nothing watched it after `"review"` — and had to be cleaned up by hand (found during `MOV-117` cleanup, fixed by `MOV-118`).
- **Linear outcome backstop (MOV-152).** Linear's own state generally transitions separately via the GitHub magic-word sync (a real closing keyword, e.g. `Fixes MOV-123`, in the PR body) once merged — but that sync is external and can fail, lag, or (for a closed-unmerged PR) simply never run at all, since GitHub has no magic word for "closed without merging". `reconcileReviewWorktrees` backstops both cases when it has a live Linear credential: on a MERGED PR it re-reads the issue's current state and idempotently moves it to `Done` only if the magic-word sync hasn't already done so (no duplicate writes or comments if it's already terminal); on a CLOSED-unmerged PR it always leaves an evidence comment (PR link, branch, why it wasn't merged) and, unless the issue is already in a terminal state, moves it to `Needs Human Decision` — a closed-unmerged PR is inherently ambiguous (abandoned vs. superseded vs. intentionally rejected), so this never guesses an outcome, only escalates. A worktree entry that transitions to `"merged"`/`"abandoned"` without yet confirming the Linear side (`linearSynced` unset) is retried on every subsequent poll cycle regardless of its worktree status, so a transient Linear API failure delays the backstop rather than losing it; a failure on one entry is isolated and does not block reconciling the rest of that pass's entries. Without a live Linear credential (e.g. `dispatcher run` invoked before `doctor` would pass), only the worktree-bookkeeping half above runs — the Linear backstop simply picks up on a later cycle that has one.
- **Ready-state recovery (MOV-275).** GitHub synchronization may transiently regress a dispatcher-created issue from `In Review` to `Agent Working` after the sole allowed draft-to-ready action. The review sweep restores `In Review` only when its retained registry proves the exact dispatcher-owned issue, same-repository open PR, branch, and SHA that the ready action recorded. It touches only `Agent Working`, writes one recovery marker/comment, and is thereafter a no-op; unrelated review entries and workflow states are never normalized.
- Every dispatcher-created implementation PR is required (via `brief.mjs` and `.github/pull_request_template.md`) to carry a real Linear closing keyword (`Fixes MOV-NNN`, not a bare `MOV-NNN`) — a bare identifier reference never triggered Linear's GitHub-integration sync in the first place, which is the gap the backstop above exists to cover for the cases where even a correct magic word doesn't sync in time.
- **One completion issue per PR chain.** A merged PR linked to a Linear issue can move that issue to `Done` even when it is only an intermediate member of a GitHub PR stack (observed on MOV-145/#357 on 2026-09-10). Do not split one implementation issue across multiple PRs that all identify or attach to that issue. If a change must be delivered as a stack, create one Linear sub-issue per mergeable PR and reserve the parent/final completion issue for the last PR; dependency relations carry the merge order. Source each PR's `Linear: MOV-NNN` reference from the real sub-issue object, never PR text or a GitHub number. The parent must never be completed directly while a child is non-terminal; the MOV-172 reconciliation pass enforces and backstops this.
- **Crash recovery (MOV-173, MOV-254):** startup reconciles every nonterminal registry entry. A missing worktree or an active entry whose recorded worker PID is gone is marked `abandoned`, then reconciled with Linear in the same pass: a clean worktree gets one explanatory comment and is returned to `Ready for Agent`; a worktree with uncommitted changes or commits missing from its remote-tracking branch is preserved, named in the comment, and moved to `Needs Human Decision`. Worker PIDs are durably recorded before their briefs are written and lead detached process groups; if a restarted dispatcher finds one still live, it kills the entire orphaned group before inspecting or reusing the worktree. The tiny spawn-to-record handoff is also durable: if a crash happens within it, recovery preserves the worktree for human review rather than assuming no orphan exists. Progress for the state transition and comment is persisted per abandonment, so an interrupted Linear call retries only the unfinished effect and a completed recovery is not duplicated. Review transitions are conditional on the entry still being in `review`, so a reconciliation pass cannot overwrite a newly active worker record.
- **Orphan-worktree sweep and ownership marker (MOV-199).** The same reconciliation above also lists every real Git worktree under `worktreeRoot()` and removes any with no matching `worktrees.json` entry — meant to recover a worktree the dispatcher created but lost track of (e.g. a crash between `git worktree add` and the registry write). This runs on **every** `dispatcher run` poll cycle (`WorktreeManager.reconcileStartup()`, called from `reconcileWorktrees()`), not only at daemon startup despite the name, and confirmed live (repeated `dispatcher.stdout.log` occurrences) force-deleting worktrees an interactive/human-delegated session had created directly under the same shared root with `git worktree add` — this repo's own `agent/<LINEAR-ID>-<slug>` branch convention applies equally to human delegation (`AGENTS.md` §"Direct assignment"), so a foreign worktree is indistinguishable from a lost dispatcher one by path or branch alone. Two independent guards now apply before anything is removed: (1) **ownership** — `create()` stamps a marker file into the worktree's own private Git directory (`<gitdir>/moviecal-dispatcher-owned.json`, never the tracked working tree), and the sweep now checks for that marker rather than inferring ownership from naming; a worktree without it is never a candidate, full stop, regardless of how it looks. (2) **dirty-worktree guard** — even a provably dispatcher-owned orphan is left in place, not force-removed, if it has uncommitted changes or commits missing from its remote-tracking branch (the same `uncommittedChanges()`/`hasUnpushedCommits()` checks MOV-185 added to the same-issue reclaim path), with the reason logged. A consequence worth knowing: a dispatcher-created worktree from **before** this fix shipped has no marker and so is no longer auto-reclaimed as an orphan even if genuinely the dispatcher's own — a one-time, deliberate cost of failing closed; clean it up by hand (`git worktree remove`) if one is found stale. Separately, the log line for every sweep outcome previously read `c.id`/`c.reason` unconditionally, but an orphan-sweep change record has no `id` field — every occurrence logged as `undefined: startup recovery marked orphaned worktree removed — undefined`, so historical occurrences carry no record of which path or branch was destroyed.
- **Provider-usage-limit resume of a retained dirty worktree (MOV-205).** MOV-151/192 gave a sole, reset-bearing provider usage limit one bounded deferred retry — but *only* when the worktree was clean, because requeueing an issue whose worktree held unpublished work would have collided with (or, pre-MOV-185, reclaimed) that work. A worker that produced real edits and then hit the limit therefore went straight to `Needs Human Decision` (MOV-190 hit exactly this). Preserving the work was right; needing a human to resume it was not, since a usage limit says nothing about the issue. The dispatcher now schedules **one** deferred resume that runs *in place*: the retained worktree and branch are the dispatch target, and nothing is reclaimed, removed, recreated, or fetched. The durable record is split across two files that must agree — a `resume` plan (worktree path, branch, repository, unpublished paths) in `~/.config/moviecal/usage-limits.json`, and a matching `usageLimitResumeAt` stamp on the `failed` entry in `worktrees.json` — so a plan that survived a registry rewrite it did not cause is refused. Before the reset, the ordinary deferral gate holds dispatch back silently (and survives a dispatcher restart); after it, `admitUsageLimitResume()` (`usage-limit-resume.mjs`) re-proves **every** property from live facts rather than from the stored plan: dispatcher ownership via the MOV-199 marker, worktree integrity and checked-out branch, branch/repository identity and the `agent/<LINEAR-ID>-` namespace, registry provenance and `failed` status, the two records agreeing, and that the unpublished work is *still there*. Anything unproven is a refusal. The resumed worker is spawned through the same `worker-guard.mjs` boundary, transcript audit, and trusted publication path as any other implementation worker — there is deliberately no second, weaker copy of that boundary for this path. The attempt is bounded exactly as the clean-worktree one is: the plan is spent the moment the resume *starts* (not when it succeeds), so a crash in between cannot re-fire it, while the consecutive counter is kept — so **whether the first attempt used a clean-worktree retry or a retained-worktree resume**, a second consecutive provider limit, a missing/unparseable or >24h reset, a failed re-admission, or any non-limit failure moves the issue to `Needs Human Decision` with a specific reason, **still without touching the retained worktree**. Three distinct Linear evidence surfaces exist for the three outcomes (deferral, resumption, escalation), and the resumed worker's brief tells it explicitly that the dirty tree is a preserved partial implementation to continue rather than debris to revert. `dispatcher dry-run` prints each issue's `usage limit:` state (deferred / resume due / recorded count) so a resume-pending issue is not mistaken for an ordinary worktree collision. **Clean-worktree deferral behaviour is unchanged**: it records no resume plan and still reclaims and rebuilds its worktree on the retry.
- **Interactive/human-delegated worktrees should stay outside `worktreeRoot()`** (`~/code/worktrees/moviecal/`) specifically because of the sweep above — even with the MOV-199 ownership guard, a worktree the dispatcher cannot prove it owns simply sits invisible to reconciliation rather than being tracked as healthy. `~/code/worktrees/moviecal-interactive/` (a sibling directory, not a descendant of `worktreeRoot()`) is this repo's established convention for that and is structurally exempt from the sweep regardless of the ownership marker.
- **Invalid/expired dispatcher credential circuit breaker (MOV-177).** Unlike the provider usage limit above (a *quota* refusal the provider always resolves at a known reset time), an invalid or expired worker credential (`CLAUDE_CODE_OAUTH_TOKEN` today) is a *dispatcher-wide* outage with no reset clock — every worker on this Mac fails identically until a human re-authenticates. Before this existed, each dispatched issue hit it independently and was reported as an unrelated generic `**Worker exited with code 1.**` failure with a wall of raw JSON, and nothing stopped the dispatcher from claiming issue after issue against the same dead credential (observed across MOV-172, MOV-173, and MOV-175's incidents). `credential-failure.mjs`'s `classifyCredentialFailure()` recognizes a worker's exit as this class from its logged transcript — an `api_error_status: 401`, a structured `"error": "authentication_failed"`, the literal `OAuth access token has expired` message, or an `invalid API key` signature (the equivalent shape for a future API-key credential, MOV-176) — keyed off the error signature itself, never off "this issue failed more than once", so it cannot misfire on an unrelated repeated failure. On a match, `run-loop.mjs` posts a distinct, unmistakable comment (`**Dispatcher credential is invalid or expired.** Automatic dispatch is paused until this is fixed.`) instead of the generic failure wording, requeues the surfaced issue to `Ready for Agent` (it did nothing wrong — the credential did) rather than `Needs Human Decision`, and trips a named breaker in the same shared, persisted `CircuitBreakerStore` the MOV-180 nested-sandbox-crash breaker already uses (`circuit-breaker.mjs`, keyed by name specifically so unrelated breakers never contend) — surviving a dispatcher restart exactly as that one does. While either breaker is open, `runOnce` lets exactly one subsequent issue through per poll cycle as a half-open probe and skips every other issue outright — including one that turns up mid-cycle after an earlier issue in the very same batch trips the breaker, not only across later cycles, since preflight's own concurrency gate would otherwise free up and let the dispatcher burn through the rest of the `Ready for Agent` queue one issue at a time on the same dead credential. **Closing the breaker is deliberately proactive-check-free**: it mirrors MOV-180's own mechanism exactly — the next dispatch attempt succeeding (a worker completes with a clean exit) is treated as proof the credential is healthy again and clears the breaker automatically, with no `dispatcher doctor` polling and no manual intervention beyond fixing the credential itself. Only *dispatch* (spawning a worker) is paused; `reconcileWorktrees`, parent-completion reconciliation, priority propagation, and the promote pass are separate calls in `cmdRunOnce` that never consult this breaker and keep running normally.

### Resource contention policy

The Mac adapter has one dispatcher slot by default. Heavy Xcode builds/tests,
the iOS Simulator, and the self-hosted `moviecal-ios-runner` are treated as a
single scarce resource pool: do not run them concurrently with another local
worker, and do not raise `MOVIECAL_CONCURRENCY` to bypass that policy. The
runner's online status is a preflight gate, but it is not a second execution
slot. See [iOS manual testing](./ios-manual-testing.md) before an interactive
build or simulator session. If a future supervisor can queue and cancel
process groups without
leaving `xcodebuild`, `simctl`, or npm descendants behind, this section and
`DEFAULT_CONCURRENCY` may be revised together with tests proving the new
semantics.
- Agents must not commit directly to `master`, and never operate outside their assigned worktree.

### Dispatcher-held simulator lease for iOS Companion App issues (MOV-311)

Interactive Claude Code sessions use the shared `scripts/ios-sim-guard.mjs`
`PreToolUse` policy through `.claude/settings.json` (MOV-312). Codex has the
same policy in `.codex/hooks.json`, but CLI 0.153.4 does not discover project
hooks in linked Git worktrees, even after the worktree is trusted
([upstream issue](https://github.com/openai/codex/issues/27133)). Codex
worktree sessions must follow the acquire-first procedure in
[iOS manual testing](./ios-manual-testing.md) and MOV-309's unmanaged-state
detection; do not assume the hook is active unless `/hooks` shows it. When
loaded, the hook requires a trust review in `/hooks`. These hooks cover
supported Bash and simulator MCP calls; `worker-guard.mjs` remains the worker
enforcement boundary.

For an issue in the **iOS Companion App** project, the dispatcher acquires a
`worker`-lane lease (`scripts/ios-sim-lease.mjs`, MOV-309) for the whole worker
run, before the worktree exists, and releases it exactly once on every outcome
(success, failure, timeout, stop, or crash recovered by startup recovery).
Acquisition never waits: if another lane holds it or simulator state is
unmanaged, the issue is **deferred silently** (`deferred-ios-sim-lease`, no
`Blocked` comment, no worktree) and retried next poll. Non-iOS issues never
touch the lease.

The worker receives the lease id as `MOVIECAL_IOS_SIM_LEASE_ID` and must use
only the `moviecal-worker` device; `npm run ios:sim:run` renews it rather than
queueing behind its own dispatcher. The id is recorded on the worktree registry
entry (`iosSimLeaseId`) so startup recovery releases it explicitly.

## Worker interface

A worker is any binary satisfying: *given a repo path, a branch, and a brief on stdin, produce verified filesystem changes in that worktree and exit 0.* Concretely, `claude -p --model <id>` or `codex --sandbox workspace-write --ask-for-approval never exec`. For a linked Git worktree, the dispatcher adds its shared Git metadata directories to Codex with `--add-dir` so Codex can resolve the worktree's `.git` file (MOV-193). The shared outer `worker-guard.mjs` profile keeps those directories non-writable for both adapters; `--add-dir` does not grant an effective write capability. It also denies every non-`.git` top-level entry of the checkout containing that shared metadata rather than denying the checkout root, because macOS Seatbelt deny rules cannot make an exception for nested `.git` paths (MOV-194). Both adapters therefore remain unable to read sibling source and local files while the backing metadata remains available only as necessary. A worker cannot execute Git, push, open/edit a PR, or receive GitHub mutation authority. The dispatcher instead injects a bounded, read-only repository snapshot (branch/HEAD/base, initial status, recent commits, and changed paths) into each brief, so a worker has routine orientation context without invoking Git itself. After it exits, the dispatcher audits the structured tool transcript, assigned branch, base diff, and dirty paths; only a clean audit reaches `worker-publish.mjs`, which stages and commits the accepted changes, performs a non-force push of exactly the assigned branch, and finds or creates its draft PR. Adding a third worker means satisfying this same boundary, not writing a new operator guide or merge path.

A worker invocation is one-shot — there is no resume across turns, so the brief (`brief.mjs`) explicitly tells the worker to run verification (`npm run verify`, `xcodebuild`, etc.) synchronously and never background a long-running build/test and exit expecting to check on it later (`MOV-137`, after `MOV-106`'s first dispatch did exactly that and left an orphaned `xcodebuild test` running after the worker exited 0). As a backstop, `worker-spawn.mjs` spawns the worker detached (its own process group) and, once it exits, signals the whole group (`SIGTERM` then `SIGKILL` after a grace period) so nothing it spawned outlives it. A zero exit with no audited filesystem change is a failed publication, not success.

## Branch and CI conventions

Branch prefixes are the machine-readable registry in `docs/operators/branch-prefixes.json`, enforced against CI workflow `branches:` filters by `npm run check:branch-ci`. Current prefixes:

- `agent/**` — all agent-authored implementation work (any worker binary)
- `docs/**` — documentation/governance-only changes
- `chore/**` — maintenance changes not tied to a specific Linear issue

Run `npm run check:branch-ci` after any change to `branch-prefixes.json` or a workflow's `branches:` filter — it is also enforced in `verify.yml`.

## Reporting back to Linear

At each transition the dispatcher writes to the Linear issue:

| Transition | Linear update |
|---|---|
| Delegated, dispatcher picks it up | State → `Agent Working`; comment with worktree path, branch, worker, model |
| Worker has a question it cannot resolve | State → `Needs Input`; comment with the question |
| Verification runs | Comment with lane results (`npm run verify`, browser lane if applicable) |
| PR opened | State → `In Review`; comment with PR link |
| CI completes | Comment with check conclusions |
| PR merges | State → `Done` (automatic, via the GitHub magic word, e.g. `Fixes MOV-123`) |
| Worker fails or hits a hard-deny action | State → `Blocked` or `Needs Human Decision`; comment with the last ~50 log lines and the run-log path, preceded by an advisory diagnosis when one could be generated (MOV-179, see §Security model) |
| Worker hits the nested-sandbox-crash signature (MOV-180/MOV-299, see §Security model) | State → `Ready for Agent` (requeued, **not** `Needs Human Decision`); comment names the exact `sandbox_apply: Operation not permitted` evidence, that it is environment-wide rather than issue-specific, and that dispatch is paused until the breaker clears |
| Worker hits a 401/`authentication_failed` credential-failure signature (MOV-177, see §Worktree lifecycle) | State → `Ready for Agent` (requeued, **not** `Needs Human Decision`); comment: `**Dispatcher credential is invalid or expired.** Automatic dispatch is paused until this is fixed.` Dispatch of every issue is paused until a subsequent dispatch attempt succeeds and closes the breaker |
| Sole provider usage limit, clean worktree (MOV-151/192) | State → `Ready for Agent`; comment naming the parsed reset and that exactly one retry is scheduled. Dispatch of that issue is held until the reset |
| Provider usage limit after unpublished work (MOV-205) | State → `Ready for Agent`; comment naming the retained worktree, the unpublished paths, and that it will be **resumed in place** at the reset rather than reclaimed. On the resume: a distinct "resumed the retained worktree" activity before the worker starts. On a refused re-admission or a second consecutive limit: state → `Needs Human Decision` with the specific reason, worktree still untouched |
| Stopped at a safe boundary (§Stop controls) | Comment explaining why — **and nothing else**; the state is left where whoever stopped it put it |

No agent conversation is a source of truth. Anything that matters must be written to Linear or to the repository before the session ends.

### One lifecycle, two publication surfaces (MOV-158)

Everything in that table after the claim is published through a single
lifecycle (`tools/dispatcher/src/agent-lifecycle.mjs`). A transition is
described **once** — a kind, a plain-text summary, and the markdown a human
needs — and `renderLifecycleEvent()` (`agent-session.mjs`) turns that one
description into both possible surfaces. The publisher then picks exactly one:

1. a first-class **Linear Agent Activity** on an Agent Session, when that
   capability is available; otherwise
2. the **app-actor comment** the dispatcher has always written.

Workflow-**state** transitions are outside that either/or and are written
whichever surface wins: state is durable control data that Linear's views, the
promoter, and `pr-reconcile.mjs` all read. **The issue, branch, and PR are the
durable identity.** Sessions and comments are presentation and history — never
authoritative control state, and never something a later attempt has to resume
to stay correct.

**Surface 2 remains the complete default.** `MOV-159` approved the optional
Agent Session receiver and `MOV-166` delivered it through review-sized splits,
but the capability remains additive and feature-gated. The receiver is hosted
on Vercel and the Mac connects outbound; the Mac never exposes a listener.
Disabling sessions changes presentation and latency only, not dispatch
correctness. See `docs/governance/mov-159-agent-session-receiver-decision.md`.

The layer is therefore off unless `MOVIECAL_AGENT_SESSIONS` is explicitly set,
and off is not a degraded mode — it is the complete operational lifecycle. With
it on and the app unavailable or unentitled, the dispatcher makes exactly **one** failed
`agentSessionCreateOnIssue` per process, latches the answer, and publishes
comments for the rest of the daemon's life. It never repeatedly attempts a
mutation Linear has already refused. `dispatcher doctor` prints which surface is
configured; it deliberately does not probe entitlement, because the only probe
is a mutation and `doctor` is read-only.

The Agent Session mutation documents in `linear-client.mjs` are transcribed from
Linear's published Developer Preview docs and have **never returned successfully
against this workspace**. They are deliberately concentrated in one module,
every failure is non-fatal, and the PR URL is published both in an activity body
and via the external-link mutation — so a wrong field name on one path degrades
rather than loses the link.

### Stop controls

An attempt can be halted, and the halt is honoured at named **safe interruption
boundaries** (`INTERRUPTION_BOUNDARIES` in `agent-signals.mjs`) — never
mid-edit: `before-claim`, `during-worker`, `after-worker`,
`before-workflow-edit`, `before-pr-report`.

Two sources feed one controller:

- **Polling** — the working control today, needing no entitlement and no
  inbound connectivity. While a worker runs, the dispatcher re-reads the issue
  every `MOVIECAL_STOP_POLL_MS` (default 60s; `0` disables the watcher) and
  stops if the delegation was removed, the route changed, or the issue moved to
  a state it does not work under (`Ready for Agent` and `Agent Working` are the
  two compatible states — both, because a re-read can race the dispatcher's own
  transition). A stop during the worker kills its process group, exactly as a
  timeout does.
- **Agent Session `stop` payloads** — the optional low-latency path when the
  signed receiver and outbound stream are enabled.
  `handleAgentSignal()` normalizes, verifies, and replays them through the *same*
  controller, so enabling the receiver would change latency and nothing else.

Two rules that are easy to get wrong and are enforced in code:

- **A failed re-read is not a stop.** A transient Linear error fails open and
  retries next tick; treating a network blip as a human asking to halt would
  kill healthy work. A re-read that *succeeds* and shows the issue gone is
  different, and does stop.
- **A de-delegated issue stops silently.** If the delegation was removed, this
  dispatcher is no longer that issue's writer, and commenting anyway is exactly
  the boundary violation §Dispatch trigger exists to prevent. Only a stop where
  the dispatcher is still the writer gets a single explanatory comment, and no
  stop ever changes the workflow state.

**The local Mac still opens no inbound listener, port, or server of any kind**
— `tools/dispatcher/test/dispatcher-wiring.test.mjs` asserts this
structurally. What changed with MOV-166 is that a receiver now exists
*elsewhere* (a Vercel function, not on the Mac), and the Mac holds an
**outbound** authenticated connection to it — see §Agent Session receiver
below. Before MOV-166, and still true today with the receiver disabled or
unreachable, the inbound half can be exercised by replaying a saved payload
with no network at all:

```
dispatcher agent-signal --fixture tools/dispatcher/fixtures/agent-session-stop.example.json
```

That command is read-only: it normalizes the payload, applies the trust policy,
runs it through the stop controller twice to show the replay is a no-op, prints
what would happen, and mutates nothing. The example fixture is hand-written from
Linear's published preview docs.

**Prompt trust.** A follow-up prompt is trusted only when it comes from a real
workspace user, and never from this dispatcher's own actor (an agent acting on
its own emitted activity is a feedback loop, not a follow-up). A **stop** is
deliberately *not* subject to that policy: refusing to stop because the
requester was not on an allowlist is the wrong failure mode. Stops are always
honoured; only instructions need trust.

### Agent Session receiver (MOV-166)

The architecture MOV-159 approved and MOV-166 implements: a signed-webhook
receiver on the existing Vercel account, with the Mac holding an **outbound**
authenticated stream to it. Full rationale:
`docs/governance/mov-159-agent-session-receiver-decision.md`.

**Shape.** `src/app/api/agent-session/route.ts` — `POST` is Linear's webhook
(HMAC-verified via the *existing, unmodified*
`tools/dispatcher/src/agent-signals.mjs` `verifyWebhookSignature`, before the
body is parsed for meaning; fails closed with no secret configured); `GET` is
the Mac's stream, authenticated with a separate bearer credential. Both live
in the same route module so a `POST` can reach an already-open `GET`'s
in-memory subscriber set when Vercel serves both from the same warm instance.
This is deliberately **best-effort, not a guaranteed-delivery queue**: no new
vendor, no database (MOV-159's explicit boundary). A `POST` landing on a
different or cold instance than the Mac's open connection is buffered for up
to **10 minutes** and lost if never picked up in that window. That degrades to
30-second polling, the permanent, complete fallback — this is a known
characteristic, not a bug, and it's why the receiver is authorized to be this
simple.

**Two independent freshness checks.** The receiver only verifies the
signature and relays the raw, verified payload; it never re-implements
`agent-signals.mjs`'s own logic. All semantic parsing — kind, the existing
60-second `WEBHOOK_MAX_AGE_MS` freshness check, trust, dedup-by-delivery-id —
happens on the Mac (`tools/dispatcher/src/agent-stream-client.mjs`, via the
same `handleAgentSignal` the fixture-replay CLI path already used). The
receiver's own 10-minute relay-buffer retention is a separate, outer bound: it
governs how long an *already-verified* event is held waiting for the Mac to
reconnect, not whether a delivery itself is fresh.

**Secrets.** Two dev-only values, `LINEAR_WEBHOOK_SIGNING_SECRET` and
`AGENT_SESSION_STREAM_CREDENTIAL` (see `.env.example`). Both live in Vercel's
project environment variables (required — the receiver only runs there); the
Mac keeps its own copy of the **stream credential** at
`~/.config/moviecal/agent-session.env` (mode 600,
`config.mjs`'s `agentSessionEnvPath()`), which is the only one dispatcher code
actually reads at runtime. An operator may also keep a reference copy of the
webhook signing secret in that same file for rotation convenience, but
dispatcher source never names or parses that key — see the structural guard
in `dispatcher-wiring.test.mjs`. Rotate each independently: changing one never
requires changing the other.

**Disablement and rollback.** One capability flag,
`MOVIECAL_AGENT_SESSIONS` — off (the default) means the Mac never even
attempts to connect, exactly today's behavior. Full rollback: delete the
Vercel function and remove the Agent Session event subscription from the
`moviecal-dispatcher` OAuth app; no dispatcher code needs reverting, since the
receiver was always an enrichment layer, never a dependency.

**Outage behavior.** Receiver down, stream dropped, Vercel deploy failed, or a
Linear delivery lost all resolve identically: no signal arrives, and
30-second polling continues to carry the complete lifecycle. The Mac
reconnects with exponential backoff (`AgentStreamClient`) on any drop or
credential rejection, including Vercel's own ~300-second forced connection
close (`maxDuration` on the route) — that's an ordinary reconnect, not a
special case.

**Trusted prompts, recorded or delivered.** A trusted follow-up prompt with no
live-steering-capable attempt registered (the common case, and the *only*
case unless MOV-214/215's flag below is also on) is published as a
`prompt-received` lifecycle event — informational, not actionable, the same
comment/activity surface every other transition uses. It does not by itself
mean anything acted on the prompt.

### Live mid-run worker steering (MOV-214/215)

A separate, independent capability flag, `MOVIECAL_AGENT_SESSION_STEERING`
— off by default. MOV-159 approved the receiver above but explicitly did not
authorize altering the dispatch boundary or the worker execution model;
MOV-214 is the decision that did, the same session MOV-166 was implemented
(2026-09-17), at the repo owner's explicit request for the full-featured
capability rather than a permanently record-only one.

**Mechanism.** With this flag on, a Claude-routed attempt (Codex has no
equivalent protocol and always stays record-only) is invoked with
`--input-format stream-json` instead of one-shot print mode, and its stdin is
kept open instead of closed after the initial brief. The dispatcher watches
the worker's own `--output-format stream-json` output for each turn's
completion (`spawnWorker()`'s `nextTurnBoundary()`); if a trusted prompt is
queued when a turn completes, it's written as the next turn instead of
closing stdin — otherwise stdin closes immediately, identical timing to the
steering-off path. A prompt is queued the moment it's classified trusted
(`agent-stream-client.mjs`'s `queuePrompt`) but is never written into a turn
already in progress; only the dispatcher's own turn-loop ever calls the real
`writeTurn`.

**Trust boundary.** Only a signal `classifyPromptTrust` already marks
`trusted: true` (the same, unmodified logic used for the receiver above) is
ever queued, and it is written only as plain conversational content — a
stream-json user-message frame. It cannot touch `--permission-mode`, the
sandbox flags, or `security-policy.mjs`'s rules, all fixed at the worker's
spawn time and never reachable from stdin content. `worker-guard.mjs`'s
command audit covers every command the worker runs identically regardless of
whether it originated from the initial brief or an injected turn.

**Disablement.** Off returns the worker invocation and `spawnWorker()`'s
return shape to exactly today's one-shot behavior, for every worker and every
issue — verified by `worker-spawn.test.mjs`'s steering-off regression
coverage.

## Security model

**What's actually GitHub-enforced today (ruleset updated for MOV-302):** direct pushes to `master` are rejected at the git protocol level (`GH013`); force-push and branch deletion are blocked; merging requires going through a PR that satisfies `lane-baseline`, `lane-unit`, `lane-integration`, `lane-browser`, `lane-review`, and `lane-ios` (a skipped `lane-ios` satisfies the check for changes outside the iOS path set); `bypass_actors: []` means even the repo owner can't override this via GitHub's admin-merge option. None of that depends on a worker reading a file — it's the `master-protection` ruleset (see `docs/technical/`), and GitHub itself rejects the attempt regardless of who or what makes it. An agent never runs `gh pr merge --admin`; it enables GitHub auto-merge and lets the ruleset gate the actual merge.

**What is *not* yet GitHub-enforced, and is honest to name as a gap:** `master-protection`'s `pull_request` rule sets `required_approving_review_count: 0` (see `docs/planning/decision-log.md` Stage 9/9b) — every PR today is authored under the repo owner's own GitHub credentials, and GitHub blocks a PR author from approving their own PR, so requiring a review today would deadlock the queue rather than add scrutiny. This is deliberately **not** being fixed by adding a formal review-approval step: GitHub's own Copilot code review never posts an "Approve", specifically so it can't satisfy `required_approving_review_count` — a same-family bot approving its own sibling's PR would just be a rubber stamp under a different identity, not real independent scrutiny, and would need a second GitHub credential to provision and secure for no real gain. Instead, `MOV-116` adds an automated independent review pass as a **required status check** (`lane-review`, see below), the pattern proven at scale by Devin Review and CodeRabbit: fully unattended, no approval semantics, no second identity. `required_approving_review_count` stays `0` permanently under this design — there is no approval step to require.

**Worker enforcement boundary (MOV-145).** Claude and Codex now run behind the same technical boundary in `worker-guard.mjs`; prompt text and vendor-specific settings are not trusted as the authority:

- `worker-spawn.mjs` wraps either adapter in an inherited macOS Seatbelt profile. The profile denies execution of Git, `gh`, SSH transports, `curl`, and production-deploy entry points; denies reads of dispatcher/GitHub/SSH/npm credential stores (including the dev environment in repair mode); protects Git metadata and governance-controlled files; and prevents changes to dispatcher or shell credential configuration. The sanitized environment retains Claude's worker credential only in the Claude parent process and forces `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so Bash, hooks, and MCP servers do not inherit it; Codex receives no Claude credential. The dispatcher's `ANTHROPIC_API_KEY` is never passed to either worker (MOV-211): it is reserved for the bounded advisory-diagnosis call, so it cannot change worker authentication or billing. There is intentionally no unguarded fallback: if the OS or native adapter sandbox cannot be applied, the worker does not start, the issue moves to `Needs Human Decision`, and the dispatcher writes a checksummed failure audit (with the Linear comment as the backstop if local audit storage is unavailable).
- **`/usr/bin/security` is intentionally not denied (MOV-174), unlike the other listed binaries.** Claude Code's own startup unconditionally probes the macOS Keychain (`security find-generic-password -s "Claude Code-credentials"` / `-s "Claude Code"`) to resolve its provider credential — verified to happen regardless of whether `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` is already set in the environment. A blanket sandbox deny on this binary crashed every worker before it did any work (`EPERM` on `posix_spawn`, empty transcript), and neither alternative fix was viable: no credential env var suppresses the probe, and Claude Code's own `--bare` mode does avoid it but does not read `CLAUDE_CODE_OAUTH_TOKEN` — incompatible with running workers against a Claude subscription rather than pay-per-token Console billing. This is an accepted trade-off, not a closed gap: `security-policy.mjs`'s post-hoc transcript audit still hard-denies a worker's *own* `security find|dump|export|unlock|set|add|delete-` invocation, but that catches misuse after a read already happened, not before — there is no longer an OS-level block on a worker reading arbitrary Keychain entries by service name. **Operational caveat:** this credential lookup only succeeds while the Mac is logged in and the login Keychain is unlocked; if `launchd`'s `RunAtLoad` starts the dispatcher before that (e.g. immediately after a reboot, before anyone logs into the GUI session), worker dispatch fails with the same crash signature until login/unlock happens — this is expected given the design above, not a regression to re-investigate.
- The sanitized environment also sets `MOVIECAL_WORKER_SANDBOX=1` — a plain signal, not a capability, so anything the worker spawns (including `npm run verify` and, through it, the dispatcher's own test suite) can know it is running inside this sandbox without probing for a denial itself. `tools/dispatcher/test/startup-recovery.integration.test.mjs`, `worktree-reclaim-concurrency.integration.test.mjs`, and `worker-guard-sandbox.integration.test.mjs` read it to skip their real-`git`-binary fixtures cleanly when a worker's own `npm run verify` reaches them — those fixtures cannot succeed once this same sandbox denies `git` process-exec to the worker, and that denial is not a regression in what they test. They keep full coverage on macOS/CI and any human/local `npm run verify` run outside the worker sandbox, where the variable is unset (MOV-274 autonomy-pilot follow-up).
- Credential-shaped environment variables are removed and Git interactive/keychain helpers are disabled. Claude loads shared project defaults plus a dispatcher-owned `--settings` payload containing its worker-only permission denies; the tracked `.claude/settings.json` deliberately contains neither those denies nor a sandbox policy, so ordinary human sessions are not constrained by worker policy. Claude disables plugins/MCP/slash commands, while `worker-guard.mjs` supplies its fail-closed filesystem/network sandbox with no unsandboxed escape hatch. Codex ignores user exec policy/config, runs ephemeral `workspace-write` with approval policy `never`, and keeps model-generated command network access disabled. These harness-native sandboxes prevent an allowed test/package script from becoming an indirect network bypass.
- Both adapters emit structured tool events. Output is redacted before being written to disk, then `security-policy.mjs` audits command attempts (including alternate GitHub API paths) while the diff audit catches protected changes regardless of command construction. Each hard-deny has an explicit category: **scope** rules keep dispatcher-owned operational tools (Git, `gh`, alternate GitHub API transports, and SSH transports) out of workers; **safety** rules protect secrets, Keychain access, production mutation, releases, and protected paths. A scope command that the native harness demonstrably denied is retained as an auditable warning, not a publication blocker; a scope command that executed or has an unknown outcome remains fail-closed. Every safety attempt remains fail-closed regardless of outcome. Warnings never preempt normal classification of the worker's actual exit (for example, a provider rate-limit retry).
- Workers leave filesystem changes only. The dispatcher owns every Git and authenticated remote step, validates branch identity, stages and commits the audited result, confirms the worktree is clean, performs a non-force push with an explicit refspec, and creates or reuses the draft PR.
- Any missing audit, sandbox failure, bypass-shaped tool call, protected diff, branch mismatch, or publication-gate failure moves the issue to `Needs Human Decision` and records a checksummed `security-audit.json` plus a Linear evidence comment. No workflow application or remote mutation follows a failed audit.

**Advisory diagnosis for unrecognized failures (MOV-179).** Sensitive, unknown, repeated, untrusted, and budget-exhausted outcomes escalate to `Needs Human Decision` — that policy, and the decision of *whether* an outcome escalates, is unchanged by anything below. What MOV-179 adds is legibility for the human reading that escalation: for the residual bucket of failures with no dedicated classification of their own (not a provider rate limit, not a credential failure, not a security-policy scope/safety block — every one of those already gets its own specific comment above), the dispatcher makes one bounded, cheap-tier model call (`worker-diagnosis.mjs`) over the failed run's log tail and audit text, and splices its finding into the `Needs Human Decision` comment ahead of the raw log dump. The diagnosis is required to name a falsifiable, grounded signature (an exit code, an `api_error_status`, a matched log line) or say plainly that it could not identify one — never a fabricated cause. This is **advisory only**, in the same sense `security-policy.mjs`'s AI review pass is: it never changes whether an issue escalates, never retries anything, and never makes a second dispatch or Linear-mutation decision beyond the text of the one comment it writes. The call is single-shot with no retry, and fails safe unconditionally — a missing `ANTHROPIC_API_KEY`, a timeout, a rate limit, or a malformed response all fall straight through to today's plain comment, and the escalation itself never waits on or depends on this succeeding. It reads `ANTHROPIC_API_KEY` from the dispatcher process's own environment (not a worker's — workers never see this call at all); an operator who wants the richer comment sets that variable wherever the dispatcher daemon's environment lives (e.g. the launchd plist's `EnvironmentVariables`, see below), and an operator who does not is left with exactly today's plain comment, which remains a fully supported outcome, not a degraded one.

**Nested-sandbox crash — root-caused and fixed (MOV-180, superseded by MOV-184).** `sandbox-exec: sandbox_apply: Operation not permitted`, exit code 71 (or, less obviously, a graceful exit 0 with the worker narrating the same error and making no changes), on a worker's very first sandboxed subprocess call, with every subsequent attempt in that run failing identically. MOV-180 first detected this and initially attributed it to Seatbelt not supporting nested confinement *in general*, recommending a `launchctl bootout`/`bootstrap` cycle as the recovery.

**That recovery claim was wrong, and MOV-184 replaced it with a real fix.** Re-investigation (2026-09-14, after [MOV-172](https://linear.app/moviecal/issue/MOV-172) hit this again immediately following a full `bootout`/`bootstrap` cycle — directly falsifying the earlier claim) found the actual, more precise mechanism: a `sandbox-exec` profile of `(allow default)` alone *can* nest a second `sandbox-exec` call; the identical profile plus even one unrelated `(deny ...)` rule cannot — confirmed with an isolated, interleaved control test ruling out session/daemon state entirely. `worker-guard.mjs`'s outer profile is never a pure `allow default` (its whole purpose is the deny rules below), so it collided with Claude Code's own internal per-command Bash-tool sandbox (a second, independent `sandbox_apply` call) on **every** dispatched Claude worker that touched the Bash tool — deterministically, not intermittently, and not something any daemon restart could ever clear.

**The fix**: Claude Code's own internal per-command sandbox is redundant here — the outer `worker-guard.mjs` profile already provides the complete security boundary (deny git/gh/ssh/curl exec, deny credential-file reads, deny protected-path writes; see above). `workerInvocation("claude", ...)` (`tools/dispatcher/src/worker-routing.mjs`) now passes `--settings '{"sandbox":{"enabled":false}}'`, disabling Claude Code's own inner sandbox entirely so only the outer, already-sufficient layer applies. Verified against the real shipped code path (`workerInvocation` + `guardedInvocation` + `buildWorkerSandboxProfile`, not a hand-rolled equivalent): the Bash tool now succeeds under the outer profile where it previously failed identically to the recorded incidents. `codex` is unaffected — its `--sandbox workspace-write` flag is a self-contained mode, not a second nested `sandbox-exec` call.

MOV-180's detection machinery (`failure-classification.mjs`'s `classifyWorkerFailure()`, the persisted circuit breaker in `circuit-breaker.mjs`) remains in place as a defense-in-depth backstop, requeuing to `Ready for Agent` with a distinct comment and pausing further dispatch if this signature is ever seen again. MOV-299 extends that backstop to Codex's observed graceful-exit shape: the worker must report the same exact marker in its structured agent message before any audited tool action executed; a generic zero-change/zero-exit result is never enough. A correctly-updated dispatcher-daemon (post-MOV-184, i.e. running current `tools/dispatcher/` code, not a stale worktree — see the "not auto-updated" warning below) should not hit it in normal operation. If it recurs, treat that as a signal something else changed (a new tool trying its own nested sandboxing, an OS update altering this behavior again) rather than assuming the old `bootout`/`bootstrap` guidance applies — it does not fix this condition and never reliably did.

Repair mode is stricter: tests, test-runner configuration, dispatcher code, staged workflow proposals, and governance documentation are read-only. CI logs, PR bodies, diffs, and review comments are delimited as untrusted data by `generateRepairEvidence()`; they can inform a code fix but cannot alter the fixed mode, target, attempt budget, or tool authority. `validateRepairTarget()` admits only a retained `review` worktree whose dispatcher-owned provenance matches the configured repository and the live PR head repository, branch, and observed SHA. Forks, stale heads, and unknown branches are never repaired automatically.

**Automatic CI and review repair (MOV-190).** `dispatcher run` evaluates retained review worktrees after reconciliation on every poll, even when there are no `Ready for Agent` issues. It is disabled unless `MOVIECAL_AUTO_REPAIR` is explicitly truthy. When enabled, the dispatcher records an attempt in `~/.config/moviecal/repair-ledger.json` *before* it re-runs a transient failed job or starts one repair-mode worker, so the per-PR budgets and "one job per head SHA/failure fingerprint" rule survive a restart. A transient failure is re-run without a worker or repository change; a supported code/review failure gets at most one single-flight repair worker per pass and may publish only to the exact existing PR branch and admitted SHA. A dirty checkout, stale/unreadable head, unsupported/sensitive failure, exhausted budget, failed audit, publication failure, or missing Linear issue is refused or escalated with one durable Linear/PR record; it never silently retries or opens a replacement PR.

**Review-CI observations (MOV-298).** Observation records are keyed by the required-check snapshot as well as PR and head SHA. A pending required check is explicitly reported as **provisional**, never as a final “no actionable failure” result; once the same head becomes terminal, its changed snapshot receives one new observation while unchanged later polls remain silent. During a long-running implementation worker, `dispatcher run` keeps this read-only review-CI observation on its normal interval. It does not start a repair worker while that implementation worker occupies the single dispatch slot; the ordinary repair pass re-observes the terminal state when the slot is available.

**Preview and supervised first use (MOV-191).** Live repair is available only inside `dispatcher run` while its singleton dispatcher lock is held; a repair-pass failure is caught so normal issue dispatch continues. `npm run dispatcher:repair` runs the equivalent read-only admission preview (`dispatcher repair --dry-run`): it reads current PR observations, checkout guards, and the durable budget ledger, but never reserves an attempt, starts a worker, reruns CI, writes Linear/GitHub evidence, or changes a worktree. Before enabling `MOVIECAL_AUTO_REPAIR` unattended, an operator must: (1) create a disposable dispatcher-owned draft PR with a deliberately failing, supported test lane; (2) run the preview and confirm the exact branch, SHA, failure fingerprint, and proposed action; (3) enable the switch for one supervised poll and confirm the repair/rerun remains on that PR and records one Linear activity/comment plus one plain GitHub PR comment; (4) confirm its ledger attempt and the next poll's idempotent result; and (5) disable the switch, inspect the PR/worktree/log/audit record, and only then decide whether unattended use is appropriate. Never use a production-sensitive, forked, dirty, or human-owned PR for this exercise.

**Post-merge master CI observation (MOV-317).** `dispatcher run` first reconciles any existing master-failure remediation and then observes newly completed, failing push runs on `master`; this pass is independently caught, so an unavailable GitHub or Linear read never aborts ordinary promotion or dispatch. It is **off by default**. Set `MOVIECAL_MASTER_CI_OBSERVER=1` only for a supervised poll; with the switch unset the pass does not construct its context, read `~/.config/moviecal/master-incidents.json`, call GitHub, or write Linear.

`npm run dispatcher:master-ci` (`dispatcher master-ci --dry-run`) is the sole standalone surface. It deliberately forces a read-only preview even when the live switch is off, printing what current facts would classify, route, or reconcile without writing the incident ledger, creating/changing a Linear issue, taking the dispatcher lock, mutating GitHub, starting a worker, or changing a worktree. There is no standalone live observer command: live observation remains part of the lock-held dispatcher lifecycle only.

The observer considers only configured verification workflows' completed `push` runs on this repository's `master` (default: `verify`, `ios-verify`, `browser-verify`, and `supabase-verify`). Its evidence is the immutable run ID/attempt/tested SHA, run URL, failed lanes, source PR/Linear attribution when GitHub can prove it, and bounded current-master lineage; that evidence is retained in the durable ledger and rendered into every remediation item. A verified, attributable code/test failure may create one fully specified, `risk:high` remediation issue for the existing Backlog → promote → delegate → draft-PR path. Infrastructure, sensitive, ambiguous, stale-lineage, or over-budget failures instead stop at `Needs Human Decision`. Neither path can commit to, merge into, revert, force-push, or blindly rerun `master`.

For the first supervised use, run the preview and check the named run, SHA, classification, source attribution, and proposed outcome; enable the switch for one dispatcher poll; then inspect the exact Linear item/comment and `master-incidents.json`. Handoff is complete only after a remediation PR merges and the originally failed named lane succeeds on a newer `master` SHA: only then does the reconciliation pass retain that proof, comment on the remediation, and move it to `Done`. A passing rerun of the original failed SHA cannot close it. To disable safely, unset `MOVIECAL_MASTER_CI_OBSERVER` and restart or allow the next poll to read it; no half-finished observer write is possible, and any already-filed remediation item remains ordinary human-owned backlog work until resolved.

**Risk-scoped PR readiness and merge (MOV-162).** This capability is off by
default: `MOVIECAL_PR_AUTONOMY` must be explicitly truthy *and*
`MOVIECAL_PR_AUTONOMY_MAX_ACTIONS` must set a positive durable rollout cap.
The allowlist preserves `docs/**` and permits only low-risk helpers under
`src/**` with deterministic coverage under `test/**`; it is not blanket
permission for either root. API/server routes, auth/sign-in/session/middleware,
calendar/token/feed, Supabase/database/real-stack/private-watchlist, cron,
deployment, security-sensitive, and browser-E2E paths remain excluded. A PR
must be dispatcher-owned on an `agent/MOV-NNN-*` branch in this repository; its
Linear issue must carry
`agent-ready`, `risk:low`, and `execution:mac`; and its PR body must state
`Autonomy: eligible`, `Human testing: not-required`, non-empty local-agent
evidence, and a non-empty no-human-testing rationale. `human-only`, sensitive
labels (`area:auth`, `area:calendar`, `area:database`, `area:deployment`, or
security classifications), missing or stale
latest-SHA checks, skipped/failed checks, missing evidence, requested changes,
repair activity, any mixed allowed/denied diff, and every path outside the
approved low-risk policy are refusals.

The per-issue kill switch is `Autonomy: disabled` in the Linear issue body;
the same marker in a PR body stops that PR. Removing the global environment
switch returns every PR to manual readiness and merge without affecting Linear
tracking or normal local execution. Action reservations are written before a
GitHub mutation to `~/.config/moviecal/pr-autonomy-ledger.json`, so a restart
cannot retry an action or widen the staged cap. The first action makes a draft
ready; only a later current-SHA pass of every required check (including the
independent `lane-review` control) with no requested changes permits `gh pr
merge --auto --merge`. This enables GitHub's ordinary auto-merge and never
uses an admin override or bypasses the ruleset. Each action posts a Linear rollout metric;
the initial review date is 2026-10-02.

Repair publication has a separate trusted path, `publishRepairResult()`. It
requires the checkout to remain at the exact SHA used for admission, requires
the original PR to exist both before and after publication, and pushes only to
that PR's dispatcher-owned branch without force. It never creates a replacement
branch or PR; a stale checkout, missing PR, or changed PR identity fails closed
for human reconciliation.

**`lane-review` (added 2026-09-08, required status check since 2026-09-08 — MOV-119):** `scripts/lane-review.mjs`, run by `.github/workflows/review-verify.yml` on every PR. Two layers with deliberately different trust properties (MOV-150):

- **Deterministic heuristics** — sensitive paths (`.github/workflows/**`, `AGENTS.md`, `.claude/settings*.json`, `docs/product/**`, ruleset-shaped filenames), secret-shaped strings, diff-size threshold. Always run, need no credential, and are **fail-closed**: a heuristic `block` fails the check. The only downgrade is the sensitive-path acknowledgement below; secret and diff-size blocks are never downgradeable.
- **AI review pass** — a non-deterministic Claude call (`claude-haiku-4-5`, strict reviewer-only prompt), run only when the `ANTHROPIC_API_KEY` repo secret is present. Its substantive findings about the diff are **advisory**: a model `block` still fails the check, but — unlike a heuristic block — it can be downgraded with the `lane-review-ai-ack` acknowledgement below. This is because the AI layer has produced false-positive blocks with no override path (MOV-140/#345, MOV-142/#346, MOV-152/#353), each of which needed a fresh push to clear.

The advisory treatment covers only *what the model says about the diff*. If the AI pass is **configured but cannot produce a verdict** — HTTP error, unparseable or invalid JSON — that is lost scrutiny, not a clean pass: it fails the check as a **non-downgradeable `block`**. Only when `ANTHROPIC_API_KEY` is absent entirely does the skipped AI pass fall back to a `warn`, so the lane can stay required without depending on secret provisioning first. What the required check therefore guarantees on a green run: every deterministic heuristic passed (or a sensitive-path hit was explicitly acknowledged), and either the AI pass ran and raised nothing it (or an acknowledgement) treats as blocking, or the AI pass is not configured at all. It does **not** guarantee a green run was reviewed by a model, and — because the reviewer is same-family as the Claude authors — it is not independent cross-provider scrutiny; a genuinely independent pass needs a second provider's key wired into `review-verify.yml`, which is recommended but not yet done.

`lane-review` never posts a GitHub review/approval — only a plain PR comment for visibility, stamped with the PR head SHA so a stale comment from an earlier push is not read as the current verdict.

**Acknowledging a legitimate sensitive-path change (MOV-134).** A sensitive-path hit is a `block` by default, and with `bypass_actors: []` that means the PR cannot merge at all — so a real change to one of those paths needs an explicit, auditable sign-off. The repo owner records it by adding the **`sensitive-path-ack` label** to the PR **and** a **`lane-review-ack: <reason>`** line to the PR body. With both present, `lane-review` downgrades the sensitive-path finding from `block` to `warn` (still printed, still in the summary comment). One without the other still blocks, and the message names what is missing. This mirrors MOV-121's workflow-edit authorization (label + marker, fail closed) and is deliberately narrow: **secret-detection and diff-size blocks are never downgradeable this way**, and the acknowledgement is per-PR, visible in the PR's own metadata.

**Overriding a false-positive AI-review block (MOV-150).** A substantive AI-review `block` is advisory — it fails the check, but the repo owner can downgrade it to a `warn` by adding the **`lane-review-ai-ack` label** to the PR **and** a **`lane-review-ai-ack: <reason>`** line to the PR body. Same fail-closed shape as the sensitive-path ack: one without the other still blocks and the message names what is missing; the reason is recorded in the summary comment. This is a distinct label and marker from `sensitive-path-ack` / `lane-review-ack:` — an ack of one kind does not satisfy the other. It applies **only** to the model's judgement about the diff: an AI pass that was configured but failed to run or returned garbage is a non-downgradeable `block`, and heuristic blocks are unaffected. Because `on: pull_request` does not re-trigger on a label or body edit alone, push a commit (or re-run the workflow) after adding the ack.

It ran informationally (not required) for its first several PRs before being promoted: zero false positives across 8 PRs, spanning docs-only changes, dispatcher-internal code, and one substantial real app-code PR (`MOV-104`/#281, 711 additions across 15 files) — every `pass` was legitimate and every `block` was a genuine workflow-file touch (`#272`, `#279`, `#281`'s applied-workflow commit). The AI layer's first live run (`ANTHROPIC_API_KEY` was configured partway through, on `#281`) produced two well-calibrated non-blocking `warn`-level findings (a placeholder bundle identifier, a hardcoded simulator destination) rather than overreaching to `block` — exactly the "flag, don't overreach" behavior it's designed for. On that evidence, `lane-review` was added to `master-protection`'s required status checks (then five checks total, alongside `lane-baseline`/`lane-unit`/`lane-integration`/`lane-browser`) via a direct `PUT` to the ruleset API — a repo owner action, not something the dispatcher or a worker ever does (ruleset/branch-protection changes stay on the hard-deny list unconditionally, see below).

**Credentials** — none live in the repository:

| Credential | Location | Scope |
|---|---|---|
| GitHub | `gh` keyring auth on this Mac | already scoped |
| Linear API key | `~/.config/moviecal/linear.env` (mode 600) | scoped to team `MOV` |
| Linear app-actor credential | `~/.config/moviecal/linear-app.env` (mode 600) | OAuth2 Client Credentials for the `moviecal-dispatcher` workspace identity (MOV-122); keys `LINEAR_APP_CLIENT_ID`, `LINEAR_APP_CLIENT_SECRET`, `LINEAR_APP_ACTOR_ID`, `LINEAR_APP_SCOPES` (`read,write,app:assignable,app:mentionable`). Optional during the transition — when absent the dispatcher falls back to the personal API key above. |
| Test `.env.local` | `~/.config/moviecal/env.local` (mode 600) | disposable/dev Supabase + TMDb credentials only |
| iOS manual-test Supabase account | `~/.config/moviecal/ios-manual-test.env` (mode 600) | `moviecal-ci-dev` project only, never production; a disposable auth account (URL, anon key, test email/password) for local "Human testing" checklists (MOV-106/MOV-107-style) that need a real iOS sign-in. Reuse it rather than creating a new account per session. |
| `SUPABASE_DB_URL_PROD` | GitHub Actions secret | never available to a local worker |

**Hard deny — the dispatcher refuses and escalates to `Needs Human Decision`:**

- Force-push anything; push to `master`; delete a branch other than its own
- Modify `.github/workflows/**`, GitHub rulesets, or branch protection
- `gh secret set`; echo any env var matching `*KEY*|*TOKEN*|*SECRET*|*PASSWORD*`
- Any command referencing `SUPABASE_DB_URL_PROD`; `supabase db reset`
- `vercel --prod`; `gh release create`; `npm publish`
- Edit `AGENTS.md`, `.github/copilot-instructions.md`, or `docs/product/**`

The hard-deny list is enforced before, during, and after the model process: OS sandbox/credential removal prevents the capability, structured-command auditing records attempts, and diff/publication gates stop any result that violates the protected path or branch contract. For Claude workers, `workerInvocation()` adds the matching early-refusal denies through its dispatcher-only `--settings` payload; `.claude/settings.json` remains an interactive shared-defaults file and does not apply that worker policy to humans.

**Audit normalization (MOV-210).** The command audit preserves escaped shell separators (`\\|`, `\\;`, and `\\&`) as literal data before applying ownership rules: a grep regular expression that happens to contain `\\|git` is not a Git pipeline. It still detects a real `|git` pipeline, including one without surrounding spaces. `npm run <script>` is likewise recognized as local script execution, so credential-like test-file or script names do not look like npm credential operations; non-`run` npm credential/token commands remain hard-denied. Finally, output checks are bounded to one shell command, so `echo ---; grep "ANTHROPIC_API_KEY"` is not misreported as echoing a credential. These are deliberately lexical, fail-closed exceptions for literal data and command boundaries—not a general relaxation of the protected command set.

Two operational prerequisites for a Claude worker to run headlessly at all, discovered and confirmed empirically while wiring this up:

- **Workspace trust.** Claude Code refuses to apply `.claude/settings.json` in an untrusted workspace. This is anchored to the repository's **main checkout path**, not to whichever worktree a session runs from: trusting a linked worktree's own path did *not* stop the "workspace has not been trusted" warning for a `-p` session run from it; trusting the main checkout did, and that one grant covers every worktree of the repo. `WorktreeManager.create()` (`tools/dispatcher/src/worktree-manager.mjs`) pre-trusts both the new worktree's own path and the discovered main-checkout path (via `mainWorktreePath()`, parsed from `git worktree list --porcelain`) using `tools/dispatcher/src/claude-trust.mjs`'s `trustWorkspace()` — a careful read-modify-write of `~/.claude.json` that touches only the one project key, preserving everything else. This is safe specifically because it only ever runs on paths the dispatcher itself just checked out from this same repository, never an arbitrary path. Failure is non-fatal and logged: an untrusted workspace still fails cleanly rather than hanging (see below).
- **A current login.** The `claude` CLI's own login must be valid (`claude` then `/login` if expired) — this can only be done interactively, never by an agent.

**Staged workflow-edit proposals (MOV-121, added 2026-09-08).** `Edit(.github/workflows/**)` in the Claude worker's dispatcher-only hard-deny payload is never lifted, for any issue, ever — that stays exactly as strict as documented. But some legitimate issues (e.g. a CI-cutover task like `MOV-104`, converting `ios-verify.yml` from bootstrap no-op to real `xcodebuild`/XCTest CI) genuinely need to change a workflow file as their whole point, and the repo owner wants issues like that handled fully by an agent in one PR, not split into "agent scaffolds, human hand-applies the CI diff." A permission carve-out can't do this safely: rules are evaluated deny-then-allow with **deny always winning regardless of specificity** (verified above), so a narrower "allow this one file" rule layered on top of the blanket deny would be silently ignored — and even removing the blanket deny and denying every *currently-existing* workflow filename individually leaves a gap, since a worker could create a brand-new file under `.github/workflows/` that wouldn't match any of the enumerated denies.

Instead, a human applies the `ci:workflow-edit-authorized` label to an issue and adds exactly one `Workflow-edit: <path>` marker to its description (e.g. `Workflow-edit: .github/workflows/ios-verify.yml`) — `resolveWorkflowEditAuthorization()` in `preflight.mjs` fails the whole issue closed (moves it to `Blocked`) if the label and marker don't both agree on exactly one valid `.github/workflows/*.yml` path, rather than silently proceeding either under- or over-scoped. When authorized, the worker's brief (`brief.mjs`) tells it to write the file's full proposed content to `tools/dispatcher/pending-workflow-edits/<filename>` — an ordinary staging path — instead of editing the real one. After an implementation worker exits and passes its audit, `workflow-edit-apply.mjs` copies the staged content into the exact authorized path and removes the staging file; the shared publisher includes that trusted application in its commit and then pushes the branch. **Repair mode never applies a staged workflow proposal**, and its stricter diff/sandbox policy prevents a repair worker from changing the staging area itself.

Crucially, this doesn't weaken review: the resulting PR still visibly contains the workflow diff, and `lane-review`'s existing sensitive-path heuristic still flags any diff touching `.github/workflows/**` as requiring explicit human sign-off before merge — the same gate any other issue's workflow-touching PR would hit. What changes is only *who proposes and builds the change* (an agent, working under real hard-deny protection throughout, never gaining the ability to directly write to that path), not *whether it's reviewed before merging*.

Separately: the worker previously had no `xcodebuild`/`xcrun simctl` in its Bash allowlist at all, so it couldn't verify an iOS build even once permitted to touch the workflow. `Bash(xcodebuild *)` / `Bash(xcrun simctl *)` are now allowed globally in `.claude/settings.json` — safe to allow unconditionally, unlike the workflow-edit case, since running a build/test is not itself governance-sensitive.

**Always requires a human (`Needs Human Decision`):**

- Database migrations touching existing tables
- Auth or calendar-token logic changes
- Anything adding a new secret
- Any production deploy or release
- Any change to this governance system itself

## Run-log locations

Dispatcher and worker run logs are written to `~/Library/Logs/moviecal-dispatcher/<LINEAR-ID>-<slug>/`, one directory per worktree, containing redacted structured worker stdout/stderr, `manifest.json`, the applied `worker-sandbox.sb`, and the checksummed `security-audit.json`. Logs are retained for 90 days and then pruned by `dispatcher gc`. Given a Linear issue, the corresponding run log directory can always be found from the worktree/branch name recorded in the dispatcher's `Agent Working` comment on that issue (`<LINEAR-ID>-<slug>`).

## Persistent service (launchd)

Template: `tools/dispatcher/launchd/com.moviecal.dispatcher.plist`. The filled-in copy that's actually loaded lives outside the repo at `~/Library/LaunchAgents/com.moviecal.dispatcher.plist` — same "runtime config lives outside the repo" pattern as `~/.config/moviecal/`.

**Runs out of a dedicated worktree, not the interactive main checkout.** `REPO_ROOT` (`tools/dispatcher/src/config.mjs`) self-resolves from wherever `dispatcher.mjs` physically lives — three directories up from the script's own path — so it's whatever directory the plist points at, no separate config needed. Pointing that at `/Users/adammoore/code/moviecal` (the checkout used for interactive local git work) would mean the daemon's own `git fetch`/`git worktree add`/`git branch -D`/`git push --delete` calls share a working directory with whatever the repo owner is doing there by hand. Instead, the installed plist points at a dedicated, non-interactive worktree: `/Users/adammoore/code/worktrees/moviecal/dispatcher-daemon` — never used for anything else, so the daemon's own git operations never collide with local interactive use. The dispatcher itself has zero external npm dependencies (everything under `tools/dispatcher/` imports only `node:*` builtins), so this worktree needs no `npm ci` — a bare `git worktree add` is sufficient.

**This worktree is not auto-updated.** Nothing currently pulls new commits into it on its own — if `tools/dispatcher/` changes on `master` after the service is running, the daemon keeps executing the orchestration code it started with indefinitely, without erroring (worker-spawned worktrees still branch from current `origin/master`, since `WorktreeManager.create()` fetches at creation time — only the dispatcher's own top-level logic goes stale). Whenever `tools/dispatcher/` changes: `cd` into `/Users/adammoore/code/worktrees/moviecal/dispatcher-daemon`, `git pull`, then restart the service (`launchctl kickstart -k gui/$(id -u)/com.moviecal.dispatcher`). A self-updating daemon was deliberately not built here — that's its own supervision-model question, not something to fold in as a side effect of getting the base service running.

**Commands** (see the template's own header comment for the full list; MOV-146):

* **Start**
  ```
  launchctl load ~/Library/LaunchAgents/com.moviecal.dispatcher.plist
  ```
* **Stop.** Safe to run at any time — no live worktree, worker, or Linear/GitHub mutation is left in an inconsistent state by simply stopping the daemon between poll cycles (verified: no Linear activity occurs during a stop window; the next `dispatcher run` picks up exactly where the registry left off).
  ```
  launchctl unload ~/Library/LaunchAgents/com.moviecal.dispatcher.plist
  ```
* **Status**
  ```
  launchctl list | grep com.moviecal.dispatcher
  ```
* **Restart** (after a `git pull` in the daemon worktree — see above — or to clear a wedged process):
  ```
  launchctl kickstart -k gui/$(id -u)/com.moviecal.dispatcher
  ```
  `KeepAlive.SuccessfulExit: false` (below) already restarts the process on a crash; this is for a *deliberate* restart. For the one known case where `kickstart -k` is insufficient (a stuck nested-sandbox condition), see the full `bootout`/`bootstrap` cycle documented above — though as of MOV-184 that condition should no longer occur in normal operation.
* **Upgrade** (deploy new `tools/dispatcher/` code to the running service):
  ```
  cd ~/code/worktrees/moviecal/dispatcher-daemon
  git pull
  launchctl kickstart -k gui/$(id -u)/com.moviecal.dispatcher
  ```
  Confirm with `dispatcher doctor` and by tailing `dispatcher.stdout.log` for a completed poll cycle afterward — `doctor` from an interactive shell does not prove the daemon's own environment is healthy (see PATH note below).
* **Rollback** (the new code misbehaves — return the daemon worktree to a known-good commit):
  ```
  cd ~/code/worktrees/moviecal/dispatcher-daemon
  git log --oneline -5             # find the last known-good SHA
  git checkout <known-good-sha>    # detached HEAD is fine here -- this worktree is never committed to directly
  launchctl kickstart -k gui/$(id -u)/com.moviecal.dispatcher
  ```
  This worktree only ever runs code checked out into it — it has no build step and no dependencies to reinstall (see above), so a rollback is exactly this checkout-and-restart, nothing more. To return to tracking `master` again later, `git checkout master` (or the branch name) once the fix lands.

The plist's own `StandardOutPath`/`StandardErrorPath` (`~/Library/Logs/moviecal-dispatcher/dispatcher.std{out,err}.log`) capture only the dispatcher process's own top-level output — per-worker logs are still under `~/Library/Logs/moviecal-dispatcher/<LINEAR-ID>-<slug>/` as described above. `KeepAlive.SuccessfulExit: false` restarts the process on a crash or nonzero exit but not on a clean exit; `ThrottleInterval: 30` caps restart frequency if it's crash-looping.

**PATH.** launchd runs jobs with a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), not the interactive shell's `PATH`. `ProgramArguments` invokes node via an absolute path so the daemon process itself starts, but every child process the dispatcher or its workers spawn — `gh`, `npm`, `codex` (`/usr/local/bin`), `claude` (`~/.local/bin`) — fails with `ENOENT` unless the plist sets `PATH` explicitly. The template's `EnvironmentVariables` dict does this (`__HOME__/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`); keep it when filling in the installed copy. `dispatcher doctor` passing from an interactive shell does **not** prove the daemon's environment is correct — an interactive shell has a fuller `PATH` than launchd gives the job, so `doctor`'s `gh`/`claude`/`codex` checks can pass there while the running service still fails on the same lookups. After any `launchctl load`, confirm the service itself is working (check `dispatcher.stderr.log` and a run-log directory for a completed poll cycle), not just that `doctor` is clean in your terminal.

## Standing health check

`dispatcher doctor` is a read-only command that asserts: Linear auth works, `gh` auth works, the worktree root is writable, `~/.config/moviecal/env.local` exists and is mode 600, `claude` and `codex` are on `PATH`, `origin/master` is fetchable, and the iOS self-hosted runner is reachable. It also prints the **local dispatch identity** — the delegate an issue must name to be claimed here (MOV-143) — and which **lifecycle publication surface** is configured (MOV-158), both informational rather than pass/fail gates. The Agent Session line reports configuration only: the sole way to test entitlement is `agentSessionCreateOnIssue`, which is a mutation, and `doctor` never mutates. If `~/.config/moviecal/linear-app.env` is present it additionally checks the file is mode 600 and that an app-actor token can be minted from it (MOV-122); if it is absent that check is a no-op pass. Run it after any environment change and before relying on the dispatcher for real work.

### Launch-agent first-poll health (MOV-287)

Before every run pass, the dispatcher checks `gh auth status`. If the non-interactive credential is absent, expired, or `gh` is missing from the LaunchAgent `PATH`, it exits before any PR observation or mutation and logs only a classified recovery instruction — never the CLI output or a token. Repair the credential as the launch-agent user with `gh auth login -h github.com`, then restart the service:

```
launchctl kickstart -k gui/$(id -u)/com.moviecal.dispatcher
```

At process start, the dispatcher writes a non-secret status record at `~/.config/moviecal/dispatcher-launch-health.json` with a two-minute first-poll deadline. `npm run dispatcher:health` is read-only and reports `healthy`, `failed`, or `overdue`; an `overdue` record means the daemon has not recorded a completed first poll in time. Inspect `dispatcher.stderr.log`, repair the indicated prerequisite, and use the restart command above. The record is an operator signal, not an authorization bypass.

## Known gaps / follow-ups

- Dispatch remains deliberately poll-based (default 30s interval,
  `dispatcher run [--interval ms]`). Agent Session webhooks do not replace
  dispatch polling; they add optional low-latency stop/prompt delivery over the
  outbound stream. Polling remains the complete lifecycle with the receiver,
  stream, or session feature disabled.
- Linear Coding Sessions are not enabled for delivery. `MOV-153`,
  `MOV-157`, `MOV-154`, and `MOV-155` remain together in the deferred
  cloud project's `Icebox` and do not block local intake, dispatch,
  acceptance, or autonomy.
- **Backfill is an operator task, not a code task.** MOV-143 makes `execution:mac` + the `moviecal-dispatcher` delegate hard preconditions, so any queued issue missing either one stops being dispatched the moment the daemon restarts onto this code. Run `dispatcher dry-run` first: it lists every `Ready for Agent` issue with its route, delegate, and eligibility, and ends with an `Executable on this Mac: n/m` line. Apply the missing labels and delegations before restarting the service.
- The delegate match accepts the app's workspace *name* as well as `LINEAR_APP_ACTOR_ID`, because that variable currently holds the name rather than the actor UUID. That is looser than an id-only match by design (see `dispatch-eligibility.mjs`); setting the variable to the real actor UUID tightens it without any code change.
- `dispatcher run` has completed live Linear-to-GitHub issue delivery and
  subsequent reliability/repair work. The remaining acceptance scope is the
  local-first drill in `MOV-161`, after bounded intake/handoff and testing
  policy are complete.
- Docker is not installed on this Mac, so `npm run lane:real-stack` / `lane:full-stack` stay CI-only locally; use the `supabase-verify` GitHub Actions workflow as the authoritative DB gate.
- MOV-115 (two-way GitHub sync) is **done** — see `docs/governance/linear-information-architecture.md` §GitHub Issues: migration and ongoing sync.
- MOV-116 (an automated `lane-review` status check for independent PR scrutiny, plus wiring `security-policy.mjs`'s hard-deny list into real enforcement) is partially done — see §Security model above. `lane-review` is now a required status check (MOV-119); the hard-deny-enforcement half is still unresolved.
- **One remaining real worktree-reclaim race, found by MOV-198's real-subprocess integration test (`tools/dispatcher/test/worktree-reclaim-concurrency.integration.test.mjs`) and pinned there as an `it.fails(...)` case pending its fix:**
  - `WorktreeManager.reconcileStartup()` only recovers an `active`/`review` entry if the path is entirely missing or the recorded worker pid is dead; it never checks whether an existing path is still a real, intact Git worktree. A worktree whose content is wiped out from under a still-alive process (the exact incident observed while working MOV-195/197) goes undetected. See MOV-202.
