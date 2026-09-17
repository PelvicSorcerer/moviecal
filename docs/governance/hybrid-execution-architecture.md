# Local-first execution architecture with a deferred cloud option

**Status: active.** The Mac dispatcher is the only enabled implementation
adapter. Linear Coding Sessions are a separately deferred option, not a
dependency of local delivery. The filename is retained because it is linked
from completed hybrid-foundation issues and decision records.

This document is the authoritative statement of how `moviecal` turns Linear
work into repository changes. `docs/operators/local-execution.md` is the
detailed Mac operator guide, and
`docs/governance/linear-information-architecture.md` governs Linear planning
objects.

## The current decision

1. **Linear owns desired state:** intake, specification, priority, dependencies,
   execution route, delegation, milestones, discussion, and the workflow state
   an issue is supposed to occupy.
2. **GitHub owns delivered state:** branches, commits, pull requests, required
   checks, reviews, merges, releases, and whether work actually landed.
3. **The local Mac is the active execution adapter.** It runs installed Codex
   or Claude workers for explicitly Mac-routed issues.
4. **Linear Coding Sessions are deferred.** Their environment, kickoff, pilots,
   repair evidence, and eligibility matrix are isolated in
   **Deferred Linear cloud execution option**, with every delivery issue in
   `Icebox` until a capped pilot is explicitly authorized.
5. **Loops and Agent Sessions do not define dispatch authority.** A Loop may
   enrich intake and a separately bounded handoff may set route/delegation.
   Agent Sessions may improve presentation, stop latency, and steering. Manual
   or Triage intake, the deterministic promoter, polling, ordinary Linear
   state/comments, and GitHub reconciliation remain a complete path when either
   feature is disabled or unavailable.

Cloud and Mac still share a behavioral contract if cloud work is later
activated: the same branch conventions, PR template, required checks,
hard-deny boundaries, and GitHub merge authority. That contract does not make
cloud execution part of today's release path.

## Current project topology

All development-system projects belong to the cross-cutting initiative
**Automate moviecal Development and Delivery**. They do not belong to a product
initiative merely because they support product work.

| Project | State | Purpose |
|---|---|---|
| **Local development workflow stabilization and governance** | Completed | Historical bounded stabilization and Mac-lane handoff |
| **Hybrid workflow foundations (completed)** | Completed | Historical architecture, routing, CI/review, and Agent Session foundations |
| **Autonomous local-agent delivery** | Active | Finish the local-first intake, handoff, acceptance, and controlled-autonomy outcome |
| **Deferred Linear cloud execution option** | Deferred / Backlog, issues in `Icebox` | Preserve an independently authorizable Coding Session option that never blocks local delivery |
| **Developer Governance & Agent Infrastructure** | Canceled | Original audit container; no new issues |

Completed projects are history, not maintenance buckets. Do not reopen or
repopulate them for later bugs. A new finite outcome belongs in a new bounded
project or the appropriate ordinary product backlog.

### Active local milestones and gates

**Automated intake & local kickoff**

- `MOV-219` records this architecture.
- `MOV-219` gates `MOV-156`, the least-privilege Loop intake-enrichment
  configuration. The Loop has no Coding Session permission.
- `MOV-156` gates `MOV-220`, the bounded Loop-to-Mac handoff.
- Disabling Loop/handoff automation must leave manual or Triage intake plus the
  promoter and dispatcher complete.

**Local acceptance & controlled autonomy**

- `MOV-160` settles manual-testing and draft-to-ready policy for local work.
- `MOV-220`, `MOV-160`, and the completed local routing, recovery, repair,
  reconciliation, and Agent Session foundations gate `MOV-161`.
- `MOV-161` proves the local lifecycle and its fallbacks end to end.
- `MOV-161` gates `MOV-162`, the final narrowly scoped automatic
  readiness/merge capability.

The local project ends when those two milestones satisfy their exit criteria.
It does not wait for any Coding Session issue, and later dispatcher maintenance
does not keep the project open.

### Deferred cloud milestones and gates

**Cloud environment & kickoff**

- `MOV-153` proves the repository environment, permissions, branch/PR
  behavior, disablement, and capped cost.
- `MOV-153` gates `MOV-157`, an idempotent cloud-only kickoff for explicit
  `execution:cloud` work.

**Cloud pilots & eligibility**

- `MOV-157` gates the low-risk pilot `MOV-154`.
- `MOV-154` gates the meaningful web/server pilot and eligibility matrix
  `MOV-155`.

These issues remain in `Icebox` together. No edge from this deferred chain may
block `MOV-156`, `MOV-220`, `MOV-161`, `MOV-162`, or completion of the
active local project. Promoting cloud work is a deliberate scope decision, not
an incidental consequence of its priority or milestone position.

## Source-of-truth boundaries

| Domain | Authority |
|---|---|
| What to build, why, priority, acceptance criteria, dependencies, desired status, release planning, route, delegation, and human ownership | **Linear** |
| Source code, tests, CI config, dispatcher code, security constraints, `AGENTS.md`, and architecture docs | **Git repository** |
| Branches, commits, PRs, checks, reviews, merges, releases, and delivered state | **GitHub** |
| Which adapter may execute an issue | Exactly one materialized Linear label: `execution:{mac,cloud,none}` |
| Which actor may start a local worker | Linear `delegate = moviecal-dispatcher`, independently of the route |
| Intermediate narration and live controls | Dispatcher logs and optional Agent Session activity; never durable authority |

