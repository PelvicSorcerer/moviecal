# Local Mac execution

Read `AGENTS.md` first. This document covers the local-Mac execution path: how a Linear work item becomes a running agent in an isolated git worktree on this machine, and what every worker (human or agent) needs to know about that environment. It replaces the former per-platform operator guides (`claude-code.md`, `codex.md`) and the cloud-orchestrator model (`codex-orchestration.md`, `multi-platform-dispatch-policy.md`), which are retained under `docs/operators/archive/` as historical reference.

> **This is the Mac execution adapter's operator guide — one of two adapters, not the whole execution model.** `docs/governance/hybrid-execution-architecture.md` is the authoritative architecture: Linear owns desired lifecycle state, GitHub owns delivered state, and eligible non-iOS work may route to a Linear-managed **cloud** adapter instead of this one. Everything below remains accurate and current for the Mac lane, which is permanent — iOS/Xcode work can only run here. `MOV-141` found the cloud adapter plan-eligible but operationally unproven; `MOV-153` is its configuration and disposable-PR gate. Until that passes, this is the only live adapter.

See `docs/governance/linear-information-architecture.md` for the Linear workspace design this path is driven by, and `docs/operators/worker-routing.md` for how a worker binary and model are selected per issue.

## What changed from the cloud-agent model

The previous system assumed agents ran in degraded cloud containers: no `gh` CLI, GitHub GraphQL blocked by a network proxy, no Docker, no persistent local state. None of that applies here. This Mac has a full `gh` install, direct GitHub API access, a real filesystem, and a real process supervisor. Do not carry forward workarounds written for that constrained environment — they produce strictly worse behavior locally (e.g. avoiding `gh` in favor of a comment-command workflow when `gh` is simply available).

**Not to be confused with the new cloud adapter.** The "cloud-agent model" retired above is the old multi-platform GitHub-Project-era arrangement (Cursor Cloud, Copilot, cloud Codex) — a different thing from the Linear-managed Coding Session adapter introduced in `docs/governance/hybrid-execution-architecture.md`. The lesson that survives is narrow and still applies: never assume an execution environment's capabilities; both adapters are defined by an explicit contract and an explicit capability table, not by assumption.

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

## Automated promotion

`Ready for Agent` is filled automatically, not by hand (MOV-129), and the dispatcher now runs **priority propagation before promotion** (MOV-366). Poll-cycle order is:

1. `reconcileWorktrees`
2. `propagatePriorities` (`dispatcher priorities [--dry-run] [--once]`)
3. `promotePass` (`dispatcher promote [--dry-run]`)
4. dispatch scan over `Ready for Agent`

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
- every issue that `blocks` it is in a completed/canceled state (`Done`, `Released`, `Canceled`, `Duplicate`), resolved via the same `inverseRelations` data the dependency gate uses.

For a `Blocked` issue there is one extra condition: its most recent `**Dispatcher preflight failed:**` comment must name an unresolved-relation reason (now resolved). An issue blocked for any other reason — a missing secret, a worktree collision, a human's decision — is left alone.

On promotion the promoter comments `Auto-promoted to Ready for Agent — …` (which, via the app-actor identity from MOV-122, notifies the repo owner). It is idempotent: a promoted issue is no longer in `Backlog`/`Blocked`, so a second pass does nothing.

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
3. Not labeled `needs-secrets` unless the named local secret is actually present.
4. If the issue is in the **iOS Companion App** project: the self-hosted macOS runner (`moviecal-ios-runner`, labels `self-hosted, macOS, ios`) is online.
5. A concurrency slot is free (default: **1** simultaneous worktree). The Mac
   dispatcher is intentionally single-flight until a real nonblocking job
   supervisor can account for child process groups and resource limits.
6. `origin/master` is fetched.
7. The target worktree path is unused. This is also what makes overlapping poll cycles safe: a second cycle that sees the same issue collides here and reports `Blocked` rather than spawning a second worker. It is a real filesystem mutex — unlike the `Agent Working` state change, which is only a report (§Dispatch trigger).

