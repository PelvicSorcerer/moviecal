# Local Mac execution

Read `AGENTS.md` first. This document covers the local-Mac execution path: how a Linear work item becomes a running agent in an isolated git worktree on this machine, and what every worker (human or agent) needs to know about that environment. It replaces the former per-platform operator guides (`claude-code.md`, `codex.md`) and the cloud-orchestrator model (`codex-orchestration.md`, `multi-platform-dispatch-policy.md`), which are retained under `docs/operators/archive/` as historical reference.

> **This is the active execution adapter's operator guide.** `docs/governance/hybrid-execution-architecture.md` is the authoritative architecture: Linear owns desired lifecycle state, GitHub owns delivered state, and the Mac dispatcher is the only enabled implementation adapter. Linear Coding Sessions are isolated in **Deferred Linear cloud execution option** and remain `Icebox`; they are not a dependency or default for non-iOS work. iOS/Xcode work is permanently Mac-only.

See `docs/governance/linear-information-architecture.md` for the Linear workspace design this path is driven by, and `docs/operators/worker-routing.md` for how a worker binary and model are selected per issue.

`dispatcher dry-run` also prints each planned worker invocation, including Claude's effective `--effort` when supported. An invalid Claude effort override is reported as a routing error before a worker or worktree is started. `dispatcher doctor` reports when a Haiku 4.5 model causes an effort override to be omitted; see the tier table in `docs/operators/worker-routing.md`.

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
**The match is on the exact literal command text.** Codex's fixed `/bin/zsh -c 'npm run verify'` (or bash/sh equivalent) transcript wrapper is accepted only when its payload is exactly that literal command; pipelines, substitutions, redirects, and compound commands remain incomplete evidence. A worker that pipes,
redirects, or wraps the command (`npm run verify 2>&1 | tail -300`, `npm run
verify || true`, and similar) to shorten its own output produces a transcript
event whose command no longer matches `npm run verify` exactly, so it is
credited as no durable evidence at all — even though verification genuinely
passed (MOV-274's autonomy-pilot blocker). The worker brief (`brief.mjs`)
tells every worker, implementation and repair alike, to run the command
verbatim and names this consequence; there is no leniency to add on the
evidence-capture side without weakening the fail-closed contract MOV-275
built.

Both implementation and repair briefs give workers focused Vitest, typecheck,
and lint commands for their editing loop. They instruct workers to run the
literal `npm run verify` when they believe the change is complete, and to use
focused checks before retrying if it fails. Evidence capture still requires
every exact verify run to pass; a failed intermediate run disables PR autonomy
for that attempt. See [focused checks](../planning/testing-lanes.md#focused-checks-while-editing)
for the commands.

Dispatcher code lives in `tools/dispatcher/` in this repository (TypeScript, using the repo's existing Node 24 + Vitest toolchain). Runtime config lives outside the repo at `~/.config/moviecal/` (mode 700) — API keys and `.env.local` must never be committed. Run logs live at `~/Library/Logs/moviecal-dispatcher/`, retained 90 days.

### Final routing refresh and evidence

Immediately before claiming a worktree, worker/model overrides and upgrade
conditions must still match the polling snapshot (MOV-397). A changed or
invalid selection returns `deferred-routing-change` without creating/resuming
a worktree, changing Linear state, posting a start comment, charging a trial
assignment, or spawning a worker. The next poll repeats all provider admission
gates; it does not substitute a worker after cooldown/probe/trial admission.
Existing provider bindings and retained-worktree ownership checks still apply.

The trusted dispatcher appends bounded decisions to
`~/Library/Logs/moviecal-dispatcher/<issue-worktree-name>/routing-decisions.jsonl`,
including deferrals that produce no worker transcript. The record contains
poll/refreshed routing inputs and the selected worker, tier, effective model,
effort, turn budget, and selection reason. `spawn-requested` means the adapter
was asked to launch that invocation; use its transcript to confirm startup.
The evidence follows the run logs' 90-day retention. Evidence-write failures
are logged without weakening the routing guard. See
[worker-routing.md](./worker-routing.md#overrides) for the comparison rules.

### Worker usage accounting

After each implementation or code-repair worker exits, the dispatcher parses its structured stdout and writes `usage.json` beside that run's `stdout.log`. It also appends the numeric summary to `~/.config/moviecal/worker-usage.json`. Both files stay outside the repository. A failed or truncated transcript produces explicit `null` values and `partial: true`; accounting errors never block publication. The existing Linear PR-opened comment includes one compact `Usage:` line. Repair publication includes the same line.

The summary records the issue, attempt kind, worker, model ID, model tier, reasoning effort when passed, turns, duration in milliseconds, cost in USD, input and output tokens, cache-read and cache-write tokens, thinking tokens when reported, exit outcome, exact `npm run verify` invocation count, calls per tool, and approximate tool-result characters per tool. Tool and model names are bounded identifiers; command text, prompts, tool results, and secrets are never copied. Claude fields come from the final structured `result` event. Codex uses only the usage events it emits, so unsupported fields remain `null`. Claude Code's cost is an **API-equivalent estimate**, not an invoice: workers bill against the subscription.

Run `node tools/dispatcher/bin/dispatcher.mjs usage` for a read-only JSON report of the 20 most recent recorded runs plus per-tier and per-model medians and totals. This command reads only the usage state file; it does not contact Linear, GitHub, or a worker.

#### Trial export and real-run baseline (MOV-382)

`node tools/dispatcher/bin/dispatcher.mjs usage export --issue <MOV-N> [--issue ...] [--run <attemptId> ...] [--since <time>] [--until <time>] [--state <path>]` prints a read-only JSON export and writes nothing. At least one of `--issue`, `--run`, `--since`, `--until` is required; the filters AND together. The export lists each selected attempt (failed, partial, continuation, and repair attempts included), `excluded` and `unmatched` counts, a per-field `completeness` table (`reported`, `zero`, and `missing`, with `missing` split into `missingNotReported` for a truncated or absent event and `missingNotExposed` for a counter the provider CLI never emits), and a per-issue, per-worker `byIssue` roll-up. Sums cover reported values only and are `null` when nothing was reported, never zero.

Only records the live dispatcher wrote under the current schema (`origin: "dispatcher"`, with a unique `attemptId`) are selected by default, so historical fixture-like rows never enter a trial baseline. `--include-legacy` opts them in. History is never deleted or rewritten. An attempt is recorded once per `attemptId`, so an implementation plus its continuation or repair is summed per issue without double counting; `attemptKind` distinguishes `implementation`, `continuation`, `resume`, and `repair`. Token sums are kept per worker and never mixed across harnesses.

**Routed-request accounting (MOV-426).** Each attempt's `usage.json` also carries `routedRequests` (the bounded per-request records folded from that attempt's `routing-decisions.jsonl`, see `docs/operators/worker-routing.md` §Per-request routed accounting) and `routedInvoice`, its rollup for that attempt. The export's per-issue `byIssue[].routedInvoice` sums every attempt kind for that issue exactly once, deduplicated by request ID, and reports `apiEquivalentUsd` and `billedUsd` as separate sums -- a Claude-style API-equivalent estimate versus the actual provider-billed dollars -- never combined into one figure. No live router arm exists yet; every field is `null`/empty until MOV-427/MOV-428 wire one up, and this accounting never invents a served model, effort, or charge the router did not report.

Fields carry provenance: `modelId`/`modelSource` (invocation vs provider-reported), `reasoningEffort` from the exact spawned argv, `startedAt`/`endedAt`/`wallDurationMs` from the run manifest, `exitOutcome`, `terminationReason` (`turn-budget`, `timeout`, `stopped` when the dispatcher ended the worker), `usageEvents`, and `usageAggregation`. Claude records also carry `startupCheck` (MOV-386). It compares the effective permission mode and tool set from the worker's `system/init` event with the requested ones (see §Security model); Codex records set it to `null`.

**Token and cost semantics.** Counters keep each provider's own definition. Codex `input_tokens` already **includes** `cached_input_tokens`; do not add cached tokens to input again. Claude's `input_tokens` excludes cache reads and cache creation, which are reported separately. Codex exposes no cost and no cache-write tokens, and only newer builds report reasoning tokens; those stay `null`. `costUsd` is Claude Code's **API-equivalent** figure (`costSource: "claude-reported-api-equivalent"`); workers bill against subscription limits, so it is not an invoice. `costEstimateUsd` is a separate, currently always-null slot for any derived estimate: no price is derived from aggregate totals, because per-request context length (for example a Sol price tier above 272K) cannot be recovered from run totals. Multiple Codex `turn.completed` usage events are treated as running-total snapshots: the last one is the run total, a verbatim repeat is ignored, and a decreasing counter starts a new segment so the earlier one is banked rather than lost (`usageAggregation` records which rule applied).

**Turns are not comparable across harnesses.** Claude's `num_turns` counts model-request/tool round trips inside one session; Codex's count is the number of `turn.completed` events, and a Codex turn can span many tool calls. `turnsSource` names the unit, and `budgetUnit`/`budgetCount` give the unit the run budget was counted in (`claude-assistant-turns` or `codex-items`). Compare duration and accepted issue outcomes across workers, and compare turns only within one worker.

**Baseline validation procedure.** (1) Point `MOVIECAL_CONFIG_DIR`, `MOVIECAL_LOG_ROOT`, and `MOVIECAL_WORKTREE_ROOT` at a temporary directory (absolute path) and run one short disposable worker attempt through the dispatcher, or capture a redacted `codex exec --json` stream and a Claude `result` by hand. (2) Compare `stdout.log` with that run's `usage.json`: model, effort, IDs, timing, and each reported counter must match, and each unreported counter must be `null`. (3) Run `usage export --run <attemptId> --state <temp>/worker-usage.json` and confirm the same values and completeness counts. (4) Confirm any sentinel live ledger is byte-for-byte unchanged. The Vitest lanes set these variables to a throwaway directory automatically, so fixtures cannot reach the live ledger. Provider-shaped fixtures in `tools/dispatcher/test/usage-fixtures.mjs` are documented shapes, not live captures; replace them with the redacted real stream from step (1) if the CLI differs, and in particular confirm whether Codex usage is cumulative.

### Turn budget and fresh-context continuation (MOV-367)

Each implementation attempt has the tier budget in `docs/operators/worker-routing.md` (`MOVIECAL_TURN_BUDGET_<TIER>` overrides). The dispatcher counts live Claude assistant messages (`claude-assistant-turns`) or completed Codex work items (`codex-items`, MOV-387; `codex exec` reports a whole run as one `turn.completed`). Codex has its own per-tier budgets (`MOVIECAL_CODEX_TURN_BUDGET_<TIER>`), and usage records and the handoff comment name the unit. The Codex continuation has no wrap-up prompt, so its brief says no progress file may exist and relies on the diff summary. At 85%, when Claude steering is enabled, one prompt asks the worker to stop exploring, make the worktree consistent, and write `WORKER_PROGRESS.md` with completed work, remaining work, and the next step. Steering off means no wrap-up prompt. A run below its budget follows the ordinary lifecycle without a budget comment. A worker that was sent the wrap-up prompt, wrote `WORKER_PROGRESS.md` and then exited 0 before the hard stop has declared itself out of budget, so it is treated as a budget stop and takes the continuation path instead of publishing incomplete work.

At 100%, the same process-group reap used for timeouts stops the worker. The dispatcher keeps the branch and worktree and does not commit, push, or open a PR from that attempt. After its security audit and the existing credential and provider-limit classifications, it rechecks the retained worktree's dispatcher ownership, registry provenance, branch, repository, and integrity. If admitted, it starts exactly one new process with the same worker, branch, worktree, and a full fresh budget. The continuation brief includes a bounded, redacted excerpt of `WORKER_PROGRESS.md` when present, a diff summary, and the prior run's usage. A missing progress file is expected when steering was off or the worker was reaped before it could write one; the continuation still starts. Both processes appear in per-run usage accounting; the observed live turn count is retained even when a reaped transcript has no final result event. The wall-clock timeout still applies to each process independently, and provider usage limits keep their separate deferral rules.

If that continuation also reaches its budget, or the retained worktree cannot be admitted safely, the issue moves to `Needs Human Decision`. One handoff comment gives the budget and per-attempt usage, latest exact-verify outcome, changed paths, a bounded and redacted progress excerpt or explicit missing-file note, and the retained worktree path. There is no third budget continuation. `WORKER_PROGRESS.md` is dispatcher handoff data: the dispatcher removes it before auditing a successful result, and trusted publication excludes and refuses it if staged. Human testing is required for MOV-367 itself using the disposable fixture steps in its Linear issue before its draft PR is promoted for review.

### Temporary `worker:any` → Codex trial (MOV-383)

Fresh `worker:any` issues request Claude by default; MOV-395 selects another available worker when the requested worker is cooling down or its reset probe is reserved for another issue. A bounded, disabled-by-default trial can temporarily send them to Codex while preserving each issue's tier and pinned model/effort; the full policy, states and rollback are in `docs/operators/worker-routing.md` §Temporary `worker:any` → Codex trial. Operationally:

- **Activate** (only after Adam releases MOV-384, and record it on that issue): `node tools/dispatcher/bin/dispatcher.mjs trial activate --id <trialId> --expires <future ISO UTC, at most 14 days> --max-assignments <1-30>`. Inspect with `trial status`, `dry-run` or `doctor`. The config is `~/.config/moviecal/worker-trial.json`; assignments are `~/.config/moviecal/worker-trial-assignments.json`.
- **Early stop:** `node tools/dispatcher/bin/dispatcher.mjs trial stop`. It needs no daemon restart and does not take the run lock; it disables only future assignments and keeps every record and every running attempt.
- **Admission and the cap.** The run loop, which holds the singleton dispatcher lock, admits each fresh assignment immediately before creating its worktree, re-reading expiry and the cap then. The ledger is keyed by issue identifier, so a restart or a duplicate/retried admission returns the existing record and never consumes a second slot. A Codex cooldown sends fresh trial-routed issues to available Claude without consuming a Codex trial assignment; a trial that ends between batch start and admission defers the issue (`deferred-worker-trial-ended`) to be re-resolved under the baseline on the next poll.
- **Retry behavior.** A retry, retained-worktree resume, budget continuation or PR repair of an already-assigned issue keeps the recorded worker/model/effort and attribution regardless of the trial state. An invalid active config reports `config-error` for fresh `worker:any` issues (they stay queued; no Claude fallback) and fails `doctor`.
- **Records.** Trial ID, requested worker, resolved worker, routing reason and assignment time appear in `manifest.json`, the worktree registry entry and the usage record/`usage export`.
- **Rollback.** `trial stop`, expiry, or cap exhaustion restores the Claude baseline for new claims. Already-assigned Codex issues finish on Codex; relabel `worker:claude` and requeue to move one.

### Bounded Jev router arm admission (MOV-427)

A separate, disabled-by-default admission ledger for the [MOV-422](https://linear.app/moviecal/issue/MOV-422) Jev router trial; the full policy, states, labels and rollback are in `docs/operators/worker-routing.md` §Bounded Jev router arm admission. **This build has no live routing** -- admitting an issue to a Jev arm never selects a worker, model, or provider, so `worker:*`/`model:*` dispatch above is completely unaffected. Operationally:

- **Activate** (requires Adam's separate credit/governance approval, and an already-approved `policyHash` hard-coded into `jev-trial.mjs` -- the list ships empty): `node tools/dispatcher/bin/dispatcher.mjs jev activate --id <trialId> --arm <jev-hosted|jev-oss> --policy-hash <approved-hash> --expires <future ISO UTC, at most 14 days> --max-assignments <1-12> --spend-ceiling-usd <up to 75>`. Inspect with `jev status`, `dry-run` or `doctor`. The config is `~/.config/moviecal/jev-trial.json`; assignments/spend are `~/.config/moviecal/jev-trial-assignments.json`.
- **Early stop:** `node tools/dispatcher/bin/dispatcher.mjs jev stop`. No daemon restart, no run lock; disables only future admissions and keeps every record.
- **Eligibility.** Only an issue explicitly labeled `router:jev`, without `human-only`, `risk:high`, or an `area:auth`/`area:security`/`area:database`/`area:deployment`/`area:migrations`/`area:secrets`/`security-sensitive` label, can be admitted.
- **Admission, the cap and the spend ceiling.** Admitted under the same dispatcher lock and at the same point as the worker trial above, immediately before the worktree is created, re-reading expiry, the 12-assignment cap and the spend ceiling each time. Non-blocking: an ineligible issue or an off/expired/exhausted/spend-exhausted/invalid arm simply dispatches unattributed under its ordinary route.
- **Records.** Trial ID, arm ID, approved policy hash, allowed worker and assignment time appear in `manifest.json`, the worktree registry entry, the usage record/`usage export`, and a bounded field on `routing-decisions.jsonl`.
- **Rollback.** `jev stop`, expiry, cap exhaustion, or the spend ceiling stops new admissions immediately; since routing itself is untouched in this build, no further rollback step applies to already-assigned issues.

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
- **The dispatcher prepares dependencies before every worker start (MOV-410/MOV-412).** Once the worktree is ready and before `spawnWorker()` runs, the dispatcher itself runs `ensureWorktreeDependencies()` (`tools/dispatcher/src/dependency-install.mjs`) in that worktree. This happens for every attempt that starts a worker: a fresh implementation, a usage-limit resume, a turn-budget continuation, an operator continuation and a repair. The install is a locked `npm ci --ignore-scripts` against the `package.json`/`package-lock.json` committed at HEAD. It runs outside the worker sandbox with a scrubbed environment, a bounded timeout and a completion marker, and it is a no-op (`status: "current"`) when the toolchain already matches the committed lockfile. For implementation, resume and continuation attempts, npm's process-group leader is recorded as the entry's `workerPid`, so startup recovery can kill it after a dispatcher crash. Repair retains the existing repair lifecycle; its installer has timeout and parent-signal cleanup but is not recorded in that startup-recovery slot. If the install fails or throws, **no worker starts**. An implementation attempt marks the worktree `failed` and moves the issue to `Needs Human Decision` with a blocker naming the reason, commit, lockfile hash and install log. A repair attempt records a failed repair in the ledger and hands the PR to a human; the entry keeps its `review` status so PR reconciliation still tracks the open PR. Workers never install dependencies themselves, and there is no worker-side fallback (§Security model).
- **Cleanup:** once a PR merges the worktree is retained for the terminal retention window (7 days by default, MOV-417) and then removed with its remote branch. On failure, the worktree is retained for 7 days for inspection, then pruned. `dispatcher gc` (also runnable manually) prunes stale entries and orphaned worktrees. **Requeue exception (MOV-181):** the 7-day retention window exists for human inspection, but moving the same issue back to `Ready for Agent` before that window elapses is itself the signal that inspection is done — so a preflight collision against that same issue's own terminal-status worktree reclaims it (§Preflight gates, gate 7) rather than blocking the retry. Only the local git worktree and its local `agent/*` branch are removed; the remote branch is left alone (a draft PR may still reference it), and `~/Library/Logs/moviecal-dispatcher/<id>/` — the actual forensic record (`stdout.log`, `stderr.log`, `security-audit.json`, `manifest.json`) — is untouched, since `git worktree remove` only ever touches the worktree's own files. **Dirty-worktree guard (MOV-185):** the MOV-181 reclaim above shipped without checking whether the retained worktree actually held unrecovered work — a real gap, surfaced by a 2026-09-14 near-miss where a worker (MOV-172) hit a rate limit mid-task and landed in `failed` with 44 turns of genuine, still-uncommitted implementation work sitting in the worktree; only a human manually noticing and committing/pushing it averted a silent `--force` removal on the next requeue. `WorktreeManager.isPathFreeForIssue()` now runs the same clean-check MOV-173 specifies for the sibling abandoned-worktree case before reclaiming: `git status --porcelain` (uncommitted/untracked changes) and a local-vs-remote-tracking-branch commit comparison (unpushed commits), no `git fetch` involved. A dirty terminal-status worktree is left untouched and the preflight collision still blocks, but with a specific reason (`reclaimBlockedReason()`) naming the worktree path and the kind of unsaved work found, instead of the generic "worktree path already in use" message every other collision case gets. A clean terminal-status worktree — the common case, since most failures happen before any file changes — is still reclaimed exactly as MOV-181 describes above.
- **Terminal-issue worktree retention (MOV-417).** `dispatcher gc` also inventories *every* Git worktree of this repository under the configured roots (`~/code/worktrees/`, `~/.codex/worktrees/`, and `worktreeRoot()`; override with a path-delimited `MOVIECAL_WORKTREE_ROOTS`), not only the ones in `worktrees.json`, and removes the linked checkout of an issue that is **Done or Canceled** once the retention window has passed.
  - **Preview:** `dispatcher gc --dry-run [--json]` reports, per worktree, its path, issue evidence, current Linear status, terminal timestamp, eligibility date, local-change state and the exact action or refusal (`would-remove`, `retained` until a date, `already-absent`, `skipped` with a reason code). It takes no lock and writes nothing (Git, Linear, registry, files); it needs a Linear credential to classify issues and otherwise reports every candidate as `linear-unavailable`.
  - **Live:** `dispatcher gc` takes the dispatcher's exclusive lock (exit 2 if the daemon or another operator holds it), then first runs the registry pass (merged/failed/abandoned entries past retention, unchanged mechanics) and then the terminal-issue pass. Each result is `removed`, `already-absent`, `retained` (until a date), `skipped` (reason) or `failed`; `--json` prints the same records machine-readably. Exit code 1 if any candidate `failed`. It is safe to repeat.
  - **Retention:** default 7 days, measured from Linear's *current* `completedAt` (Done) or `canceledAt` (Canceled) timestamp. Set `--retention-days N` or `MOVIECAL_WORKTREE_RETENTION_DAYS` (flag wins). The same value governs the registry pass, so a merged entry now also waits the window (from its `endedAt`; a missing timestamp retains it) instead of being removed the moment the PR merges, and failed/abandoned entries keep their existing 7-day-from-`endedAt` behaviour. The two clocks are independent: a failed worktree whose issue is later Done is removed by whichever pass reaches its window first, and neither pass ever removes work the safeguards below refuse.
  - **Identity:** a `MOV-NNN` in the directory name decides the issue. Otherwise an exact `agent/MOV-NNN[-slug]` branch, or the registry record for that exact path, may. A commit message or shared HEAD is never evidence; several ids, or sources that disagree, are reported as ambiguous and skipped. The primary checkout, the launchd daemon checkout (`MOVIECAL_DAEMON_CHECKOUT`, default `<worktreeRoot>/dispatcher-daemon`), the checkout the running command lives in, Git-locked worktrees, and anything outside the roots are never candidates.
  - **Fail closed:** a Linear error, missing/invalid/future timestamp, unknown issue, or a state other than exactly `Done`/`Canceled` skips the worktree. Before every deletion Linear is re-read and the live worktree re-inspected (the preview never authorizes anything), and a change of status or of checkout content during preservation aborts that removal.
  - **Never removed:** a worktree with an `active`/`review` registry entry for the issue, a live recorded PID, a pending usage-limit/worker continuation, a process with files open under it (`lsof`; if unknown, refused), or an unmerged index.
  - **No lost work:** staged, unstaged, untracked and unpushed work is preserved before removal in local refs `refs/moviecal/recovery/<MOV-N>/<head12>-<tree12>/{head,index,worktree}` (commits reachable from HEAD but from no remote, the staged state, and the full working tree) plus a `0600` recovery record in `~/.config/moviecal/worktree-recovery/`, verified before removal. Recovery refs are local only and never pushed; the record holds SHAs and counts, never file contents. To restore: `git worktree add <new-path> refs/moviecal/recovery/<MOV-N>/<key>/worktree` (or `.../head`); diff `head..index` for the staged part. Untracked files that look like credentials (`.env*` other than `.env.example`, `*.pem`, `*.key`, `.npmrc`, ...) are never snapshotted, so the worktree is kept. Ignored files are removed only when regenerable (`node_modules`, `.next`, `.turbo`, `coverage`, `dist`, `build`, `out`, `playwright-report`, `test-results`, `DerivedData`, `*.tsbuildinfo`, `next-env.d.ts`, `.DS_Store`, and the dispatcher's `.env.local` *symlink*); any other ignored file (including a real `.env.local`) keeps the checkout.
  - **Scope of removal:** only the linked checkout and its Git registration (plus a terminal registry record for that path). Branches, PRs, run logs, other worktrees and the primary repository are untouched. A missing checkout with a stale Git registration is unregistered (`removed`, code `removed`); a registry-only record for an absent path is reported `already-absent`.
- **Reconciliation (`pr-reconcile.mjs`):** once a worker's PR is found, the worktree entry records `prNumber`/`prUrl`/the issue's Linear id alongside its `"review"` status. Every `dispatcher run` poll cycle (via `cmdRunOnce`, before processing new issues) sweeps every worktree in `"review"` and checks its PR's real state (`gh pr view <n> --json state,mergedAt`): merged → marked `"merged"` (so the next `gc` cleans it up); closed without merging → marked `"abandoned"` (7-day retention path, same as a worker failure). Before this existed, a merged PR's worktree just sat there indefinitely — nothing watched it after `"review"` — and had to be cleaned up by hand (found during `MOV-117` cleanup, fixed by `MOV-118`).
- **Linear outcome backstop (MOV-152).** Linear's own state generally transitions separately via the GitHub magic-word sync (a real closing keyword, e.g. `Fixes MOV-123`, in the PR body) once merged — but that sync is external and can fail, lag, or (for a closed-unmerged PR) simply never run at all, since GitHub has no magic word for "closed without merging". `reconcileReviewWorktrees` backstops both cases when it has a live Linear credential: on a MERGED PR it re-reads the issue's current state and idempotently moves it to `Done` only if the magic-word sync hasn't already done so (no duplicate writes or comments if it's already terminal); on a CLOSED-unmerged PR it always leaves an evidence comment (PR link, branch, why it wasn't merged) and, unless the issue is already in a terminal state, moves it to `Needs Human Decision` — a closed-unmerged PR is inherently ambiguous (abandoned vs. superseded vs. intentionally rejected), so this never guesses an outcome, only escalates. A worktree entry that transitions to `"merged"`/`"abandoned"` without yet confirming the Linear side (`linearSynced` unset) is retried on every subsequent poll cycle regardless of its worktree status, so a transient Linear API failure delays the backstop rather than losing it; a failure on one entry is isolated and does not block reconciling the rest of that pass's entries. Without a live Linear credential (e.g. `dispatcher run` invoked before `doctor` would pass), only the worktree-bookkeeping half above runs — the Linear backstop simply picks up on a later cycle that has one.
- **Ready-state recovery (MOV-275).** GitHub synchronization may transiently regress a dispatcher-created issue from `In Review` to `Agent Working` after the sole allowed draft-to-ready action. The review sweep restores `In Review` only when its retained registry proves the exact dispatcher-owned issue, same-repository open PR, branch, and SHA that the ready action recorded. It touches only `Agent Working`, writes one recovery marker/comment, and is thereafter a no-op; unrelated review entries and workflow states are never normalized.
- Every dispatcher-created implementation PR is required (via `brief.mjs` and `.github/pull_request_template.md`) to carry a real Linear closing keyword (`Fixes MOV-NNN`, not a bare `MOV-NNN`) — a bare identifier reference never triggered Linear's GitHub-integration sync in the first place, which is the gap the backstop above exists to cover for the cases where even a correct magic word doesn't sync in time.
- **One completion issue per PR chain.** A merged PR linked to a Linear issue can move that issue to `Done` even when it is only an intermediate member of a GitHub PR stack (observed on MOV-145/#357 on 2026-09-10). Do not split one implementation issue across multiple PRs that all identify or attach to that issue. If a change must be delivered as a stack, create one Linear sub-issue per mergeable PR and reserve the parent/final completion issue for the last PR; dependency relations carry the merge order. Source each PR's `Linear: MOV-NNN` reference from the real sub-issue object, never PR text or a GitHub number. The parent must never be completed directly while a child is non-terminal; the MOV-172 reconciliation pass enforces and backstops this.
- **Crash recovery (MOV-173, MOV-254):** startup reconciles every nonterminal registry entry. A missing worktree or an active entry whose recorded worker PID is gone is marked `abandoned`, then reconciled with Linear in the same pass: a clean worktree gets one explanatory comment and is returned to `Ready for Agent`; a worktree with uncommitted changes or commits missing from its remote-tracking branch is preserved, named in the comment, and moved to `Needs Human Decision`. Worker PIDs are durably recorded before their briefs are written and lead detached process groups; if a restarted dispatcher finds one still live, it kills the entire orphaned group before inspecting or reusing the worktree. The tiny spawn-to-record handoff is also durable: if a crash happens within it, recovery preserves the worktree for human review rather than assuming no orphan exists. Progress for the state transition and comment is persisted per abandonment, so an interrupted Linear call retries only the unfinished effect and a completed recovery is not duplicated. Review transitions are conditional on the entry still being in `review`, so a reconciliation pass cannot overwrite a newly active worker record.
- **Orphan-worktree sweep and ownership marker (MOV-199).** The same reconciliation above also lists every real Git worktree under `worktreeRoot()` and removes any with no matching `worktrees.json` entry — meant to recover a worktree the dispatcher created but lost track of (e.g. a crash between `git worktree add` and the registry write). This runs on **every** `dispatcher run` poll cycle (`WorktreeManager.reconcileStartup()`, called from `reconcileWorktrees()`), not only at daemon startup despite the name, and confirmed live (repeated `dispatcher.stdout.log` occurrences) force-deleting worktrees an interactive/human-delegated session had created directly under the same shared root with `git worktree add` — this repo's own `agent/<LINEAR-ID>-<slug>` branch convention applies equally to human delegation (`AGENTS.md` §"Direct assignment"), so a foreign worktree is indistinguishable from a lost dispatcher one by path or branch alone. Two independent guards now apply before anything is removed: (1) **ownership** — `create()` stamps a marker file into the worktree's own private Git directory (`<gitdir>/moviecal-dispatcher-owned.json`, never the tracked working tree), and the sweep now checks for that marker rather than inferring ownership from naming; a worktree without it is never a candidate, full stop, regardless of how it looks. (2) **dirty-worktree guard** — even a provably dispatcher-owned orphan is left in place, not force-removed, if it has uncommitted changes or commits missing from its remote-tracking branch (the same `uncommittedChanges()`/`hasUnpushedCommits()` checks MOV-185 added to the same-issue reclaim path), with the reason logged. A consequence worth knowing: a dispatcher-created worktree from **before** this fix shipped has no marker and so is no longer auto-reclaimed as an orphan even if genuinely the dispatcher's own — a one-time, deliberate cost of failing closed; clean it up by hand (`git worktree remove`) if one is found stale. Separately, the log line for every sweep outcome previously read `c.id`/`c.reason` unconditionally, but an orphan-sweep change record has no `id` field — every occurrence logged as `undefined: startup recovery marked orphaned worktree removed — undefined`, so historical occurrences carry no record of which path or branch was destroyed.
- **Provider-usage-limit resume of a retained dirty worktree (MOV-205).** MOV-151/192 gave a sole, reset-bearing provider usage limit one bounded deferred retry — but *only* when the worktree was clean, because requeueing an issue whose worktree held unpublished work would have collided with (or, pre-MOV-185, reclaimed) that work. A worker that produced real edits and then hit the limit therefore went straight to `Needs Human Decision` (MOV-190 hit exactly this). Preserving the work was right; needing a human to resume it was not, since a usage limit says nothing about the issue. The dispatcher now schedules **one** deferred resume that runs *in place*: the retained worktree and branch are the dispatch target, and nothing is reclaimed, removed, recreated, or fetched. The durable record is split across two files that must agree — a `resume` plan (worktree path, branch, repository, unpublished paths) in `~/.config/moviecal/usage-limits.json`, and a matching `usageLimitResumeAt` stamp on the `failed` entry in `worktrees.json` — so a plan that survived a registry rewrite it did not cause is refused. Before the reset, the ordinary deferral gate holds dispatch back silently (and survives a dispatcher restart); after it, `admitUsageLimitResume()` (`usage-limit-resume.mjs`) re-proves **every** property from live facts rather than from the stored plan: dispatcher ownership via the MOV-199 marker, worktree integrity and checked-out branch, branch/repository identity and the `agent/<LINEAR-ID>-` namespace, registry provenance and `failed` status, the two records agreeing, and that the unpublished work is *still there*. Anything unproven is a refusal. The resumed worker is spawned through the same `worker-guard.mjs` boundary, transcript audit, and trusted publication path as any other implementation worker — there is deliberately no second, weaker copy of that boundary for this path. The attempt is bounded exactly as the clean-worktree one is: the plan is spent the moment the resume *starts* (not when it succeeds), so a crash in between cannot re-fire it, while the consecutive counter is kept — so **whether the first attempt used a clean-worktree retry or a retained-worktree resume**, a second consecutive provider limit, a missing/unparseable or >24h reset, a failed re-admission, or any non-limit failure moves the issue to `Needs Human Decision` with a specific reason, **still without touching the retained worktree**. Three distinct Linear evidence surfaces exist for the three outcomes (deferral, resumption, escalation), and the resumed worker's brief tells it explicitly that the dirty tree is a preserved partial implementation to continue rather than debris to revert. `dispatcher dry-run` prints each issue's `usage limit:` state (deferred / resume due / recorded count) so a resume-pending issue is not mistaken for an ordinary worktree collision. **Clean-worktree deferral behaviour is unchanged**: it records no resume plan and still reclaims and rebuilds its worktree on the retry.
- **Worker quota-pool cooldown (MOV-360).** MOV-151/192/205 above are all *per-issue*: each deferral, resume, or escalation is scoped to the one issue whose attempt hit the limit. That left a gap the 2026-09-25 incident exposed — five Claude issues, each correctly deferred individually, still burned through most of the `Ready for Agent` queue one at a time within a couple of minutes, because nothing stopped the *next* Claude issue from claiming the concurrency slot the prior one's refusal had just freed. `tools/dispatcher/src/worker-cooldown.mjs`'s `WorkerCooldownStore` closes that gap with a second, independent, worker-scoped record (one per quota pool — Claude, Codex — persisted at `~/.config/moviecal/worker-cooldowns.json`, surviving a restart the same way `usage-limits.json` does) that gates *dispatch* rather than any one issue's retry.

  Every place `run-loop.mjs` already refreshes or clears a per-issue `usage-limits.json` record on a recognized, reset-bearing classification does the worker-wide equivalent in the same pass: a trustworthy reset (parseable, within the same `MAX_USAGE_LIMIT_DEFERRAL_MS` ceiling the per-issue bound uses) sets or refreshes that worker's cooldown to the newly reported reset — even when the per-issue bound itself is escalating (a second consecutive limit, or the MOV-205 retained-worktree case) — and any other outcome that actually reached the worker (a clean run, an ordinary task failure, a timeout) closes it. An unrecognized failure, a credential failure, or an untrustworthy reset never touches it either way — masking or inventing a reset is exactly what this must not do.

  Before worktree creation, the dispatcher gates each issue's resolved worker. A fresh worker:any issue requests Claude (or Codex while the MOV-383 trial is active); a deferred retry or retained resume keeps its recorded provider. MOV-395 allows fresh `worker:any` claims to use the other available provider; explicit pins and bound attempts keep their worker. After reset, one eligible same-provider attempt is admitted as a probe, preferring a due retry/resume. A live cooldown recheck after waiting for the single worker slot lets subsequent fresh `worker:any` claims use an available alternative after a preceding refusal. If both pools are unavailable, they stay queued.

  This never changes the per-issue mechanics above: the existing bounded one-retry-or-resume rule, the second-consecutive-limit escalation, worktree ownership/reclaim, and the route/delegate/safety gates all apply exactly as documented. The cooldown decides *whether* dispatch of an issue is attempted at all; everything after that point is unchanged. `dispatcher dry-run` prints each worker's live state (`open` / `COOLING until <reset>` / `PROBE OWED`) and, per issue, the worker a real dispatch would actually use — the unchanged default or an existing worker binding — without consuming a probe or writing anything; `dispatcher doctor` reports the same per-worker state as an informational check. See `docs/operators/worker-routing.md` §Worker quota-pool cooldown for the operator-facing summary.
- **Interactive/human-delegated worktrees should stay outside `worktreeRoot()`** (`~/code/worktrees/moviecal/`) specifically because of the sweep above — even with the MOV-199 ownership guard, a worktree the dispatcher cannot prove it owns simply sits invisible to reconciliation rather than being tracked as healthy. `~/code/worktrees/moviecal-interactive/` (a sibling directory, not a descendant of `worktreeRoot()`) is this repo's established convention for that and is structurally exempt from the sweep regardless of the ownership marker.
- **Invalid/expired dispatcher credential circuit breaker (MOV-177).** Unlike the provider usage limit above (a *quota* refusal the provider always resolves at a known reset time), an invalid or expired worker credential (`CLAUDE_CODE_OAUTH_TOKEN` today) is a *dispatcher-wide* outage with no reset clock — every worker on this Mac fails identically until a human re-authenticates. Before this existed, each dispatched issue hit it independently and was reported as an unrelated generic `**Worker exited with code 1.**` failure with a wall of raw JSON, and nothing stopped the dispatcher from claiming issue after issue against the same dead credential (observed across MOV-172, MOV-173, and MOV-175's incidents). `credential-failure.mjs`'s `classifyCredentialFailure()` recognizes a worker's exit as this class from its logged transcript — an `api_error_status: 401`, a structured `"error": "authentication_failed"`, the literal `OAuth access token has expired` message, or an `invalid API key` signature (the equivalent shape for a future API-key credential, MOV-176) — keyed off the error signature itself, never off "this issue failed more than once", so it cannot misfire on an unrelated repeated failure. On a match, `run-loop.mjs` posts a distinct, unmistakable comment (`**Dispatcher credential is invalid or expired.** Automatic dispatch is paused until this is fixed.`) instead of the generic failure wording, requeues the surfaced issue to `Ready for Agent` (it did nothing wrong — the credential did) rather than `Needs Human Decision`, and trips a named breaker in the same shared, persisted `CircuitBreakerStore` the MOV-180 nested-sandbox-crash breaker already uses (`circuit-breaker.mjs`, keyed by name specifically so unrelated breakers never contend) — surviving a dispatcher restart exactly as that one does. While either breaker is open, dispatch follows the persisted probe schedule described in §Dispatch breaker probe schedule (MOV-403): no issue is claimed until the breaker's `nextProbeAt` passes, then exactly one issue is let through as a half-open probe and every other issue is skipped outright — including one that turns up mid-cycle after an earlier issue in the very same batch trips the breaker, since preflight's own concurrency gate would otherwise free up and let the dispatcher burn through the rest of the `Ready for Agent` queue one issue at a time on the same dead credential. A probe on the same adapter that completes with a clean exit is treated as proof the credential is accepted again and closes this breaker (and only this one; an open nested-sandbox breaker needs its own evidence). After fixing the credential, `node tools/dispatcher/bin/dispatcher.mjs breaker probe-now credential-failure` lets the next poll probe without waiting for the deadline. Only *dispatch* (spawning a worker) is paused; `reconcileWorktrees`, parent-completion reconciliation, priority propagation, and the promote pass are separate calls in `cmdRunOnce` that never consult this breaker and keep running normally.

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

## Retained-worktree recovery

### Operator continuation of a retained failed implementation (MOV-404)

After the upgraded dispatcher is installed in the dedicated daemon worktree and
the service restarted (see **Persistent service** below), inspect one original
issue at a time:

```sh
node tools/dispatcher/bin/dispatcher.mjs resume MOV-333 --dry-run
```

The preview reads current Linear state, registry provenance, Git worktree and
ownership marker, changed paths and unpublished commits, worker binding,
prerequisites, quota/breaker state, prior failure and verification evidence,
and GitHub PR identity. It does not acquire the singleton lock, reserve a
worker, write state, or mutate Git. A refusal is an instruction to resolve the
named condition and preview again, never to requeue a dirty worktree. A
substantive human decision (for example MOV-391's RLS decision) must be
resolved by a human; the command cannot turn it into a technical recovery.

For a previewed, admitted issue, stop the persistent service so the command
can acquire its existing singleton lock, then authorize exactly one attempt:

```sh
launchctl unload ~/Library/LaunchAgents/com.moviecal.dispatcher.plist
node tools/dispatcher/bin/dispatcher.mjs resume MOV-333
launchctl load ~/Library/LaunchAgents/com.moviecal.dispatcher.plist
```

Live execution re-reads Linear and repeats admission under the lock before
spending the authorization in `worktrees.json`. It reopens the same failed
worktree and exact branch without checkout, reset, cleanup, or reclaim. The
worker gets a separate `operator-resume/<attempt-id>/` log and a brief with
bounded prior evidence and the current issue description. The usual
supervision, timeout, budget, simulator lease, transcript/diff audit,
verification record, and trusted non-force draft publisher apply. Existing PR
targets use the separate repair policy. A failed, stopped, or interrupted
continuation retains the tree and cannot relaunch automatically; its spent
attempt record and log remain for review. A credential or sandbox failure still
trips the adapter breaker, and a trustworthy provider reset still records its
shared cooldown; the spent issue request itself is never requeued. Repeating
the same resume command
on that failed tree is refused.

For isolated local evidence on macOS, run the retained-tree and lifecycle
fixtures from the pushed branch, outside a worker sandbox:

```sh
MOVIECAL_OPERATOR_RESUME_ARTIFACT_ROOT=/private/tmp/moviecal-resume-evidence \
  npx vitest --config vitest.integration.config.ts --run \
  tools/dispatcher/test/operator-resume-lifecycle.integration.test.mjs
```

The fixtures create their own temporary repository, bare remote, worktrees,
registry, breakers, provider state and logs; Linear and GitHub are fake
adapters. The macOS happy path launches a fake worker through the real
supervisor and Seatbelt guard, runs literal `npm run verify` against the
fixture's preserved files, captures structured evidence, and publishes only
to its disposable bare remote. It retains a redacted manifest, audit,
verification record and result at the requested artifact path. It does not
call a model or use live recovery issues. The fixtures exercise failure,
timeout and replay refusal; the human security checklist remains required.

After MOV-404 merges and the daemon is upgraded, an authorized operator may
preview and recover MOV-333, MOV-334, MOV-341, MOV-342, MOV-343, and MOV-346
individually. MOV-335 additionally waits for MOV-399's live audit change and
daemon upgrade. MOV-391 is excluded pending its substantive security decision.
Do not move the whole `Needs Human Decision` queue or create replacement
feature issues. Each original issue keeps its own testing, manual review,
draft readiness, and completion requirements.

## Worker interface

A worker is any binary satisfying: *given a repo path, a branch, and a brief on stdin, produce verified filesystem changes in that worktree and exit 0.* Concretely, `claude -p --model <id>` or `codex --sandbox workspace-write --ask-for-approval never exec`. For a linked Git worktree, the dispatcher adds its shared Git metadata directories to Codex with `--add-dir` so Codex can resolve the worktree's `.git` file (MOV-193). The shared outer `worker-guard.mjs` profile keeps those directories non-writable for both adapters; `--add-dir` does not grant an effective write capability. It also denies every non-`.git` top-level entry of the checkout containing that shared metadata rather than denying the checkout root, because macOS Seatbelt deny rules cannot make an exception for nested `.git` paths (MOV-194). Both adapters therefore remain unable to read sibling source and local files while the backing metadata remains available only as necessary. A worker cannot execute Git, push, open/edit a PR, or receive GitHub mutation authority. The dispatcher instead injects a bounded, read-only repository snapshot (branch/HEAD/base, initial status, recent commits, and changed paths) into each brief, so a worker has routine orientation context without invoking Git itself. Implementation and repair briefs also carry short **Explore efficiently** guidance: locate code before opening it, read large files by range, avoid unchanged repeat reads, and use the repo's `explore` subagent for broad searches. When the issue names existing repository files, a **Likely starting points** list adds their paths and line counts, marks files over 400 lines "read by range", and stops at 15 entries. Missing or unreadable paths are omitted; orientation failure leaves the ordinary brief intact. No file contents are included, and paths use the repository-context redaction. After it exits, the dispatcher audits the structured tool transcript, assigned branch, base diff, and dirty paths; only a clean audit reaches `worker-publish.mjs`, which stages and commits the accepted changes, performs a non-force push of exactly the assigned branch, and finds or creates its draft PR. Adding a third worker means satisfying this same boundary, not writing a new operator guide or merge path.

A worker invocation is one-shot — there is no resume across turns, so the brief (`brief.mjs`) explicitly tells the worker to run verification (`npm run verify`, `xcodebuild`, etc.) synchronously and never background a long-running build/test and exit expecting to check on it later (`MOV-137`, after `MOV-106`'s first dispatch did exactly that and left an orphaned `xcodebuild test` running after the worker exited 0). As a backstop, `worker-spawn.mjs` spawns the worker detached (its own process group) and, once it exits, signals the whole group (`SIGTERM` then `SIGKILL` after a grace period) so nothing it spawned outlives it. A zero exit with no audited filesystem change is a failed publication, except an operator continuation whose retained branch already has proven unpublished commits.

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
| Worker hits the nested-sandbox-crash signature (MOV-180/MOV-299/MOV-402, see §Security model) | State → `Ready for Agent` (requeued, **not** `Needs Human Decision`); comment names the exact `sandbox_apply: Operation not permitted` evidence, the affected adapter, the actual next probe time, and the recovery procedure (MOV-403). A repeat on the same issue with unchanged evidence only requeues it, without a second comment |
| Worker hits a 401/`authentication_failed` credential-failure signature (MOV-177, see §Worktree lifecycle) | State → `Ready for Agent` (requeued, **not** `Needs Human Decision`); comment: `**Dispatcher credential is invalid or expired.** Automatic dispatch is paused until this is fixed.` Dispatch is held on the MOV-403 probe schedule until a probe on the same adapter exits cleanly and closes the breaker |
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

- `worker-spawn.mjs` applies inherited Seatbelt confinement to Claude and separately guarded Codex client/executor siblings (MOV-401, below). The command profiles deny execution of Git, `gh`, SSH transports, `curl`, and production-deploy entry points; denies reads of dispatcher/GitHub/SSH/npm credential stores (including the dev environment in repair mode); protects Git metadata and governance-controlled files; and prevents changes to dispatcher or shell credential configuration. The sanitized environment retains Claude's worker credential only in the Claude parent process and forces `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so Bash, hooks, and MCP servers do not inherit it; Codex receives no Claude credential. The dispatcher's `ANTHROPIC_API_KEY` is never passed to either worker (MOV-211): it is reserved for the bounded advisory-diagnosis call, so it cannot change worker authentication or billing. There is intentionally no unguarded fallback: if the OS or native adapter sandbox cannot be applied, the worker does not start, the issue moves to `Needs Human Decision`, and the dispatcher writes a checksummed failure audit (with the Linear comment as the backstop if local audit storage is unavailable).
- **Claude retains access to `/usr/bin/security` (MOV-174); the Codex executor denies it.** Claude Code's own startup unconditionally probes the macOS Keychain (`security find-generic-password -s "Claude Code-credentials"` / `-s "Claude Code"`) to resolve its provider credential — verified to happen regardless of whether `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` is already set in the environment. A blanket sandbox deny on this binary crashed every worker before it did any work (`EPERM` on `posix_spawn`, empty transcript), and neither alternative fix was viable: no credential env var suppresses the probe, and Claude Code's own `--bare` mode does avoid it but does not read `CLAUDE_CODE_OAUTH_TOKEN` — incompatible with running workers against a Claude subscription rather than pay-per-token Console billing. This is an accepted trade-off, not a closed gap: `security-policy.mjs`'s post-hoc transcript audit still hard-denies a worker's *own* `security find|dump|export|unlock|set|add|delete-` invocation, but that catches misuse after a read already happened, not before — there is no longer an OS-level block on a worker reading arbitrary Keychain entries by service name. **Operational caveat:** this credential lookup only succeeds while the Mac is logged in and the login Keychain is unlocked; if `launchd`'s `RunAtLoad` starts the dispatcher before that (e.g. immediately after a reboot, before anyone logs into the GUI session), worker dispatch fails with the same crash signature until login/unlock happens — this is expected given the design above, not a regression to re-investigate.
- The sanitized environment also sets `MOVIECAL_WORKER_SANDBOX=1` — a plain signal, not a capability, so anything the worker spawns (including `npm run verify` and, through it, the dispatcher's own test suite) can know it is running inside this sandbox without probing for a denial itself. `tools/dispatcher/test/startup-recovery.integration.test.mjs`, `worktree-reclaim-concurrency.integration.test.mjs`, `worker-guard-sandbox.integration.test.mjs`, and `codex-containment.integration.test.mjs` read it to skip their real-`git`-binary fixtures cleanly when a worker's own `npm run verify` reaches them — those fixtures cannot succeed once this same sandbox denies `git` process-exec to the worker, and that denial is not a regression in what they test. They keep full coverage on macOS/CI and any human/local `npm run verify` run outside the worker sandbox, where the variable is unset (MOV-274 autonomy-pilot follow-up).
- **Claude permission mode, the scrub, and the explicit tool set (MOV-386).** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` stays set so Bash, hooks and MCP children do not inherit provider credentials. On installed Claude Code 2.1.282 the mode resolver forces `default` unconditionally when the scrub is set; its advice to declare allowedTools does not restore `dontAsk`. Workers therefore request `--permission-mode default --permission-prompts none`. The latter automatically denies calls that would otherwise require approval, so an unattended worker cannot wait for an approval host. This requires Claude Code >=2.1.259 ([CLI reference](https://code.claude.com/docs/en/cli-reference)); an older CLI rejects the flag and fails startup rather than silently falling back. `workerInvocation()` passes the same `CLAUDE_WORKER_TOOLS` list as `--tools` (available set) and `--allowedTools` (permission allowlist): `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`, `NotebookEdit`, `Task`. Everything else, including network, workflow, messaging and scheduling tools, is excluded. `TodoWrite` was not confirmed present and is omitted. `Task` remains available; safe mode disables repository custom agents. Repair workers share this invocation. Existing worker-only denies, OS guard and transcript/diff audits remain unchanged. Broad Bash approval is bounded by those controls. A supervised live probe deliberately left Bash unapproved: its attempted write was automatically denied, while an explicitly approved Write succeeded.
- **Startup check (MOV-386).** Claude's stream-json `system/init` event reports the effective mode and available tools. It does not report permission-prompt routing: confirm `--permission-prompts none` in the run manifest and use an unapproved-call live probe to verify automatic denial. `spawnWorker()` hands the first init event to `worker-startup-check.mjs` as soon as it appears. If `permissionMode` is not `default` or any tool outside `CLAUDE_WORKER_TOOLS` is present (MCP tools included), the dispatcher log gets a `WARNING (MOV-386)` line naming exactly what differed. The run is **not** killed. Each usage record (`usage.json` and the worker-usage ledger) carries a `startupCheck` object: `status` is `match`, `mismatch`, or `missing` (no init event); it also stores the observed mode and tools, any unexpected or unloaded tools, and the Claude Code version. `dispatcher doctor` prints the last observed mode, tool set, and CLI version, and fails that check when the last observed run was a mismatch.
- **Network tools and the Seatbelt profile.** Claude's `worker-guard.mjs` profile is `(allow default)` plus specific denies. It blocks *execution* of `curl`, `ssh`/`scp`/`sftp`, Git, `gh`, and deploy binaries, but it does not deny network sockets. The Claude process itself needs outbound HTTPS to reach the model, and `WebSearch` runs provider-side. So `WebFetch`/`WebSearch` were **not** blocked at the OS level before MOV-386. Removing them from the available tool set is a real control, not only defence in depth. An arbitrary script (for example `node -e "fetch(...)"`) can still open a connection. The post-run audit and dispatcher-only Git/publication boundary can block publication after detected misuse, but they cannot prevent arbitrary-script network traffic. Claude command-network isolation is tracked separately in [MOV-415](https://linear.app/moviecal/issue/MOV-415/design-and-prove-claude-command-network-isolation-without-breaking-mac).
- **External doc/changelog fetches are unavailable, and that is advisory-skip, not a hard-deny stop (MOV-409).** Workers are prohibited from fetching external documentation or changelogs: `curl` is execution-denied by the Seatbelt profile above, and `WebFetch`/`WebSearch` are excluded from both workers' available tool sets. A vendored skill (for example `.agents/skills/supabase/SKILL.md`, hash-pinned in `skills-lock.json` and never locally edited) can still tell a worker to fetch a live changelog or doc page before implementing. The brief (`tools/dispatcher/src/brief.mjs`) tells the worker that instruction is advisory in this environment: skip it, use the repository's own docs/migrations/types/installed package sources, and continue the issue — do not retry the fetch through another tool, a raw script, or a mirrored URL. This is a distinct case from the hard-deny list below: a protected-path write, a Git/`gh`/deploy command, or a credential-access attempt still means stop and report. Before MOV-409, a worker that read the blocked fetch as a hard-deny stop exited 0 with no changes on an otherwise-workable issue (MOV-331), which the dispatcher then logged as `publish-failed` and escalated to `Needs Human Decision` for no reason related to the issue itself.
- **Workers never install dependencies; the dispatcher does (MOV-410/MOV-412).** Worker-side package installs are prohibited for both adapters. The Codex executor denies outbound networking, and MOV-331's worker-side `npm ci` failed with `ENOTFOUND`, leaving a partial `node_modules` with no `.bin/vitest`. Claude's existing guard permits arbitrary-script sockets; that documented limitation is tracked separately in MOV-415. Neither worker profile changes and effective authority does not expand. Instead, the trusted dispatcher runs the locked install before every worker start (§Worktree lifecycle). Both briefs, implementation and repair, in both the Claude and Codex renderings, say that the toolchain is already prepared. They tell the worker not to run `npm ci`, `npm install` or any other install, and, if the toolchain is somehow missing, to report that as a blocker and stop rather than probe it with `npm run verify`. The install record lives in the run's `manifest.json` (`dependencyInstall`) and in `dependency-install.json`, with npm output only in `dependency-install.log`. None of it is in the worker's `stdout.log`, so it never appears in the audited action list and never counts as verification evidence. The exact, unwrapped `npm run verify` rule is unchanged. **Limitation:** an issue whose implementation must add or change a dependency cannot be completed by a worker. The dispatcher installs only what is committed at HEAD and refuses to install from uncommitted edits to `package.json`, `package-lock.json`, `npm-shrinkwrap.json` or `.npmrc`, and the worker cannot install anything. Such an issue needs a human, or a separate trusted step that does not exist yet. Mark it `human-only` or have a human land the dependency change first.
- Credential-shaped environment variables are removed and Git interactive/keychain helpers are disabled. Claude loads shared project defaults plus a dispatcher-owned `--settings` payload containing its worker-only permission denies; the tracked `.claude/settings.json` deliberately contains neither those denies nor a sandbox policy, so ordinary human sessions are not constrained by worker policy. Claude disables plugins/MCP/slash commands and retains its existing inherited guard and audited publication boundary. Codex ignores user exec policy/config and runs ephemeral with approval policy `never`; its closed external executor guard confines test/package-script writes and prevents an indirect network bypass. See the separate client/executor arrangement below.
- Both adapters emit structured tool events. Output is redacted before being written to disk, then `security-policy.mjs` audits command attempts (including alternate GitHub API paths) while the diff audit catches protected changes regardless of command construction. Each hard-deny has an explicit category: **scope** rules keep dispatcher-owned operational tools (Git, `gh`, alternate GitHub API transports, and SSH transports) out of workers; **safety** rules protect secrets, Keychain access, production mutation, releases, and protected paths. A scope command that the native harness demonstrably denied is retained as an auditable warning, not a publication blocker; a scope command that executed or has an unknown outcome remains fail-closed. Every other safety attempt remains fail-closed regardless of outcome; the one exception is a command that only *names* a protected path (next bullet). Warnings never preempt normal classification of the worker's actual exit (for example, a provider rate-limit retry). `auditWorkerResult` carries every warning into the checksummed `security-audit.json`, and the dispatcher lists them in one progress comment on the run.
- **Protected paths are enforced by the sandbox and the diff audit, not by command text (MOV-400).** Two layers enforce the protected paths (`AGENTS.md`, `.github/copilot-instructions.md`, `.github/workflows/**`, `.claude/**`, `.codex/**`, `docs/product/**`, plus repair mode's tests, test configuration, dispatcher code and governance docs), and neither reads a command. The Seatbelt profile from `buildWorkerSandboxProfile` denies every write to them. `auditChangedPaths` fails publication if any of them appears in the worker's committed or dirty diff, however the change was made (inline script, unusual tool, anything else). The command audit therefore no longer blocks a command just because it names a protected path. That old rule flagged every new read idiom (`wc`, `awk`, a `for` or `while read` loop, `xargs wc`) and each one had to be patched separately (MOV-240, MOV-260, MOV-385, MOV-392). Now a command that names a protected path is a **warning**, recorded as `verdict: "warn"` in `security-audit.json` and listed in the run's audit-warning comment. The exception is a short allowlist of known read-only inspections (`cat`, `head`, `tail`, `grep`, `rg`, `ls`, `stat`, `sed`, `find`, and in repair mode the project's test runners), which stays silent. Command-text matching is kept only to catch *intent* when the sandbox has already stopped the write: a command that clearly writes a protected path is still a blocking safety violation. That covers a redirect target (`>`, `>>`, `>|`, `<>`); a `tee` operand; `sed -i`/`--in-place`, `perl -i` or `awk -i inplace`; a `cp`/`ln`/`install`/`rsync`/`ditto` destination (`-t DIR` or the last operand); any operand of `mv`, `rm`, `touch`, `truncate`, `chmod`, `mkdir` or an editor; `dd of=`; a `--write`/`--fix` formatter; and a `find` with `-exec`, `-ok`, `-delete`, `-fprint*` or `-fls`. These count through wrappers (`sh -c`, `eval`, `sudo`, `xargs`, loop keywords). When the written operand is only a variable (`"$f"`), a placeholder (`{}`) or `xargs` input, it counts as a write of any protected path the same action names, so `for f in AGENTS.md; do rm "$f"; done` and `echo AGENTS.md | xargs rm` still block. A command substitution (`$(…)`, backticks) in an action that names a protected path also still blocks, because the audit cannot read what it runs. Quoted `<` and `>` are literal arguments (for example awk's `'$3 > $2'`), not redirects, except inside a `sh -c` or `eval` body. Write detection is lexical. A write it misses is still denied by the sandbox and caught by the diff audit, which remain the enforcement boundary. `tools/dispatcher/test/security-policy-corpus.test.mjs` holds the read idioms and write forms; `tools/dispatcher/test/worker-audit.integration.test.mjs` runs a real fixture worker through both outcomes.
- **Heredoc and inline-script bodies are data, not commands (MOV-398).** The command audit classifies what the shell runs, not the file content a worker writes. The body of a heredoc (`<<EOF`, `<<'EOF'`, `<<-EOF`, any delimiter) is excluded from command classification when it feeds a plain writer or a stdin interpreter (`cat`, `tee`, `python3 -`, `node -`). The line that opens it, including its redirect or `tee` target, is still classified, so `cat > AGENTS.md <<EOF` and `cat <<EOF > .claude/settings.json` remain hard-denied. The quoted program of `python3 -c '…'` or `node -e '…'` is data for the credential and protected-path rules. It stays visible to the Git, `gh`, Keychain, deploy and publish rules. Classification is line-aware: a credential rule matches only when the tool (`gh`, `supabase`, `vercel`, `aws`, `npm`) and the credential word share one shell segment on one line. The audit also unwraps Codex's `bash -lc '…'` wrapper when its argument is one plainly quoted word. It removes text only when it can show the shell treats that text as data. Any of the following keeps the whole action under the pre-MOV-398 whole-text rules, plus a check of every line as a command: command substitution anywhere (`bash -c "$(cat <<EOF …)"`, `$(…)` in an opener); an unquoted delimiter whose body contains `$(…)` or backticks; an unterminated or unrecognised heredoc; a body fed to anything else; or a shell, `eval`, `xargs`, `source`, loop keyword or local script anywhere in the action. What an excluded body or inline script *writes* is covered by the post-exit diff audit (`auditChangedPaths`, which fails closed on any protected path) and by the Seatbelt write-deny on protected files. What it *executes* is covered by the Seatbelt exec-deny on Git, `gh`, SSH, `curl` and deploy binaries. Neither depends on the command audit reading the body. `tools/dispatcher/test/security-policy-corpus.test.mjs` holds every command that has blocked publication in error, with a matching negative-control corpus. Add new false positives there.
- **Migration and auth review is decided from changed paths (MOV-399).** Commands that only read or name `supabase/migrations/**`, `src/app/auth/**`, `src/lib/auth/**`, `src/app/settings/calendar/**`, calendar-token API/feed routes, or calendar-token library files are allowed. `auditWorkerResult` checks committed plus dirty paths after the worker exits, including changes made through `Write`, `Edit`, or a shell redirect. A hit is recorded in `security-audit.json` as `humanReviewPaths`; it does not block draft PR publication. The draft PR body and Linear run comment name the changed paths and require human review. The PR body says `Autonomy: disabled`, and the PR-autonomy policy independently rejects these paths. The required `lane-review` check blocks merge until the owner supplies the sensitive-path acknowledgement described below.
- Workers leave filesystem changes only. The dispatcher owns every Git and authenticated remote step, validates branch identity, stages and commits the audited result, confirms the worktree is clean, performs a non-force push with an explicit refspec, and creates or reuses the draft PR.
- Any missing audit, sandbox failure, bypass-shaped tool call, protected diff, branch mismatch, or publication-gate failure moves the issue to `Needs Human Decision` and records a checksummed `security-audit.json` plus a Linear evidence comment. No workflow application or remote mutation follows a failed audit.

**Advisory diagnosis for unrecognized failures (MOV-179).** Sensitive, unknown, repeated, untrusted, and budget-exhausted outcomes escalate to `Needs Human Decision` — that policy, and the decision of *whether* an outcome escalates, is unchanged by anything below. What MOV-179 adds is legibility for the human reading that escalation: for the residual bucket of failures with no dedicated classification of their own (not a provider rate limit, not a credential failure, not a security-policy scope/safety block — every one of those already gets its own specific comment above), the dispatcher makes one bounded, cheap-tier model call (`worker-diagnosis.mjs`) over the failed run's log tail and audit text, and splices its finding into the `Needs Human Decision` comment ahead of the raw log dump. The diagnosis is required to name a falsifiable, grounded signature (an exit code, an `api_error_status`, a matched log line) or say plainly that it could not identify one — never a fabricated cause. This is **advisory only**, in the same sense `security-policy.mjs`'s AI review pass is: it never changes whether an issue escalates, never retries anything, and never makes a second dispatch or Linear-mutation decision beyond the text of the one comment it writes. The call is single-shot with no retry, and fails safe unconditionally — a missing `ANTHROPIC_API_KEY`, a timeout, a rate limit, or a malformed response all fall straight through to today's plain comment, and the escalation itself never waits on or depends on this succeeding. It reads `ANTHROPIC_API_KEY` from the dispatcher process's own environment (not a worker's — workers never see this call at all); an operator who wants the richer comment sets that variable wherever the dispatcher daemon's environment lives (e.g. the launchd plist's `EnvironmentVariables`, see below), and an operator who does not is left with exactly today's plain comment, which remains a fully supported outcome, not a degraded one.

**Nested sandbox collision (MOV-180/MOV-184/MOV-401).** `sandbox-exec: sandbox_apply: Operation not permitted` can occur inside a tool result while the top-level worker exits 0. It is a policy collision, and restarting or running a `bootout`/`bootstrap` cycle does not repair it. Claude retains MOV-184's dispatcher-only `sandbox.enabled=false` setting and inherited guard.

Codex 0.157.1 also applies Seatbelt for `workspace-write` commands. The installed `codex sandbox -P :workspace` helper succeeds outside the worker guard and fails inside it; MOV-401 reproduced this even with an outer `allow default` profile. The former claim that Codex cannot collide was incorrect. Generic nested `sandbox-exec` tests do not establish the installed CLI's behavior.

**Codex containment (MOV-401).** Routing still requests `workspace-write`. Only the trusted `spawnWorker()` preparation changes the effective native command mode to `danger-full-access`, after creating two closed-by-default external Seatbelt profiles. That flag must never be used as a standalone recovery command. The installed CLI's separate `exec-server` transports commands and file operations:

**Contained Codex Responses proof (MOV-429).** See [the scoped proof runbook](./mov-429-codex-responses-proof.md) for native fake-provider checks, owner preflight, the one-use disposable paid command and explicit no-go outcomes. The Codex route can consume a matching reviewed transport input and write per-request evidence; production activation remains disabled with no resolver and empty policy allowlists.

**Disabled OpenRouter transport (MOV-425).** The hosted Jev Codex transport is present only as an explicit, trusted `providerTransport` input to `spawnWorker()`; the run loop supplies no such input and the production policy-hash allowlist is empty. An admitted `jev-hosted` issue with no matching transport is visibly escalated to `Needs Human Decision` before a worker starts. Ordinary Codex and Claude routes keep their existing providers. No live key, endpoint, or router arm is enabled by this change. MOV-429 must prove the real Responses tool loop and wire a reviewed route; MOV-431 owns human-led activation after MOV-426/427 accounting evidence is integrated.

When that route is reviewed, the owner must confirm the dedicated MOV-424 key's **metadata and effective workspace eligibility**, its $69 total key limit, no prompt/completion logging opt-in, unrestricted downstream model/provider access, and the $75 all-in hosted-arm ceiling without exposing the key value. The approved trial does not impose request-level ZDR or `data_collection: deny`; review actual account and workspace settings before activation. Label a future routed issue `needs-secrets` and `needs-secret:openrouter-jev`: the dispatcher preflight checks only the dedicated file's owner, mode, type, and size, never its value; `.env.local` cannot satisfy this named gate. Store the dedicated `OPENROUTER_API_KEY` entry only at `~/.config/moviecal/openrouter-jev.env` as an owner-owned mode-600 regular file, never in `.env.local`, user Codex config, a manifest, an argument, or a log. `openrouter-transport.mjs` rejects unapproved policy hashes, a missing/linked/insecure credential, any production endpoint other than `https://openrouter.ai/api/v1/responses`, and absent owner-review metadata. The broker alone opens the key; neither Codex sibling receives its value. A fake loopback endpoint is accepted only by the explicit test fixture path. The broker accepts authenticated local `POST /v1/responses` for `typesafe/jev-router` and forwards only to the fixed upstream without adding provider or data-policy filters. It does not follow redirects or provide an arbitrary forward proxy. The routed client profile permits outbound TCP only to the occupied executor and broker ports; the executor profile remains network-denied and cannot read the broker token, key, logs, client runtime, or protected repository paths.

Before review handoff, run `npx vitest --config vitest.integration.config.ts --run tools/dispatcher/test/codex-containment.integration.test.mjs` **outside any worker sandbox on a disposable Mac** with the installed, pinned Codex CLI. The fake-key/fake-provider proof covers both implementation and repair modes; `MOVIECAL_WORKER_SANDBOX=1` deliberately skips it and is not native evidence. Check the provider's authenticated request and policy fields, command network/socket denials, key denial, protected paths, and launch artifacts. The owner then reviews those results and the live key/workspace metadata before MOV-429 or MOV-431 can authorize any real traffic. To roll back a future activation, stop Jev admission (`dispatcher jev stop`), stop new routed starts, revoke the dedicated key, and retain redacted admission/accounting evidence; never switch an in-flight routed issue to ChatGPT, OpenAI, or a subscription worker.

- The client can make provider requests and read its existing login through a read-only auth symlink. It can write only its isolated runtime/cache directories, allows only the installed Codex client and its stock code-mode tool router, and cannot execute a general-purpose interpreter or shell, and cannot write the worktree. Plugins, apps, web search, snapshots and login shells are disabled. Code-mode JavaScript uses the stock V8 tool-delegation isolate with no filesystem/network globals or module imports; in-process fallback is disabled. Native probes check these APIs and then delegate a command into the guarded executor. Its generated, immutable environment config excludes the local executor.
- The sibling executor and its commands can write the assigned worktree and isolated executor home/scratch directories. Unrelated, sibling/main-checkout, Git metadata, governance, and repair-protected writes are denied, including protected ancestor moves. Provider/dispatcher credentials, provider runtime, and run logs are unreadable. Prohibited executables and outbound networking are unavailable; only its single occupied IPv4 TCP listener serves the stock executor transport. New command listeners, UDP/IPv6 alternatives, and outbound connections are unavailable. Its limited Mach-service allowlist cannot use the client's TLS/network brokers.
- A trusted supervisor copied into the protected run-log directory launches both guarded siblings in the existing managed process group. It only transports stdin/stdout and manages lifecycle; it never interprets model commands. Setup/profile/executor failures terminate the attempt without a broader fallback. Timeout, stop, exit, and startup recovery reap that same group. Production `spawnWorker()` requires a security context.

The application build script uses `next build --webpack` in every environment (MOV-416), and the development script uses `next dev --webpack` so browser E2E exercises the same bundler. The prior Turbopack build attempted an additional local port bind while processing CSS, which the executor correctly denied; the existing one-listener IPC exception is not a general build-process allowance. The bundler change keeps the literal `npm run verify` command and the Codex guard unchanged. Run the full-repository Codex verification smoke on a pushed issue branch before review handoff; the smaller MOV-401 fixture alone cannot test Next.js build behavior.

This per-attempt loopback transport is the sole exception to the dispatcher's no-listener invariant. It accepts only local worker IPC, exists only for that attempt, and adds no shared secret. Agent Session delivery remains outbound-only as specified by MOV-159; no receiver or remotely reachable endpoint is added to the Mac.

Run manifests preserve the arrangement, installed binary path, profile paths/hashes and launch-descriptor hash. The original routing argv and effective native argv are both retained (the latter in `codex-launch.json`); environment values and auth contents are not recorded. Runtime directories are removed after process cleanup. Claude's launch arrangement is unchanged.

**Local containment gate.** Outside an agent sandbox on this Mac, run:

```sh
npx vitest --config vitest.integration.config.ts --run tools/dispatcher/test/codex-containment.integration.test.mjs tools/dispatcher/test/worker-guard-sandbox.integration.test.mjs
node tools/dispatcher/bin/codex-containment-smoke.mjs --live-provider
```

For the full repository build gate on a clean, pushed `agent/MOV-416-*` branch, run `node tools/dispatcher/bin/codex-repository-verify-smoke.mjs /private/tmp/MOV-416-native-<unique-id>` outside the worker sandbox. It clones that exact committed branch, prepares locked dependencies with the trusted installer, then has the installed Codex CLI/native executor run the literal `npm run verify` through a local deterministic provider. `proof.json` records the head, install result, profile evidence, audit hash and verification status. This fixture uses no live model credential or private external provider. Keep its evidence directory for review; remove its disposable `checkout/node_modules` after inspecting the result if disk space is tight. A failed verification must remain failed even if the CLI exits 0.

The first command uses fake credentials and a local SSE provider with the installed native `exec_command` and `apply_patch` paths. The second explicitly uses the installed CLI's existing provider login in a bounded disposable fixture; it prints the preserved evidence directory. It makes no Linear/GitHub/daemon mutation. Review the profiles, successful command results, verification evidence and manifest before deployment or retrying MOV-399. Human sign-off remains required for this governance security boundary. `exec-server` is marked experimental by installed CLI help. The implementation accepts exactly `codex-cli 0.157.1`; other versions fail setup until this allowlist is updated after both proof gates and human review. Rerun both gates after any OS upgrade, and do not substitute flags if support changes. CLI reference: [developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

MOV-180's detection machinery (`failure-classification.mjs`'s `classifyWorkerFailure()`, the persisted circuit breaker in `circuit-breaker.mjs`) remains in place as a defense-in-depth backstop, requeuing to `Ready for Agent` with a distinct comment and holding dispatch on the probe schedule below if this signature is ever seen again. MOV-299 extends that backstop to Codex's observed graceful-exit shape: the worker must report the same exact marker in its structured agent message before any audited tool action executed; a generic zero-change/zero-exit result is never enough. MOV-402 adds the native shape MOV-399 hit: Codex's own completed `command_execution` event shows a command whose entire output is the `sandbox-exec` refusal line with a nonzero exit code, meaning the shell never started. That is recognized from the full structured transcript whatever the outer exit code or the model said.

**Attempted is not started.** The security audit (`worker-guard.mjs`) records every command the harness handed on as `executed`, including one `sandbox-exec` refused to start, so that violations and attempted commands are never lost; that record is unchanged and still blocks publication on a violation. It is not evidence the local sandbox works. The sandbox classifier uses separate health evidence instead (`assessLocalSandboxStartup()`): only completed native events count, deduplicated by item id, and only a completed local command (zero or ordinary nonzero exit) or a completed file change counts as successful local activity. Remote tool calls and model narration count for nothing. Any successful local activity in the run rules the native and narrated signatures out, so a marker quoted in fetched issue text, an ordinary failing command, a generic exit 71, or a report after real local work follows the normal paths. A recognized sandbox failure returns before readiness evidence is captured, before advisory diagnosis, before publication, and before the success path that clears breakers, so such an attempt can never close the breaker. A correctly-updated dispatcher-daemon (post-MOV-401 with its required operator sign-off, i.e. running current `tools/dispatcher/` code, not a stale worktree — see the "not auto-updated" warning below) should not hit it in normal operation. If it recurs, treat that as a signal something else changed (a new tool trying its own nested sandboxing, an OS update altering this behavior again) rather than assuming the old `bootout`/`bootstrap` guidance applies — it does not fix this condition and never reliably did. [MOV-401](https://linear.app/moviecal/issue/MOV-401) showed it can also be specific to Codex's own nested command sandbox, so a successful Claude run says nothing about Codex.

**Dispatch breaker probe schedule (MOV-403).** Both dispatch breakers (`nested-sandbox-crash`, `credential-failure`) persist a probe schedule in `~/.config/moviecal/circuit-breakers.json` alongside their reason, affected adapter and evidence:

- The first trip sets `nextProbeAt` 10 minutes out. Normal polls before that deadline claim nothing: no worktree, no worker, no Linear state change or comment. Each deferred issue is logged as `circuit-breaker-open` with its `retryAt`.
- Once the deadline passes, one poll admits exactly one probe across the whole batch. For a breaker recorded against an adapter, only an issue routed to that adapter can be the probe. The probe is counted as failed and the next deadline persisted *before* its worker spawns, so a crash or restart mid-probe cannot buy an immediate retry. The delay doubles after each unproven probe (10, 20, 40, 80, 160 minutes, capped at 4 hours), and after 6 unproven probes automatic probing stops altogether.
- A failed probe keeps the issue's worktree, returns it to `Ready for Agent`, and posts a comment with the actual next probe time. The same issue failing again with unchanged evidence is only requeued, without a duplicate comment.
- Recovery needs positive evidence from the affected adapter. The sandbox breaker closes only when that adapter's structured transcript shows a local command that completed successfully (`sandbox-recovery.mjs`: a Codex `command_execution` with exit 0, or a Claude Bash `tool_result` that is not an error or denial). A clean exit with no command, a narrated sandbox failure, an ordinary failed command, or another adapter's success leaves it open. The credential breaker closes on a clean exit from the same adapter. One breaker's recovery never clears the other.
- Reconciliation, parent completion, priority propagation, promotion, repair and PR autonomy are separate passes in `cmdRunOnce` and keep running while dispatch is held.

Operator commands:

```
node tools/dispatcher/bin/dispatcher.mjs breaker status
node tools/dispatcher/bin/dispatcher.mjs breaker probe-now nested-sandbox-crash
```

`breaker status` is read-only and prints each breaker's adapter, reason, unproven probe count and next probe time; `dispatcher doctor` reports the same line and fails while a breaker is open. `breaker probe-now <name>` is the recovery step after fixing the cause: it lets the next poll admit one probe before the deadline (or after the automatic budget is spent). It deletes no state or history, and the probe runs under the normal worker confinement. Do not delete `circuit-breakers.json` to force recovery.

Repair mode is stricter: tests, test-runner configuration, dispatcher code, staged workflow proposals, and governance documentation are read-only. CI logs, PR bodies, diffs, and review comments are delimited as untrusted data by `generateRepairEvidence()`; they can inform a code fix but cannot alter the fixed mode, target, attempt budget, or tool authority. `validateRepairTarget()` admits only a retained `review` worktree whose dispatcher-owned provenance matches the configured repository and the live PR head repository, branch, and observed SHA. Forks, stale heads, and unknown branches are never repaired automatically.

**Automatic CI and review repair (MOV-190).** `dispatcher run` evaluates retained review worktrees after reconciliation on every poll, even when there are no `Ready for Agent` issues. It is disabled unless `MOVIECAL_AUTO_REPAIR` is explicitly truthy. When enabled, the dispatcher records an attempt in `~/.config/moviecal/repair-ledger.json` *before* it re-runs a transient failed job or starts one repair-mode worker, so the per-PR budgets and "one job per head SHA/failure fingerprint" rule survive a restart. A transient failure is re-run without a worker or repository change; a supported code/review failure gets at most one single-flight repair worker per pass and may publish only to the exact existing PR branch and admitted SHA. A dirty checkout, stale/unreadable head, unsupported/sensitive failure, exhausted budget, failed audit, publication failure, or missing Linear issue is refused or escalated with one durable Linear/PR record; it never silently retries or opens a replacement PR.

**Review-CI observations (MOV-298).** Observation records are keyed by the required-check snapshot as well as PR and head SHA. A pending required check is explicitly reported as **provisional**, never as a final “no actionable failure” result; once the same head becomes terminal, its changed snapshot receives one new observation while unchanged later polls remain silent. During a long-running implementation worker, `dispatcher run` keeps this read-only review-CI observation on its normal interval. It does not start a repair worker while that implementation worker occupies the single dispatch slot; the ordinary repair pass re-observes the terminal state when the slot is available.

Deduplication has no separate persistence of its own: on every poll, `reportObservationToLinear()` re-reads the issue's Linear comments and skips publishing when one already contains the current observation key (MOV-423). That re-read makes the check durable across a dispatcher restart. Linear's `comments` connection is ordered newest-first, so `LinearClient.issueComments()` begins with `first: 20`, not `last: 20`; `last: 20` returns the oldest comments and caused the MOV-331 flood. If the key is absent from the newest page, the client follows comment cursors until it finds the key or reaches the end, so 20 newer comments cannot revive an old observation. `issueSnapshot()`'s resume-fields comments, `issuesForPromotion()`, and `issuesForSpecAudit()` read the newest-first window and reverse it back to the oldest-to-newest order their callers (`lastPreflightFailureReason`, `lastAuditFingerprint`) expect.

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

- **Deterministic heuristics** — sensitive paths (`.github/workflows/**`, `AGENTS.md`, `.claude/settings*.json`, `docs/product/**`, `supabase/migrations/**`, auth routes, calendar-token paths, ruleset-shaped filenames), secret-shaped strings, diff-size threshold. Always run, need no credential, and are **fail-closed**: a heuristic `block` fails the check. The only downgrade is the sensitive-path acknowledgement below; secret and diff-size blocks are never downgradeable.
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

The hard-deny list is enforced before, during, and after the model process: OS sandbox/credential removal prevents the capability, structured-command auditing records attempts, and diff/publication gates stop any result that violates the protected path or branch contract. For protected paths, the command audit blocks only a detected write; merely reading or naming one is an audit warning (MOV-400, above). For Claude workers, `workerInvocation()` adds the matching early-refusal denies through its dispatcher-only `--settings` payload; `.claude/settings.json` remains an interactive shared-defaults file and does not apply that worker policy to humans.

**Audit normalization (MOV-210).** The command audit preserves escaped shell separators (`\\|`, `\\;`, and `\\&`) as literal data before applying ownership rules: a grep regular expression that happens to contain `\\|git` is not a Git pipeline. It still detects a real `|git` pipeline, including one without surrounding spaces. `npm run <script>` is likewise recognized as local script execution, so credential-like test-file or script names do not look like npm credential operations; non-`run` npm credential/token commands remain hard-denied. Finally, output checks are bounded to one shell command, so `echo ---; grep "ANTHROPIC_API_KEY"` is not misreported as echoing a credential. These are deliberately lexical, fail-closed exceptions for literal data and command boundaries—not a general relaxation of the protected command set. Quoted literal shell operators in search arguments (such as `grep -E "a|b" AGENTS.md`) are also kept distinct from real command boundaries, preventing the MOV-368 read-only-search false positives. Protected-path inspections containing command substitutions remain denied; actual redirects, in-place edits, and later mutating commands retain their safety classification.

Two operational prerequisites for a Claude worker to run headlessly at all, discovered and confirmed empirically while wiring this up:

- **Workspace trust.** Claude Code refuses to apply `.claude/settings.json` in an untrusted workspace. This is anchored to the repository's **main checkout path**, not to whichever worktree a session runs from: trusting a linked worktree's own path did *not* stop the "workspace has not been trusted" warning for a `-p` session run from it; trusting the main checkout did, and that one grant covers every worktree of the repo. `WorktreeManager.create()` (`tools/dispatcher/src/worktree-manager.mjs`) pre-trusts both the new worktree's own path and the discovered main-checkout path (via `mainWorktreePath()`, parsed from `git worktree list --porcelain`) using `tools/dispatcher/src/claude-trust.mjs`'s `trustWorkspace()` — a careful read-modify-write of `~/.claude.json` that touches only the one project key, preserving everything else. This is safe specifically because it only ever runs on paths the dispatcher itself just checked out from this same repository, never an arbitrary path. Failure is non-fatal and logged: an untrusted workspace still fails cleanly rather than hanging (see below).
- **A current login.** The `claude` CLI's own login must be valid (`claude` then `/login` if expired) — this can only be done interactively, never by an agent.

**Staged workflow-edit proposals (MOV-121, added 2026-09-08).** `Edit(.github/workflows/**)` in the Claude worker's dispatcher-only hard-deny payload is never lifted, for any issue, ever — that stays exactly as strict as documented. But some legitimate issues (e.g. a CI-cutover task like `MOV-104`, converting `ios-verify.yml` from bootstrap no-op to real `xcodebuild`/XCTest CI) genuinely need to change a workflow file as their whole point, and the repo owner wants issues like that handled fully by an agent in one PR, not split into "agent scaffolds, human hand-applies the CI diff." A permission carve-out can't do this safely: rules are evaluated deny-then-allow with **deny always winning regardless of specificity** (verified above), so a narrower "allow this one file" rule layered on top of the blanket deny would be silently ignored — and even removing the blanket deny and denying every *currently-existing* workflow filename individually leaves a gap, since a worker could create a brand-new file under `.github/workflows/` that wouldn't match any of the enumerated denies.

Instead, a human applies the `ci:workflow-edit-authorized` label to an issue and adds exactly one `Workflow-edit: <path>` marker to its description (e.g. `Workflow-edit: .github/workflows/ios-verify.yml`) — `resolveWorkflowEditAuthorization()` in `preflight.mjs` fails the whole issue closed (moves it to `Blocked`) if the label and marker don't both agree on exactly one valid `.github/workflows/*.yml` path, rather than silently proceeding either under- or over-scoped. When authorized, the worker's brief (`brief.mjs`) tells it to write the file's full proposed content to `tools/dispatcher/pending-workflow-edits/<filename>` — an ordinary staging path — instead of editing the real one. After an implementation worker exits and passes its audit, `workflow-edit-apply.mjs` copies the staged content into the exact authorized path and removes the staging file; the shared publisher includes that trusted application in its commit and then pushes the branch. **Repair mode never applies a staged workflow proposal**, and its stricter diff/sandbox policy prevents a repair worker from changing the staging area itself.

Crucially, this doesn't weaken review: the resulting PR still visibly contains the workflow diff, and `lane-review`'s existing sensitive-path heuristic still flags any diff touching `.github/workflows/**` as requiring explicit human sign-off before merge — the same gate any other issue's workflow-touching PR would hit. What changes is only *who proposes and builds the change* (an agent, working under real hard-deny protection throughout, never gaining the ability to directly write to that path), not *whether it's reviewed before merging*.

Separately: the worker previously had no `xcodebuild`/`xcrun simctl` in its Bash allowlist at all, so it couldn't verify an iOS build even once permitted to touch the workflow. `Bash(xcodebuild *)` / `Bash(xcrun simctl *)` are now allowed globally in `.claude/settings.json` — safe to allow unconditionally, unlike the workflow-edit case, since running a build/test is not itself governance-sensitive.

**Always requires human review before merge:**

- Database migration changes
- Auth or calendar-token logic changes

These changes may be implemented and published as draft PRs with `Autonomy: disabled` and the review note above; they do not move to `Needs Human Decision` solely because their paths changed.

**Always requires a human decision (`Needs Human Decision`):**

- Anything adding a new secret
- Any production deploy or release
- Any change to this governance system itself

## Run-log locations

Dispatcher and worker run logs are written to `~/Library/Logs/moviecal-dispatcher/<LINEAR-ID>-<slug>/`, one directory per worktree, containing redacted structured worker stdout/stderr, `manifest.json` (including the `dependencyInstall` record, or `workerStarted: false` when a failed install stopped the attempt), the dispatcher's own `dependency-install.json` and `dependency-install.log`, the applied `worker-sandbox.sb`, and the checksummed `security-audit.json`. Logs are retained for 90 days and then pruned by `dispatcher gc`. Given a Linear issue, the corresponding run log directory can always be found from the worktree/branch name recorded in the dispatcher's `Agent Working` comment on that issue (`<LINEAR-ID>-<slug>`).

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
  `KeepAlive.SuccessfulExit: false` (below) already restarts the process on a crash; this is for a *deliberate* restart. Restarting does not clear a dispatch breaker or reset its probe schedule (MOV-403); use `breaker probe-now` after fixing the cause. A nested `sandbox_apply` policy collision requires the containment fix and proof above; neither `kickstart` nor `bootout`/`bootstrap` is a remedy.
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

`dispatcher doctor` is a read-only command that asserts: Linear auth works, `gh` auth works, the worktree root is writable, `~/.config/moviecal/env.local` exists and is mode 600, `claude` and `codex` are on `PATH`, `origin/master` is fetchable, and the iOS self-hosted runner is reachable. It also prints the **local dispatch identity** — the delegate an issue must name to be claimed here (MOV-143) — which **lifecycle publication surface** is configured (MOV-158), and each worker's current **quota-pool cooldown state** (MOV-360: open, cooling until a reset, or awaiting a post-reset probe) — all informational rather than pass/fail gates. It also reports the **last observed Claude worker startup mode and tool set** from the worker-usage ledger (MOV-386). That line fails when the last observed run's `system/init` event showed a mode other than `default` or a tool outside `CLAUDE_WORKER_TOOLS`. The Agent Session line reports configuration only: the sole way to test entitlement is `agentSessionCreateOnIssue`, which is a mutation, and `doctor` never mutates. If `~/.config/moviecal/linear-app.env` is present it additionally checks the file is mode 600 and that an app-actor token can be minted from it (MOV-122); if it is absent that check is a no-op pass. Run it after any environment change and before relying on the dispatcher for real work.

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
- **No trusted path for dependency-changing issues (MOV-412).** The dispatcher prepares only the dependencies committed at HEAD, and workers cannot install. An issue that must add or change a dependency needs a human, or a separate trusted install step that does not exist yet (§Security model).
- Docker is not installed on this Mac, so `npm run lane:real-stack` / `lane:full-stack` stay CI-only locally; use the `supabase-verify` GitHub Actions workflow as the authoritative DB gate.
- MOV-115 (two-way GitHub sync) is **done** — see `docs/governance/linear-information-architecture.md` §GitHub Issues: migration and ongoing sync.
- MOV-116 (an automated `lane-review` status check for independent PR scrutiny, plus wiring `security-policy.mjs`'s hard-deny list into real enforcement) is partially done — see §Security model above. `lane-review` is now a required status check (MOV-119); the hard-deny-enforcement half is still unresolved.
- **One remaining real worktree-reclaim race, found by MOV-198's real-subprocess integration test (`tools/dispatcher/test/worktree-reclaim-concurrency.integration.test.mjs`) and pinned there as an `it.fails(...)` case pending its fix:**
  - `WorktreeManager.reconcileStartup()` only recovers an `active`/`review` entry if the path is entirely missing or the recorded worker pid is dead; it never checks whether an existing path is still a real, intact Git worktree. A worktree whose content is wiped out from under a still-alive process (the exact incident observed while working MOV-195/197) goes undetected. See MOV-202.
