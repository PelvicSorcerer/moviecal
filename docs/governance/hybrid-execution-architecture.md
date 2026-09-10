# Hybrid execution architecture: Linear-managed cloud + local Mac

**Status: decided, not yet implemented.** This document records the architecture
decision only. Nothing described here is enabled by adopting this document —
Loops, Coding Sessions, the dispatcher daemon's cloud lane, and auto-merge all
remain off until their own issues land. See §Rollout gates.

This is the authoritative statement of how `moviecal` executes engineering work.
It supersedes the "all implementation runs on this Mac" premise that
`docs/operators/local-execution.md` and
`docs/governance/linear-information-architecture.md` were written under. Those
documents remain accurate about the Mac path and the Linear workspace design;
this one governs where they now sit in a larger picture.

Tracking: `MOV-139` (coordination), `MOV-140` (this document), `MOV-141`
(feasibility validation), `MOV-142` (routing labels).

## The decision

One Linear-centered engineering lifecycle with **two execution backends**:

1. **Linear owns desired lifecycle state** — what to build, why, priority,
   acceptance criteria, Testing Expectations, dependencies, delegation, and the
   workflow state an issue is *supposed* to be in.
2. **GitHub owns delivered state** — branches, commits, pull requests, CI
   checks, code review, merges, releases. GitHub is the authority on whether
   work actually landed; Linear reflects it.
3. **Linear-managed cloud execution** handles eligible **non-iOS** work.
4. **The local Mac** handles Xcode/iOS work, and remains the fallback for
   anything the cloud lane cannot do.

Cloud and Mac are modelled as **execution adapters behind one behavioral
contract** (below), not two parallel systems with separate lifecycles. An issue
is executed by exactly one adapter, and both report into the same Linear states
and the same GitHub PR flow.

**What exists today vs. what this describes.** Only the **Mac adapter** is built
and running (`docs/operators/local-execution.md`). The behavioral contract below
is **normative** — the spec any adapter must meet — not a description of
something enforced across two adapters today. Nothing validates a candidate
adapter against it yet; that is `MOV-153`–`MOV-155`'s job when the cloud lane is
piloted. Read the contract as the requirement the cloud adapter is being held
to, and the property the Mac adapter is already checked against by virtue of
being the thing the contract was written from.

**The cloud lane cannot build, test, or ship iOS.** Xcode, the iOS Simulator,
and the self-hosted macOS runner exist only on the Mac. No amount of cloud
capability changes this; the Mac lane is permanent, not transitional.

## Source-of-truth boundaries

Extends the table in `docs/governance/linear-information-architecture.md`:

| Domain | Authority |
|---|---|
| What to build, why, priority, acceptance criteria, discussion, decisions, **desired** status, release planning, agent delegation, human ownership | **Linear** |
| Source code, tests, CI config, dispatcher code, testing lanes, security constraints, coding conventions, `AGENTS.md`, architecture docs | **Git repository** |
| Branches, commits, PRs, code review, CI results, releases, external bug intake — **delivered** state | **GitHub** |
| Which adapter executes a given issue | **Linear label** (`execution:*`, `MOV-142`), materialized before dispatch |
| Live agent progress narration, tool calls, intermediate reasoning | **Run logs** — dispatcher run logs (Mac) or Linear Agent Session activity (cloud); referenced from Linear, never authoritative |

Where Linear and GitHub disagree about whether something shipped, **GitHub
wins** and Linear is corrected to match. Where they disagree about whether
something *should* ship, **Linear wins**.

## The execution adapter contract

This section is **normative and forward-looking**. It states what any execution
adapter must do. The Mac adapter meets it today (it is the reference
implementation the contract was extracted from); the cloud adapter must be shown
to meet it before it carries real work (§Rollout gates, stage 7).

An execution adapter is anything that satisfies:

> Given a Linear issue (identifier, description, acceptance criteria) and a
> target branch, produce commits on that branch, open a pull request that
> references the issue, report lifecycle transitions back to Linear, and
> terminate.

Both adapters must:

- Branch from `origin/master` using the repo's branch-prefix conventions
  (`docs/operators/branch-prefixes.json`).
- Open a PR carrying a `Linear: MOV-NNN` reference and a filled-in **Test
  Impact** section (`.github/pull_request_template.md`).
