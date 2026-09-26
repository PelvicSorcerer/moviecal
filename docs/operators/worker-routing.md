# Worker and model routing policy

Read `AGENTS.md` and `docs/operators/local-execution.md` before this file. This document answers: **given a Linear issue, which worker binary and which model should implement it?** It replaces `docs/operators/claude-model-selection-policy.md`, generalized from "which Claude model" to "which worker, and which model."

## Decision: cost-optimized, explicit, rubric-driven

Worker and model selection is cost-optimized and rubric-driven, starting from the cheapest capable option and upgrading only when a named condition applies. It requires judgment applied to a concrete rubric, not fully automated selection — a human can always override via the `worker:*` / `model:*` Linear labels, and that override always wins.

## Available workers

Only workers that can execute against a real local git worktree on this Mac are viable dispatch targets:

| Worker | Invocation | Notes |
|---|---|---|
| `claude` | `claude -p --model <id>` | Primary worker. Full local tool access, MCP, worktree-aware |
| `codex` | `codex --sandbox workspace-write exec --model <id> -c model_reasoning_effort=<tier>` | Secondary worker. Independent quota pool and a real vendor-neutrality check on the worker-adapter interface; used only when pinned with `worker:codex` (or during the `worker:any` trial below). See below for the tier→effort/model mapping |

Cursor Cloud Agent and GitHub Copilot coding agent are **not** viable dispatch targets for this pipeline: both execute in a cloud VM with no path to this Mac's worktrees. They may still be useful as an editor/IDE completion tool, but that is a separate decision from this repo's agent-dispatch architecture and is not covered by this document.

### Installing the Codex CLI

Codex is the dispatcher's second worker option, selected via the `worker:codex` Linear label. To use Codex as a dispatch target:

1. **Install** the Codex CLI globally via npm:
   ```sh
   npm i -g @openai/codex
   ```

   Codex CLI 0.157.0 or newer is required for the current routing defaults: that release added GPT-6 Sol and Luna to its model catalog. Older CLI versions can reject those IDs even for an eligible Plus account. Upgrade with `npm install -g @openai/codex@latest` (an administrator must update a root-owned installation), then confirm `codex --version` and run the controlled model/effort smoke checks before dispatch. See the [0.157.0 release notes](https://github.com/openai/codex/releases/tag/rust-v0.157.0).

2. **Verify** the installation by running `dispatcher doctor`, which will report "codex on PATH" as a passing check:
   ```sh
   npm run dispatcher:doctor
   ```
   If the check fails, ensure the global npm bin directory is on your shell's `PATH`.

## Default routing by task shape

| Task shape | Worker | Model tier |
|---|---|---|
| Docs, chores, config, mechanical refactor | either | cheap |
| Small code change: 1–3 files, clear spec | claude (default) | default |
| Multi-file feature, moderate design work | claude (default) | default |
| Ambiguous spec, 5+ interconnected systems, security-sensitive, migration | claude | strong |
| A prior attempt at a lower tier produced a materially incorrect implementation | claude | strong |

"Cheap" / "default" / "strong" map to the current Claude model catalog (see the `claude-api` skill or Anthropic's published model list for exact IDs — this document intentionally does not pin model IDs, since they change over time and pinning them here would require touching this file on every model release).

The Claude strong tier now defaults to Opus 5.5. The change reflects lower published token prices and stronger published coding results; see the retained review evidence in [MOV-362](https://linear.app/moviecal/issue/MOV-362/route-modelstrong-claude-workers-to-claude-opus-55). `MOVIECAL_MODEL_STRONG` still overrides the default.

Claude workers receive an explicit `--effort` by tier when their model supports it. Implementation and repair workers use the same mapping:

| Tier | Default Claude effort | Override |
|---|---|---|
| `cheap` | none (flag omitted) | `MOVIECAL_CLAUDE_EFFORT_CHEAP` |
| `default` | `medium` | `MOVIECAL_CLAUDE_EFFORT_DEFAULT` |
| `strong` | `high` | `MOVIECAL_CLAUDE_EFFORT_STRONG` |

Overrides accept `low`, `medium`, `high`, `xhigh`, `max`, or `none`; `none` omits the flag. An invalid value is a routing error. Haiku 4.5 does not support effort, so the dispatcher omits `--effort` even if an override requests one. `dispatcher doctor` notes that omission. `dispatcher dry-run` prints the planned invocation and any routing error.

### Per-run turn budget (MOV-367)

| Tier | Initial budget | Environment override | Observed median (2026-09-25) |
|---|---:|---|---:|
| `cheap` | 60 | `MOVIECAL_TURN_BUDGET_CHEAP` | 14 |
| `default` | 150 | `MOVIECAL_TURN_BUDGET_DEFAULT` | 18 |
| `strong` | 250 | `MOVIECAL_TURN_BUDGET_STRONG` | 96 |

Overrides must be positive safe integers; an invalid value stops routing before a worktree or worker is started. These are initial guardrails above the observed medians, allowing ordinary runs room to finish. The 2026-09-25 most expensive runs took 130–200 turns, so the **250-turn strong default would not have stopped them**. It limits still longer runs while avoiding a sudden cutoff near the strong-tier median; review and lower these values using [MOV-363](https://linear.app/moviecal/issue/MOV-363/record-per-run-worker-usage-and-report-it-on-the-issue) per-run usage data after live experience. A 45-minute wall-clock timeout remains an independent backstop.

The dispatcher counts Claude assistant messages from its live `stream-json` output and Codex `turn.completed` events from `--json`; neither uses a CLI turn-limit flag. If Codex emits no completed-turn events, its wall-clock timeout is the only runtime cap. At 85% of the budget, an opted-in Claude steering session receives one wrap-up prompt asking for `WORKER_PROGRESS.md`. Without steering, there is no prompt. At 100%, the dispatcher reaps the process group, retains the worktree, and tries one fresh-process continuation on the same worker and branch after worktree admission. A second budget stop, or failed admission, hands the retained worktree to a human with one summary comment. See `docs/operators/local-execution.md` for the continuation and handoff details.

For Codex, the tier maps to a `model_reasoning_effort` value passed via `-c`, and an explicit `--model` ID resolved by `codexModelIdForTier()` in `tools/dispatcher/src/worker-routing.mjs`:

| Tier | `model_reasoning_effort` | `--model` |
|---|---|---|
| `cheap` | `low` | routing-code default or `MOVIECAL_CODEX_MODEL_CHEAP` |
| `default` | `medium` | routing-code default or `MOVIECAL_CODEX_MODEL_DEFAULT` |
| `strong` | `high` | routing-code default or `MOVIECAL_CODEX_MODEL_STRONG` |

Every implementation and repair invocation passes the resolved `--model <id>` and effort explicitly. `--ignore-user-config` prevents loading the personal `~/.codex/config.toml`, so model selection never depends on it. Concrete model defaults live only in the routing code; each `MOVIECAL_CODEX_MODEL_*` override affects its own tier. Effort remains independently overridable via `MOVIECAL_CODEX_EFFORT_CHEAP` / `MOVIECAL_CODEX_EFFORT_DEFAULT` / `MOVIECAL_CODEX_EFFORT_STRONG`. Dry-run shows the exact invocation; the run manifest records its arguments and usage summaries retain model and effort. CLI rejection follows the existing failure/escalation path without substituting a model or tier.

## Upgrade conditions

Moving up a tier requires citing the specific condition, either in the Linear issue's `model:*` label rationale or the issue description. Moving directly to the strong tier requires citing `prior-failure` or `architecture` plus a one-sentence rationale.

| Condition | Meaning |
|---|---|
| `multi-system` | Touches 5+ interconnected systems or modules |
| `ambiguous-spec` | Acceptance criteria require significant inference from incomplete context |
| `security-critical` | Auth, crypto, secrets, or high-stakes production paths |
| `prior-failure` | A previous worker at a lower tier produced a materially incorrect implementation |
| `architecture` | Fundamental design decisions the worker must reason through from first principles |

## Overrides

Before claiming a worktree, the dispatcher re-reads Linear and compares the
worker/model overrides and upgrade conditions with the polling snapshot.
Routing that changes or becomes invalid at this refresh is deferred to the next poll
(`deferred-routing-change`). That next batch repeats quota, reset-probe, and
trial admission; the final read never substitutes a worker after those gates.
Label order and unrelated labels do not cause a deferral. This comparison
applies to retained-worktree resumes as well as fresh claims.
Only the named upgrade conditions in this policy qualify for a strong tier;
unrecognized `upgrade:*` labels do not satisfy intake or dispatch validation.
Invalid routing already present in the poll snapshot follows the ordinary
preflight/routing failure handling.

Bounded routing evidence is appended to `routing-decisions.jsonl` beside the
issue's run logs. It records poll and refreshed routing inputs, the selected
worker/tier/model/effort/budget and selection reason, and `unchanged`, `deferred`,
or `spawn-requested` decisions. `spawn-requested` records the invocation the
dispatcher handed to the worker adapter; the transcript confirms whether it
started. Evidence uses known routing labels and bounded model identifiers,
never descriptions, prompts, credentials, or arbitrary label contents.


- `worker:claude` / `worker:codex` — pins the worker binary. Pinned workers are never changed, including by the quota-pool cooldown below.
- `worker:any` — the baseline is **Claude** for fresh claims: fresh claims use another available worker when the requested worker is cooling down or its post-reset probe is reserved (MOV-395). A prior attempt retains its recorded worker. The only exception is the bounded, disabled-by-default Codex trial below ([MOV-383](https://linear.app/moviecal/issue/MOV-383); live activation requires the release gate in [MOV-384](https://linear.app/moviecal/issue/MOV-384)). The no-label default is **not** `worker:any`: it is a pin to Claude, same as an explicit `worker:claude` label, per the routing table above.
- `model:cheap` / `model:default` / `model:strong` — pins the model tier.

A human-applied label always overrides the default routing table above. There is no silent fallback: if a requested worker or model is unavailable, the dispatcher stops and moves the issue to `Blocked` rather than substituting a different one.

## Worker quota-pool cooldown (MOV-360)

A worker binary's provider usage limit is a fact about that *worker*, not about any one issue. `docs/operators/local-execution.md` §Worktree lifecycle already covers the per-issue side of this (MOV-151/192/205's bounded one-retry-or-resume). This section is the dispatch-wide side: once a worker hits a recognized, reset-bearing provider usage limit, `dispatcher run` pauses dispatch of *every* issue that would use that same worker — pinned or `worker:any` — until the reported reset passes, so one exhausted quota window cannot burn through the rest of the `Ready for Agent` queue one issue at a time, the way it did on 2026-09-25 (`tools/dispatcher/src/worker-cooldown.mjs`).

- **Scope.** Two independent cooldowns, one per worker (`claude`, `codex`), persisted at `~/.config/moviecal/worker-cooldowns.json` (mode 700, alongside the rest of `~/.config/moviecal/`) so a restart does not lose the wait. A cooldown on one worker never affects the other — a Codex-pinned issue keeps dispatching normally while Claude is cooling down, and symmetrically.
- **`worker:any` binding.** Fresh issues request the current Claude default and use Codex when Claude is unavailable. If neither pool is available they remain queued without consuming a slot. A scheduled retry or retained-worktree resume keeps the provider recorded on its per-issue usage-limit record. While the MOV-383 trial below is active, a fresh `worker:any` issue resolves to Codex through this same resolver, so a Codex cooldown/probe gate applies to it: a fresh claim falls back to available Claude without consuming a Codex trial assignment. A bound attempt stays queued until its original worker is available.
- **After the reset.** Exactly one issue using the cooled worker is admitted as a probe once its reported reset has passed — preferring a due per-issue retry/resume for that worker over a fresh claim, when one is eligible in the same batch. A clean probe closes the cooldown; a new recognized limit refreshes it to the newly reported reset instead, even when the probing issue itself has exhausted its own one-retry allowance and escalates to `Needs Human Decision`.
- **What it never does.** Gate reconciliation, parent-completion/priority-propagation passes, promotion, or read-only CI observation — all of those keep running during a cooldown. Move an unrelated issue to `Blocked` or `Needs Human Decision` — the cooldown is a dispatch gate, not an escalation. Mask or invent a reset: an unrecognized failure, a credential failure, or a usage-limit message whose reset cannot be trusted (unparseable, or further out than `usage-limit.mjs`'s `MAX_USAGE_LIMIT_DEFERRAL_MS`) never touches the cooldown either way.
- **Operator visibility.** `dispatcher dry-run` prints each worker's live cooldown state (`open` / `COOLING until <reset>` / `PROBE OWED`) and, per issue, the worker it would actually use — including the requested route, cooldown fallback, or an existing worker binding — without consuming a probe or writing anything. `dispatcher doctor` reports the same per-worker state as an informational check. Both are read-only views of the same store `dispatcher run` gates on.

## Fresh-issue cooldown fallback (MOV-395)

For a fresh `worker:any` issue, the baseline or active trial determines the **requested worker**. Dispatch uses that worker when its quota gate permits. Otherwise it tries the other supported worker; if both are cooling down or awaiting another issue's reset probe, the issue stays queued. Selection is symmetric for Claude and Codex and is rechecked after waiting for the worker slot, so a limit earlier in the same batch affects subsequent claims. After reset, the requested worker is used again when its single-probe gate permits; a due retry/resume has probe priority.

Explicit worker pins and issues without a worker label keep their existing route. Retries, retained resumes, continuations and repairs keep their recorded worker. Cooldown fallback does not transfer an already-started issue. Preview shows the requested worker and fallback reason through the same resolver as live dispatch. A Claude fallback during the Codex trial has no trial attribution and consumes no Codex assignment; a later fresh Codex claim follows ordinary trial admission. The one-active-worker cap and all model, eligibility and security gates remain in force.

## Temporary `worker:any` → Codex trial (MOV-383)

A bounded, **disabled-by-default** switch for the Sol-vs-Sonnet data-gathering trial ([MOV-384](https://linear.app/moviecal/issue/MOV-384) owns cohort selection, live activation and rollback; this feature was delivered inactive and is not activated by merging it). While active, a *fresh* `worker:any` issue resolves to Codex at **every** tier — the tier and its pinned model/effort are untouched (default = GPT-6 Sol at `medium`; cheap/strong Codex runs are supplemental data, not default-tier Sol-vs-Sonnet evidence). Nothing else changes: explicit `worker:claude` / `worker:codex` pins keep precedence, an issue with no worker label keeps its ordinary Claude route, and eligibility, upgrade validation (`model:strong` still needs an `upgrade:*` label), concurrency, cooldown, verification and security gates all apply as usual. Missing or refused Codex/model follows the existing failure path. Only a recognized provider cooldown permits fresh `worker:any` fallback; unrelated failures do not trigger substitution.

**State.** Two files under `~/.config/moviecal/` (outside the repo): `worker-trial.json` (config: `enabled`, `trialId`, `activatedAt`, `expiresAt` in explicit UTC, `maxAssignments`) and `worker-trial-assignments.json` (append-only ledger, one record per distinct issue: trial ID, requested worker `any`, resolved worker, tier, routing reason, assignment time). No file means disabled. Activation requires an `expiresAt` in the future and at most 14 days out, and `maxAssignments` from 1 to 30. There is no polling and no recurring automation; the deadline and cap are re-read before *every* new assignment, so expiry and exhaustion take effect without a deploy or daemon restart.

**Activate** (only after the MOV-384 release; record it on that issue):

```sh
node tools/dispatcher/bin/dispatcher.mjs trial activate --id <trialId> --expires 2026-10-05T00:00:00Z --max-assignments 20
node tools/dispatcher/bin/dispatcher.mjs trial status     # also shown by `dry-run` and `doctor`
```

**Early stop** — disables *future* assignments only. It keeps the config and every ledger record and does not touch running work:

```sh
node tools/dispatcher/bin/dispatcher.mjs trial stop
```

**States.** `dry-run`, `doctor` and `trial status` report `disabled`, `active` (with `assigned/max`), `expired`, `exhausted` or `invalid`, and `dry-run` prints each issue's resolved route with the same resolver `dispatcher run` uses. Previews never consume an assignment. In the live loop the assignment is admitted under the dispatcher's singleton lock immediately before the worktree is created; if the trial ended between batch start and admission, the issue is deferred (`deferred-worker-trial-ended`) and re-resolved under the baseline on the next poll — the loop never reselects a different worker mid-dispatch. When disabled, expired or exhausted, new `worker:any` issues return to the Claude baseline.

**Invalid config.** An active config that is malformed, has an expiry beyond 14 days, or a cap above 30 is reported by `doctor`/`dry-run` and makes every fresh `worker:any` issue report `config-error` and stay queued — no dispatch and no fallback to Claude. Fix the file or run `trial stop`. Pinned and unlabeled issues are unaffected.

**Existing work keeps its worker.** A running attempt, retained-worktree resume, budget continuation, PR repair, or retry of an issue that already has a ledger record keeps the recorded worker/model/effort and trial attribution, and does not consume another slot, even after the trial ends or is stopped. The trial toggle and deadline never switch an existing issue's worker; an operator changes it only through an explicit `worker:*` label (the existing recovery workflow).

**Attribution.** The trial ID, requested worker (`any`), resolved worker, routing reason and assignment time are written to the run `manifest.json` (`trial`), the worktree registry entry, and each usage record (`trial`, exported by `dispatcher usage export`, with `trialIds` per issue). They are `null` for attempts outside the trial.

**Rollback.** `trial stop` (or waiting for expiry/exhaustion) restores the baseline for new claims immediately. Issues already assigned to Codex finish there; to move one, relabel it `worker:claude` and requeue it through the normal recovery workflow. Deleting `worker-trial.json` is equivalent to disabled but loses the config record — prefer `stop`.

## Subagents

When a worker spawns its own subagents (e.g. Claude Code's `Agent` tool), the subagent inherits the parent worker's effective model by default. A subagent may use a different model only when the issue brief explicitly names one for that subagent. This preserves the existing repo-scoped subagent definitions in `.claude/agents/` (`explore`, `code-reviewer`), which intentionally do not pin a model in their frontmatter.

## Changing this policy

Update this file first, then reconcile:

- `docs/operators/local-execution.md` — if the change affects dispatcher behavior
- `tools/dispatcher/` routing logic — the code that actually implements this table
- `.claude/agents/` — if a subagent's model behavior needs to change

## What was deliberately dropped from the previous policy

The previous `claude-model-selection-policy.md` included two mechanisms specific to the retired cloud-agent (CCR) execution model:

- **CCR model-alias substitution** (`sonnet`/`opus`/`haiku` enum aliases resolving to specific model IDs, with a documented workaround for requesting a model the alias couldn't express). This Mac runs the `claude` CLI directly with real model IDs; the alias-resolution problem does not exist locally.
- **The `"default"` is not a valid value / mandatory `Requested Claude model:` field** rule, which existed so a cloud worker with no visibility into the orchestrator's intent wouldn't silently proceed on an unstated model. The local dispatcher always resolves and records an explicit model before spawning a worker, so this is enforced in code rather than by convention.

Both are preserved for reference in `docs/operators/archive/claude-model-selection-policy.md`.