When Linear and GitHub disagree about whether something shipped, **GitHub
wins** and Linear is reconciled. When they disagree about whether something
should ship, **Linear wins**.

## Local dispatch boundary

The local dispatcher may start a worker only when all ordinary readiness and
dependency checks pass **and** both of these independent conditions hold:

1. the issue carries exactly one materialized `execution:mac` label; and
2. the issue is delegated to `moviecal-dispatcher`.

A workflow-state change alone grants nothing. Route answers *where* work may
run; delegate answers *who* may drive it. The dispatcher re-reads both before a
consequential mutation so a mid-flight change becomes a safe stop/no-op.

Current project defaults are deliberately local-first:

- **Mac:** Shared Watchlists, Calendar Feed, Platform & Infrastructure, iOS
  Companion App, Autonomous local-agent delivery, and any Xcode, simulator,
  self-hosted-runner, or local-secret work.
- **Cloud:** Deferred Linear cloud execution option only. Its implementation
  issues stay in `Icebox` until authorized.
- **None:** bounded coordination issues labeled `type:coordination`; these
  also carry `execution:none` and produce no implementation PR.

Inference is advisory. The label must still be materialized before execution.
Do not place Mac work in the deferred-cloud project or cloud work in an active
local/product project merely to override the project boundary with a label;
move the issue to the project that owns its actual outcome.

## Execution contract

The active Mac adapter, and any future cloud adapter, must:

- branch from `origin/master` using
  `docs/operators/branch-prefixes.json`;
- open one scoped PR with `Linear: MOV-NNN` and a complete **Test Impact**
  section;
- run the same required GitHub checks and use the same merge path;
- honor the same hard-deny boundaries in
  `docs/operators/local-execution.md` §Security model;
- keep the issue, branch, and PR as durable identity; and
- write material results to Linear or the repository before terminating.

The current capabilities differ:

| Property | Active Mac adapter | Deferred Coding Session adapter |
|---|---|---|
| Status | Enabled | Disabled / `Icebox` |
| Worker | Installed Codex or Claude | Linear Coding Session |
| iOS / Xcode | Supported | Never supported |
| Local dev secrets / self-hosted runner | Supported under dispatcher policy | Unavailable |
| Claim authority | `execution:mac` + dispatcher delegate | Future cloud kickoff, after `MOV-153`/`MOV-157` |
| Recovery | Polling, retained worktrees, same-branch repair, GitHub reconciliation | Must be proven by cloud pilots |

## Additive Linear capabilities

### Loops

`MOV-156` and `MOV-220` are active local-delivery work, not cloud work.
Their bounded roles are:

- enrich intake and draft a complete specification;
- classify/split work and materialize an execution route;
- after a separate authorized handoff, delegate an eligible
  `execution:mac` issue to `moviecal-dispatcher`.

The Loop must have no Coding Session permission and must not directly widen
worker permissions. Manual/Triage intake and the promoter remain the complete
fallback. A Loop run is never itself proof that an issue is dispatchable.

### Agent Sessions

The signed Vercel receiver and the Mac's outbound authenticated stream were
implemented under `MOV-159` and `MOV-166` (split across `MOV-217`,
`MOV-216`, and `MOV-215`). They may provide semantic activity, fast stop
delivery, and bounded mid-run prompts.

They remain additive:

- the Mac exposes no public inbound listener;
- polling and ordinary comments/state remain permanently active;
- the receiver holds no authoritative lifecycle state;
- losing the receiver or stream must not block dispatch;
- prompt content cannot alter the fixed sandbox, permission, or security
  boundary; and
- turning `MOVIECAL_AGENT_SESSIONS` off returns to the complete polling path.

See `docs/governance/mov-159-agent-session-receiver-decision.md` and
`docs/operators/local-execution.md` for the security and operating details.

## Rollback and disablement

| Turn off | Result |
|---|---|
| Loop intake/handoff | Intake returns to manual/Triage plus promoter; local dispatch remains available |
| Agent Sessions / stream | Lifecycle remains available through polling, state, and comments |
| Dispatcher daemon | Issues accumulate without mutation until a human restarts it or works manually |
| Automatic repair | Failures escalate for human action |
| Automatic readiness/merge | Review and merge remain manual |
| Future cloud option | Deferred issues remain in `Icebox`; local delivery is unchanged |

No optional component is allowed to become a hidden prerequisite of the active
local path.

## Historical context and MOV-139

`MOV-139`, **Deliver the hybrid Linear cloud and local Mac agent workflow**,
was the original 24-issue coordination parent. It was coordination-only and was
never supposed to produce an implementation PR. Its context is preserved by
the completed **Hybrid workflow foundations (completed)** project, the issue's
description/history, `MOV-140`'s architecture decision, `MOV-141`'s dated
capability evidence, and the completed routing/CI/Agent-Session issue graph.

The earlier design expected cloud and Mac delivery to converge in one active
hybrid project. The later local-first decision did not erase that work:

- completed foundations remain completed history;
- unfinished cloud environment, kickoff, and pilots moved intact to
  **Deferred Linear cloud execution option**;
- unfinished local intake, acceptance, and autonomy work moved to
  **Autonomous local-agent delivery**; and
- the original **Developer Governance & Agent Infrastructure** project remains
  canceled for audit history.

Do not recreate MOV-139 as an umbrella, reopen the completed foundation
project, or make cloud completion a local-release exit criterion.