## Worktree lifecycle

- **Path:** `~/code/worktrees/moviecal/<LINEAR-ID>-<slug>`
- **Branch:** `agent/<LINEAR-ID>-<slug>`, branched from `origin/master`
- The Linear issue identifier appears in both the path and the branch name, so ownership is always unambiguous from either side.
- Ownership is recorded in `~/.config/moviecal/worktrees.json`: identifier, branch, dispatcher/worker PIDs, worker, model, start time, Linear issue URL, and dispatcher/repository provenance. Writes use a fsync + rename transaction and retain a `.bak`; a malformed primary state file is recovered from that backup or the dispatcher refuses to mutate anything. Repair admission requires that provenance to match the live PR's same-repository head branch and SHA; legacy, fork, stale, and unknown branches fail closed.
- The mutating `dispatcher run` command takes `~/.config/moviecal/dispatcher.lock` using exclusive file creation. A second live instance exits without touching Linear, worktrees, branches, or registry state. A stale lock is reclaimed only when its recorded PID no longer exists.
- `.env.local` is a **symlink** to `~/.config/moviecal/env.local`, never a copy — one file to rotate, and no credential material ever lands inside a git-tracked tree.
- **Cleanup:** on merge, the worktree is removed and the remote branch deleted. On failure, the worktree is retained for 7 days for inspection, then pruned. `dispatcher gc` (also runnable manually) prunes stale entries and orphaned worktrees.
- **Reconciliation (`pr-reconcile.mjs`):** once a worker's PR is found, the worktree entry records `prNumber`/`prUrl`/the issue's Linear id alongside its `"review"` status. Every `dispatcher run` poll cycle (via `cmdRunOnce`, before processing new issues) sweeps every worktree in `"review"` and checks its PR's real state (`gh pr view <n> --json state,mergedAt`): merged → marked `"merged"` (so the next `gc` cleans it up); closed without merging → marked `"abandoned"` (7-day retention path, same as a worker failure). Before this existed, a merged PR's worktree just sat there indefinitely — nothing watched it after `"review"` — and had to be cleaned up by hand (found during `MOV-117` cleanup, fixed by `MOV-118`).
- **Linear outcome backstop (MOV-152).** Linear's own state generally transitions separately via the GitHub magic-word sync (a real closing keyword, e.g. `Fixes MOV-123`, in the PR body) once merged — but that sync is external and can fail, lag, or (for a closed-unmerged PR) simply never run at all, since GitHub has no magic word for "closed without merging". `reconcileReviewWorktrees` backstops both cases when it has a live Linear credential: on a MERGED PR it re-reads the issue's current state and idempotently moves it to `Done` only if the magic-word sync hasn't already done so (no duplicate writes or comments if it's already terminal); on a CLOSED-unmerged PR it always leaves an evidence comment (PR link, branch, why it wasn't merged) and, unless the issue is already in a terminal state, moves it to `Needs Human Decision` — a closed-unmerged PR is inherently ambiguous (abandoned vs. superseded vs. intentionally rejected), so this never guesses an outcome, only escalates. A worktree entry that transitions to `"merged"`/`"abandoned"` without yet confirming the Linear side (`linearSynced` unset) is retried on every subsequent poll cycle regardless of its worktree status, so a transient Linear API failure delays the backstop rather than losing it; a failure on one entry is isolated and does not block reconciling the rest of that pass's entries. Without a live Linear credential (e.g. `dispatcher run` invoked before `doctor` would pass), only the worktree-bookkeeping half above runs — the Linear backstop simply picks up on a later cycle that has one.
- Every dispatcher-created implementation PR is required (via `brief.mjs` and `.github/pull_request_template.md`) to carry a real Linear closing keyword (`Fixes MOV-NNN`, not a bare `MOV-NNN`) — a bare identifier reference never triggered Linear's GitHub-integration sync in the first place, which is the gap the backstop above exists to cover for the cases where even a correct magic word doesn't sync in time.
- **One completion issue per PR chain.** A merged PR linked to a Linear issue can move that issue to `Done` even when it is only an intermediate member of a GitHub PR stack (observed on MOV-145/#357 on 2026-09-10). Do not split one implementation issue across multiple PRs that all identify or attach to that issue. If a change must be delivered as a stack, create one Linear sub-issue per mergeable PR and reserve the parent/final completion issue for the last PR; dependency relations carry the merge order. If an intermediate merge nevertheless closes the final issue, reopen it to `In Review` immediately and record the remaining PR in a Linear comment.
- **Crash recovery:** startup reconciles every nonterminal registry entry. A missing worktree or an active entry whose recorded worker PID is gone is marked `abandoned` with a recovery reason for human/Linear follow-up. Review transitions are conditional on the entry still being in `review`, so a reconciliation pass cannot overwrite a newly active worker record.

### Resource contention policy

The Mac adapter has one dispatcher slot by default. Heavy Xcode builds/tests,
the iOS Simulator, and the self-hosted `moviecal-ios-runner` are treated as a
single scarce resource pool: do not run them concurrently with another local
worker, and do not raise `MOVIECAL_CONCURRENCY` to bypass that policy. The
runner's online status is a preflight gate, but it is not a second execution
slot. If a future supervisor can queue and cancel process groups without
leaving `xcodebuild`, `simctl`, or npm descendants behind, this section and
`DEFAULT_CONCURRENCY` may be revised together with tests proving the new
semantics.
- Agents must not commit directly to `master`, and never operate outside their assigned worktree.

## Worker interface

A worker is any binary satisfying: *given a repo path, a branch, and a brief on stdin, produce verified filesystem changes in that worktree and exit 0.* Concretely, `claude -p --model <id>` or `codex --sandbox workspace-write --ask-for-approval never exec`. A worker cannot execute Git, push, open/edit a PR, or receive GitHub mutation authority. After it exits, the dispatcher audits the structured tool transcript, assigned branch, base diff, and dirty paths; only a clean audit reaches `worker-publish.mjs`, which stages and commits the accepted changes, performs a non-force push of exactly the assigned branch, and finds or creates its draft PR. Adding a third worker means satisfying this same boundary, not writing a new operator guide or merge path.

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
| Worker fails or hits a hard-deny action | State → `Blocked` or `Needs Human Decision`; comment with the last ~50 log lines and the run-log path |
| Worker hits the nested-sandbox-crash signature (MOV-180, see §Security model) | State → `Ready for Agent` (requeued, **not** `Needs Human Decision`); comment naming the exact cause, that it is environment-wide rather than issue-specific, and that dispatch is paused until the breaker clears |
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

**Today, surface 2 is always the one that runs, and that is the supported
configuration.** `MOV-141` found Agent Sessions **disabled** for the
`moviecal-dispatcher` app: enabling them requires the OAuth app to subscribe to
Agent Session events and expose a reachable HTTPS receiver, which the local Mac
must not do. `MOV-159` is the decision gate for whether a signed relay is worth
its attack surface; `MOV-166` owns any live enablement and validation. See
`docs/governance/mov-141-linear-capability-findings.md`.

The layer is therefore off unless `MOVIECAL_AGENT_SESSIONS` is explicitly set,
and off is not a degraded mode — it is the complete operational lifecycle. With
it on and the app still unentitled, the dispatcher makes exactly **one** failed
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
- **Agent Session `stop` payloads** — the low-latency path, unavailable today.
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

**There is no inbound listener, receiver, relay, port, or webhook secret**, and
`tools/dispatcher/test/dispatcher-wiring.test.mjs` asserts structurally that
none appears. To exercise the inbound half, replay a saved payload:

```
dispatcher agent-signal --fixture tools/dispatcher/fixtures/agent-session-stop.example.json
```

That command is read-only: it normalizes the payload, applies the trust policy,
runs it through the stop controller twice to show the replay is a no-op, prints
what would happen, and mutates nothing. The example fixture is hand-written from
Linear's published preview docs — not captured from a live delivery, because
there is no receiver to capture one with.

**Prompt trust.** A follow-up prompt is trusted only when it comes from a real
workspace user, and never from this dispatcher's own actor (an agent acting on
its own emitted activity is a feedback loop, not a follow-up). A **stop** is
deliberately *not* subject to that policy: refusing to stop because the
requester was not on an allowlist is the wrong failure mode. Stops are always
honoured; only instructions need trust.

## Security model

**What's actually GitHub-enforced today (verified 2026-09-04, ruleset last updated 2026-09-08):** direct pushes to `master` are rejected at the git protocol level (`GH013`); force-push and branch deletion are blocked; merging requires going through a PR with `lane-baseline`, `lane-unit`, `lane-integration`, `lane-browser`, and (since MOV-119) `lane-review` all passing; `bypass_actors: []` means even the repo owner can't override this via GitHub's admin-merge option. None of that depends on a worker reading a file — it's the `master-protection` ruleset (see `docs/technical/`), and GitHub itself rejects the attempt regardless of who or what makes it. An agent never runs `gh pr merge --admin`; it enables GitHub auto-merge and lets the ruleset gate the actual merge.

**What is *not* yet GitHub-enforced, and is honest to name as a gap:** `master-protection`'s `pull_request` rule sets `required_approving_review_count: 0` (see `docs/planning/decision-log.md` Stage 9/9b) — every PR today is authored under the repo owner's own GitHub credentials, and GitHub blocks a PR author from approving their own PR, so requiring a review today would deadlock the queue rather than add scrutiny. This is deliberately **not** being fixed by adding a formal review-approval step: GitHub's own Copilot code review never posts an "Approve", specifically so it can't satisfy `required_approving_review_count` — a same-family bot approving its own sibling's PR would just be a rubber stamp under a different identity, not real independent scrutiny, and would need a second GitHub credential to provision and secure for no real gain. Instead, `MOV-116` adds an automated independent review pass as a **required status check** (`lane-review`, see below), the pattern proven at scale by Devin Review and CodeRabbit: fully unattended, no approval semantics, no second identity. `required_approving_review_count` stays `0` permanently under this design — there is no approval step to require.

**Worker enforcement boundary (MOV-145).** Claude and Codex now run behind the same technical boundary in `worker-guard.mjs`; prompt text and vendor-specific settings are not trusted as the authority:

- `worker-spawn.mjs` wraps either adapter in an inherited macOS Seatbelt profile. The profile denies execution of Git, `gh`, SSH transports, `curl`, and production-deploy entry points; denies reads of dispatcher/GitHub/SSH/npm credential stores (including the dev environment in repair mode); protects Git metadata and governance-controlled files; and prevents changes to dispatcher or shell credential configuration. The sanitized environment retains Claude's provider credential only in the Claude parent process and forces `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so Bash, hooks, and MCP servers do not inherit it; Codex receives no Claude credential. There is intentionally no unguarded fallback: if the OS or native adapter sandbox cannot be applied, the worker does not start, the issue moves to `Needs Human Decision`, and the dispatcher writes a checksummed failure audit (with the Linear comment as the backstop if local audit storage is unavailable).
- **`/usr/bin/security` is intentionally not denied (MOV-174), unlike the other listed binaries.** Claude Code's own startup unconditionally probes the macOS Keychain (`security find-generic-password -s "Claude Code-credentials"` / `-s "Claude Code"`) to resolve its provider credential — verified to happen regardless of whether `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` is already set in the environment. A blanket sandbox deny on this binary crashed every worker before it did any work (`EPERM` on `posix_spawn`, empty transcript), and neither alternative fix was viable: no credential env var suppresses the probe, and Claude Code's own `--bare` mode does avoid it but does not read `CLAUDE_CODE_OAUTH_TOKEN` — incompatible with running workers against a Claude subscription rather than pay-per-token Console billing. This is an accepted trade-off, not a closed gap: `security-policy.mjs`'s post-hoc transcript audit still hard-denies a worker's *own* `security find|dump|export|unlock|set|add|delete-` invocation, but that catches misuse after a read already happened, not before — there is no longer an OS-level block on a worker reading arbitrary Keychain entries by service name. **Operational caveat:** this credential lookup only succeeds while the Mac is logged in and the login Keychain is unlocked; if `launchd`'s `RunAtLoad` starts the dispatcher before that (e.g. immediately after a reboot, before anyone logs into the GUI session), worker dispatch fails with the same crash signature until login/unlock happens — this is expected given the design above, not a regression to re-investigate.
- Credential-shaped environment variables are removed and Git interactive/keychain helpers are disabled. Claude loads only the protected project policy, disables plugins/MCP/slash commands, and runs every Bash command in its fail-closed native filesystem/network sandbox with no unsandboxed escape hatch. Codex ignores user exec policy/config, runs ephemeral `workspace-write` with approval policy `never`, and keeps model-generated command network access disabled. These harness-native sandboxes prevent an allowed test/package script from becoming an indirect network bypass.
- Both adapters emit structured tool events. Output is redacted before being written to disk, then `security-policy.mjs` audits command attempts (including alternate GitHub API paths) while the diff audit catches protected changes regardless of command construction.
- Workers leave filesystem changes only. The dispatcher owns every Git and authenticated remote step, validates branch identity, stages and commits the audited result, confirms the worktree is clean, performs a non-force push with an explicit refspec, and creates or reuses the draft PR.
- Any missing audit, sandbox failure, bypass-shaped tool call, protected diff, branch mismatch, or publication-gate failure moves the issue to `Needs Human Decision` and records a checksummed `security-audit.json` plus a Linear evidence comment. No workflow application or remote mutation follows a failed audit.

**Nested-sandbox crash — recognized failure signature and manual recovery (MOV-180).** A distinct failure mode from the one above: `sandbox-exec: sandbox_apply: Operation not permitted`, exit code 71, on a worker's very first sandboxed subprocess call (even a trivial one like `echo`), with every subsequent attempt in that run — and from a freshly spawned subagent — failing identically. Root cause is macOS Seatbelt not supporting nested confinement: `worker-guard.mjs`'s `guardedInvocation` already wraps the worker process itself in one `sandbox-exec` profile (see above), and a process already confined by Seatbelt cannot apply a second `sandbox_apply` to its own children — so if the worker's own tool harness also tries to sandbox its child commands, the OS refuses the second application outright. This has been observed to affect every worker dispatched while it holds, not just one issue (confirmed on [MOV-172](https://linear.app/moviecal/issue/MOV-172) and [MOV-173](https://linear.app/moviecal/issue/MOV-173)'s concurrent runs, 2026-09-11), and is host-wide rather than issue-specific — re-running the same issue here will not help.