- Pass the same required GitHub checks. There is **no** adapter-specific CI
  gate and no adapter-specific merge path.
- Honour the same hard-deny boundaries (`docs/operators/local-execution.md`
  §Security model). Enforcement *mechanism* differs per adapter; the
  *boundary* does not.
- Write anything that matters to Linear or the repo before terminating. No
  agent conversation is a source of truth.

Adapter differences are **properties**, not contract changes:

| Property | Mac adapter | Cloud adapter |
|---|---|---|
| iOS / Xcode capable | yes | **no** |
| Runs on | local Mac, `launchd` dispatcher, isolated git worktree | Linear-managed cloud sandbox |
| Worker binaries | `claude`, `codex` (`docs/operators/worker-routing.md`) | Linear Coding Session |
| Containment | `.claude/settings.json` deny rules (Claude), `--sandbox workspace-write` (Codex) | Linear's sandbox |
| Local secrets (`~/.config/moviecal/`) | available | **not** available |
| Quota / cost | provider subscriptions, local CPU | Linear plan tier + AI credits |
| Concurrency | dispatcher `concurrencyLimit` | Linear-managed |

An issue that needs a local secret, the iOS runner, or Xcode is **not**
cloud-eligible, regardless of its subject matter.

## Component roles

| Component | Role |
|---|---|
| **Linear issue** | The unit of work. Carries spec, acceptance criteria, Testing Expectations, dependencies, and the execution route. |
| **Linear project / milestone** | Sequencing and release grouping. `blocks` relations, not milestones, gate dispatch. |
| **Loops** | Intake, enrichment, and platform-splitting automation — triage raw intake into routed, spec'd issues. *Not enabled; gated on `MOV-141`.* |
| **Agent Sessions** | Linear's richer surface for an agent's lifecycle on an issue — sessions, activities, prompts, stop signals, stale-session handling, PR linking. **Not used today.** The dispatcher currently acts through the ordinary GraphQL API as the `moviecal-dispatcher` app actor (`MOV-122`): comments + workflow-state changes, nothing more. The Agent Session interaction model is Developer Preview and is only *needed* for cloud/Loop delegation — see §Feasibility gates. |
| **Linear Coding Session** | The cloud execution adapter. *Not enabled; gated on `MOV-141`.* |
| **Local dispatcher** | The Mac execution adapter. Built and running (`MOV-120`); polls `Ready for Agent`, promotes from `Backlog` (`MOV-129`), provisions worktrees, spawns workers. |
| **GitHub checks** | The merge gate. `master-protection` requires `lane-baseline`, `lane-unit`, `lane-integration`, `lane-browser`, `lane-review`, with `bypass_actors: []`. Identical for both adapters. |
| **`AGENTS.md` + repo docs** | Rules that must hold even when Linear is unreachable. |

## Routing

**`MOV-142` owns the routing label schema.** This section states the *intent*
the schema must satisfy; the exact label names, group semantics, inference
rules, and validation belong to that issue and may differ in detail.

The intent: every executable issue carries an explicit, auditable route —
proposed as three mutually-exclusive labels, one per adapter plus one for
"executes nowhere":

- **Mac** — iOS Companion App project, anything Xcode-dependent, anything
  needing a local secret or the self-hosted runner. This is also the default
  and the fallback: an issue whose route is unclear goes here.
- **Cloud** — eligible non-iOS work, once the cloud adapter is piloted and
  proven (§Rollout gates).
- **None** — coordination/umbrella issues that must never produce their own PR
  (e.g. `MOV-139`); excluded from the automated promoter.

The route may be *inferred* by rule but must be **materialized on the issue
before dispatch** so the decision is auditable after the fact. An issue with an
ambiguous or conflicting route fails validation rather than defaulting silently.

Sequencing is unchanged and adapter-independent: `blocks` relations plus the
dispatcher's preflight gates decide *when*; the route decides *where*.

## Feasibility gates

Every capability below is **unproven in this workspace** and must not be relied
on until `MOV-141` records it as supported. Each has a named fallback so the
architecture degrades rather than stalls.