The dispatcher recognizes this exact signature (`run-loop.mjs`, via `failure-classification.mjs`'s `classifyWorkerFailure()`) as its own failure class, distinct from an ordinary task failure, a rate-limit result, or a credential failure: it requeues the issue to `Ready for Agent` with a comment naming the cause instead of leaving it in `Needs Human Decision` looking like a real per-issue failure, and trips a persisted circuit breaker (`circuit-breaker.mjs`, `~/.config/moviecal/circuit-breakers.json`) that stops the dispatcher from starting any further issue until a subsequent worker run completes without hitting the signature again (mirroring the breaker shape [MOV-177](https://linear.app/moviecal/issue/MOV-177) uses for a dispatcher-credential failure). This detection is post-hoc, not preventive: whether the nested-`sandbox_apply` collision itself can be avoided at the source depends on the worker harness's own sandboxing behavior, which is outside this repository's control.

**Manual recovery**, needed regardless of whether the breaker above has tripped, since the underlying condition does not clear itself: a clean unload-then-reload of the dispatcher's own launchd job.

```
launchctl bootout gui/$(id -u)/com.moviecal.dispatcher
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.moviecal.dispatcher.plist
```

**`launchctl kickstart -k` is not sufficient** — it has been observed to leave the same crash in place. `bootout` followed by `bootstrap` is a full unload and reload of the job, not just a process restart, and has been the only procedure confirmed to clear the condition (twice, in the same session that produced the confirmed signature above). Confirm recovery with `dispatcher doctor`'s "worker safety sandbox" check before assuming the Mac is healthy again.

Repair mode is stricter: tests, test-runner configuration, dispatcher code, staged workflow proposals, and governance documentation are read-only. CI logs, PR bodies, diffs, and review comments are delimited as untrusted data by `generateRepairEvidence()`; they can inform a code fix but cannot alter the fixed mode, target, attempt budget, or tool authority. `validateRepairTarget()` admits only a retained `review` worktree whose dispatcher-owned provenance matches the configured repository and the live PR head repository, branch, and observed SHA. Forks, stale heads, and unknown branches are never repaired automatically.

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

It ran informationally (not required) for its first several PRs before being promoted: zero false positives across 8 PRs, spanning docs-only changes, dispatcher-internal code, and one substantial real app-code PR (`MOV-104`/#281, 711 additions across 15 files) — every `pass` was legitimate and every `block` was a genuine workflow-file touch (`#272`, `#279`, `#281`'s applied-workflow commit). The AI layer's first live run (`ANTHROPIC_API_KEY` was configured partway through, on `#281`) produced two well-calibrated non-blocking `warn`-level findings (a placeholder bundle identifier, a hardcoded simulator destination) rather than overreaching to `block` — exactly the "flag, don't overreach" behavior it's designed for. On that evidence, `lane-review` was added to `master-protection`'s required status checks (now 5 of 5, alongside `lane-baseline`/`lane-unit`/`lane-integration`/`lane-browser`) via a direct `PUT` to the ruleset API — a repo owner action, not something the dispatcher or a worker ever does (ruleset/branch-protection changes stay on the hard-deny list unconditionally, see below).

**Credentials** — none live in the repository:

| Credential | Location | Scope |
|---|---|---|
| GitHub | `gh` keyring auth on this Mac | already scoped |
| Linear API key | `~/.config/moviecal/linear.env` (mode 600) | scoped to team `MOV` |
| Linear app-actor credential | `~/.config/moviecal/linear-app.env` (mode 600) | OAuth2 Client Credentials for the `moviecal-dispatcher` workspace identity (MOV-122); keys `LINEAR_APP_CLIENT_ID`, `LINEAR_APP_CLIENT_SECRET`, `LINEAR_APP_ACTOR_ID`, `LINEAR_APP_SCOPES` (`read,write,app:assignable,app:mentionable`). Optional during the transition — when absent the dispatcher falls back to the personal API key above. |
| Test `.env.local` | `~/.config/moviecal/env.local` (mode 600) | disposable/dev Supabase + TMDb credentials only |
| `SUPABASE_DB_URL_PROD` | GitHub Actions secret | never available to a local worker |

**Hard deny — the dispatcher refuses and escalates to `Needs Human Decision`:**

- Force-push anything; push to `master`; delete a branch other than its own
- Modify `.github/workflows/**`, GitHub rulesets, or branch protection
- `gh secret set`; echo any env var matching `*KEY*|*TOKEN*|*SECRET*|*PASSWORD*`
- Any command referencing `SUPABASE_DB_URL_PROD`; `supabase db reset`
- `vercel --prod`; `gh release create`; `npm publish`
- Edit `AGENTS.md`, `.github/copilot-instructions.md`, or `docs/product/**`

The hard-deny list is enforced before, during, and after the model process: OS sandbox/credential removal prevents the capability, structured-command auditing records attempts, and diff/publication gates stop any result that violates the protected path or branch contract. `.claude/settings.json` mirrors the remote-mutation denies so Claude refuses early too, but correctness no longer differs by adapter or depends on that file being impossible to bypass.

Two operational prerequisites for a Claude worker to run headlessly at all, discovered and confirmed empirically while wiring this up:

- **Workspace trust.** Claude Code refuses to apply `.claude/settings.json` in an untrusted workspace. This is anchored to the repository's **main checkout path**, not to whichever worktree a session runs from: trusting a linked worktree's own path did *not* stop the "workspace has not been trusted" warning for a `-p` session run from it; trusting the main checkout did, and that one grant covers every worktree of the repo. `WorktreeManager.create()` (`tools/dispatcher/src/worktree-manager.mjs`) pre-trusts both the new worktree's own path and the discovered main-checkout path (via `mainWorktreePath()`, parsed from `git worktree list --porcelain`) using `tools/dispatcher/src/claude-trust.mjs`'s `trustWorkspace()` — a careful read-modify-write of `~/.claude.json` that touches only the one project key, preserving everything else. This is safe specifically because it only ever runs on paths the dispatcher itself just checked out from this same repository, never an arbitrary path. Failure is non-fatal and logged: an untrusted workspace still fails cleanly rather than hanging (see below).
- **A current login.** The `claude` CLI's own login must be valid (`claude` then `/login` if expired) — this can only be done interactively, never by an agent.

**Staged workflow-edit proposals (MOV-121, added 2026-09-08).** `Edit(.github/workflows/**)` in the hard-deny list above is never lifted, for any issue, ever — that stays exactly as strict as documented. But some legitimate issues (e.g. a CI-cutover task like `MOV-104`, converting `ios-verify.yml` from bootstrap no-op to real `xcodebuild`/XCTest CI) genuinely need to change a workflow file as their whole point, and the repo owner wants issues like that handled fully by an agent in one PR, not split into "agent scaffolds, human hand-applies the CI diff." A permission carve-out can't do this safely: rules are evaluated deny-then-allow with **deny always winning regardless of specificity** (verified above), so a narrower "allow this one file" rule layered on top of the blanket deny would be silently ignored — and even removing the blanket deny and denying every *currently-existing* workflow filename individually leaves a gap, since a worker could create a brand-new file under `.github/workflows/` that wouldn't match any of the enumerated denies.

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

**Commands** (see the template's own header comment for the full list):

```
launchctl load ~/Library/LaunchAgents/com.moviecal.dispatcher.plist     # start
launchctl unload ~/Library/LaunchAgents/com.moviecal.dispatcher.plist   # stop
launchctl list | grep com.moviecal.dispatcher                          # status
launchctl kickstart -k gui/$(id -u)/com.moviecal.dispatcher             # restart (e.g. after a git pull)
```

The plist's own `StandardOutPath`/`StandardErrorPath` (`~/Library/Logs/moviecal-dispatcher/dispatcher.std{out,err}.log`) capture only the dispatcher process's own top-level output — per-worker logs are still under `~/Library/Logs/moviecal-dispatcher/<LINEAR-ID>-<slug>/` as described above. `KeepAlive.SuccessfulExit: false` restarts the process on a crash or nonzero exit but not on a clean exit; `ThrottleInterval: 30` caps restart frequency if it's crash-looping.

**PATH.** launchd runs jobs with a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), not the interactive shell's `PATH`. `ProgramArguments` invokes node via an absolute path so the daemon process itself starts, but every child process the dispatcher or its workers spawn — `gh`, `npm`, `codex` (`/usr/local/bin`), `claude` (`~/.local/bin`) — fails with `ENOENT` unless the plist sets `PATH` explicitly. The template's `EnvironmentVariables` dict does this (`__HOME__/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`); keep it when filling in the installed copy. `dispatcher doctor` passing from an interactive shell does **not** prove the daemon's environment is correct — an interactive shell has a fuller `PATH` than launchd gives the job, so `doctor`'s `gh`/`claude`/`codex` checks can pass there while the running service still fails on the same lookups. After any `launchctl load`, confirm the service itself is working (check `dispatcher.stderr.log` and a run-log directory for a completed poll cycle), not just that `doctor` is clean in your terminal.

## Standing health check

`dispatcher doctor` is a read-only command that asserts: Linear auth works, `gh` auth works, the worktree root is writable, `~/.config/moviecal/env.local` exists and is mode 600, `claude` and `codex` are on `PATH`, `origin/master` is fetchable, and the iOS self-hosted runner is reachable. It also prints the **local dispatch identity** — the delegate an issue must name to be claimed here (MOV-143) — and which **lifecycle publication surface** is configured (MOV-158), both informational rather than pass/fail gates. The Agent Session line reports configuration only: the sole way to test entitlement is `agentSessionCreateOnIssue`, which is a mutation, and `doctor` never mutates. If `~/.config/moviecal/linear-app.env` is present it additionally checks the file is mode 600 and that an app-actor token can be minted from it (MOV-122); if it is absent that check is a no-op pass. Run it after any environment change and before relying on the dispatcher for real work.

## Known gaps / follow-ups

- Dispatch is currently poll-based (default 30s interval, `dispatcher run [--interval ms]`), and so are the stop controls (§Stop controls). Webhook-driven dispatch is **blocked on an architecture decision, not on implementation**: the dispatcher-side contract for Linear Agent Sessions is built and feature-gated (MOV-158), but Linear requires a reachable HTTPS receiver the local Mac must not expose. `MOV-159` decides whether a signed relay is worth its attack surface; `MOV-166` owns live enablement and validation if it is. Polling remains the complete lifecycle either way.
- The Agent Session mutation shapes in `linear-client.mjs` have never been exercised against a live session (MOV-141: `agent sessions disabled`). They are unverified until `MOV-166`; every path through them is non-fatal and falls back to comments.
- **Backfill is an operator task, not a code task.** MOV-143 makes `execution:mac` + the `moviecal-dispatcher` delegate hard preconditions, so any queued issue missing either one stops being dispatched the moment the daemon restarts onto this code. Run `dispatcher dry-run` first: it lists every `Ready for Agent` issue with its route, delegate, and eligibility, and ends with an `Executable on this Mac: n/m` line. Apply the missing labels and delegations before restarting the service.
- The delegate match accepts the app's workspace *name* as well as `LINEAR_APP_ACTOR_ID`, because that variable currently holds the name rather than the actor UUID. That is looser than an id-only match by design (see `dispatch-eligibility.mjs`); setting the variable to the real actor UUID tightens it without any code change.
- `dispatcher run` is implemented and unit-tested against every outcome (preflight block, routing block, worker success, worker failure, worker exits 0 with no PR and a clean worktree, worker exits 0 with no PR and an `abandoned-dirty` worktree, spawn error), but has not yet been exercised against the live Linear workspace — that first real run is migration Stage 10 (end-to-end verification), tracked in `docs/planning/decision-log.md`.
- Docker is not installed on this Mac, so `npm run lane:real-stack` / `lane:full-stack` stay CI-only locally; use the `supabase-verify` GitHub Actions workflow as the authoritative DB gate.
- MOV-115 (two-way GitHub sync) is **done** — see `docs/governance/linear-information-architecture.md` §GitHub Issues: migration and ongoing sync.
- MOV-116 (an automated `lane-review` status check for independent PR scrutiny, plus wiring `security-policy.mjs`'s hard-deny list into real enforcement) is partially done — see §Security model above. `lane-review` is now a required status check (MOV-119); the hard-deny-enforcement half is still unresolved.