| Capability | Status | Fallback if unsupported |
|---|---|---|
| Loops available on the workspace plan | unverified | Manual/`Triage` intake as today |
| Loop can delegate directly to the `moviecal-dispatcher` agent | unverified | Route label + dispatcher polling |
| Coding Session can be resumed/followed-up after CI or review feedback | unverified | Mac adapter takes the repair (`MOV-149`/`MOV-151`) |
| Agent Session lifecycle (create / activity / prompt / stop-signal / stale-session / PR-link) for a custom app actor — needed to drive and follow a cloud Coding Session | unverified, **Developer Preview** | The dispatcher's existing behaviour is already the fallback: act as the `MOV-122` app actor through the plain GraphQL API (comments + state changes) and let the Mac adapter carry the work. The gate applies to the *cloud* interaction model, not to anything running today. |
| Webhook delivery sufficient to replace polling | unverified | Retain 30s polling as the complete fallback |
| AI-credit consumption per cloud session | unmeasured | Cloud lane stays off |

**Developer Preview caveat.** Linear's custom Agent Session APIs are Developer
Preview. Nothing on the critical path may depend on them without a non-preview
fallback that is itself proven. A preview API breaking must degrade the system
to the Mac lane, never halt it. To be explicit about scope: the dispatcher does
**not** use these APIs today — it authenticates as the `MOV-122` app actor and
uses only stable GraphQL (`commentCreate`, `issueUpdate`). This gate constrains
what the *cloud* lane may build on, and retroactively condemns nothing.

**Plan and cost.** Loops and Coding Sessions are paid-tier capabilities
consuming Linear AI credits. Neither the required tier nor expected credit
consumption is established. **No upgrade is authorized by this document** —
`MOV-141` records the requirement and expected cost *before* any purchase or
enablement.

## Rollout gates

Staged; each gate must hold before the next opens. Every stage is independently
reversible.

1. **Architecture recorded** (this document) — docs only, nothing enabled.
2. **Feasibility validated** (`MOV-141`) — every capability marked supported,
   unsupported, or fallback-required, with cost recorded.
3. **Routing provisioned** (`MOV-142`) — `execution:*` labels exist, validation
   rejects conflicts, coordination issues excluded from promotion.
4. **Mac lane hardened** (`MOV-143`–`MOV-146`) — dispatch restricted to
   Mac-routed issues, singleton/crash-recovery, worker safety enforcement,
   service verified.
5. **Observation before action** (`MOV-147`, `MOV-148`, `MOV-152`) — CI/review
   state is observed and reported to Linear before anything reacts to it.
6. **Bounded repair** (`MOV-149`, `MOV-150`, `MOV-151`) — human-triggered
   repair first, then bounded automatic repair.
7. **Cloud pilots** (`MOV-153`–`MOV-155`) — low-risk docs/test work first, then
   web/server work, with an eligibility matrix published.
8. **Acceptance drills** (`MOV-161`), then risk-scoped auto-merge (`MOV-162`).

## Rollback

Component-by-component, no coordinated undo required:

| Turn off | Effect |
|---|---|
| Cloud route (`execution:cloud` → `execution:mac`) | All work returns to the Mac lane. No code change. |
| Loops | Intake returns to manual `Triage`. |
| Dispatcher daemon (`launchctl unload`) | No dispatch; issues accumulate in `Ready for Agent`. Humans work normally. |
| Automatic repair | Failures escalate to `Needs Human Decision` as today. |
| Auto-merge | Merges become manual; required checks unchanged. |

The repository, GitHub flow, and Linear issue data survive every rollback
unchanged. Nothing here introduces a one-way door.

## What this supersedes

- The premise that **all** implementation runs on the local Mac.
  `docs/operators/local-execution.md` is now the **Mac adapter's** operator
  guide, not the description of the whole execution model. Its content remains
  accurate and is not superseded in substance.
- The blanket rejection of **Linear Coding Sessions** in
  `docs/governance/linear-information-architecture.md` §Deliberately not
  adopted. Coding Sessions are now the intended cloud adapter — **subject to
  the feasibility gates above**, and never for iOS work.
- The blanket rejection of **Loops** on tier grounds in the same section. Loops
  are now a candidate for intake, gated on `MOV-141`.

Retired GitHub-Project-era material in `docs/operators/archive/` and
`docs/planning/archive/` is unaffected and remains historical reference only.
