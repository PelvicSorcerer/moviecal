# Hybrid execution architecture: Linear-managed cloud + local Mac

**Status: decided and partially implemented.** Routing, the Mac adapter,
CI/review observation, bounded repair, and the polling/comment lifecycle are in
place. Coding Sessions, the cloud kickoff/pilots, the authorized Agent Session
receiver, and auto-merge remain behind their own issue gates. See §Rollout
gates.

This is the authoritative statement of how `moviecal` executes engineering work.
It supersedes the "all implementation runs on this Mac" premise that
`docs/operators/local-execution.md` and
`docs/governance/linear-information-architecture.md` were written under. Those
documents remain accurate about the Mac path and the Linear workspace design;
this one governs where they now sit in a larger picture.

The **Hybrid Linear cloud + Mac workflow** project is the authoritative
coordination object. `MOV-139` is retained as canceled historical context and
must not produce an implementation PR. `MOV-140` records the architecture,
`MOV-141` records the original feasibility validation, and `MOV-142`/`MOV-143`
own route provisioning and enforcement.

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

**What exists today vs. what this describes.** The **Mac adapter** is built and
running (`docs/operators/local-execution.md`), and the shared routing,
observation, repair, and reconciliation foundations are implemented. The cloud
adapter is not yet enabled. The behavioral contract below is **normative** —
`MOV-153`–`MOV-155` must prove a Coding Session satisfies it before ordinary
work uses the cloud lane.

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
| Which adapter executes a given issue | **A Linear route label** (`execution:{cloud,mac,none}`, `MOV-142`); materialized on the issue before dispatch and enforced there (`MOV-143`) |
| Who may drive a given issue's lifecycle locally | **The Linear `delegate` field** — `moviecal-dispatcher` is the one local dispatcher writer (`MOV-143`) |
| Live agent progress narration, tool calls, intermediate reasoning | **Run logs** — dispatcher run logs (Mac) or Linear Agent Session activity (cloud); referenced from Linear, never authoritative |

Where Linear and GitHub disagree about whether something shipped, **GitHub
wins** and Linear is corrected to match. Where they disagree about whether
something *should* ship, **Linear wins**.

## The execution adapter contract

This section is **normative and forward-looking**. It states what any execution
adapter must do. The Mac adapter meets it today (it is the reference
implementation the contract was extracted from); the cloud adapter must be shown
to meet it before it carries real work (§Rollout gates, stages 4–5).

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
| Containment | shared macOS Seatbelt worker guard + native no-network command sandboxes + credential stripping + transcript/diff audit + dispatcher-only Git/publication (MOV-145) | Linear's sandbox; must prove the same behavioral boundary before pilot |
| Local secrets (`~/.config/moviecal/`) | available | **not** available |
| Quota / cost | provider subscriptions, local CPU | Linear plan tier + AI credits |
| Concurrency | dispatcher `concurrencyLimit` | Linear-managed |

An issue that needs a local secret, the iOS runner, or Xcode is **not**
cloud-eligible, regardless of its subject matter.

## Component roles

| Component | Role |
|---|---|
| **Linear issue** | The unit of work. Carries spec, acceptance criteria, Testing Expectations, dependencies, and the execution route. |
| **Linear initiative** | Strategic roll-up across finite projects. Development automation is cross-cutting and belongs to `Automate moviecal Development and Delivery`, not a product initiative. |
| **Linear project** | One finite, completable outcome. The project is the coordination object; do not duplicate it with an umbrella issue. |
| **Linear milestone** | One project-local phase with exit criteria. Display order communicates the plan; `blocks` relations gate execution. |
| **Parent issue** | One bounded deliverable split into child issues/PRs, never a substitute for a project or milestone. |
| **Loops** | Available candidate intake/enrichment automation. `MOV-156` is optional paid `Icebox` work and is not a kickoff or acceptance dependency. |
| **Agent Sessions** | Optional presentation/latency enrichment over the durable issue/PR/branch lifecycle. `MOV-159` authorized the receiver architecture and `MOV-166` owns implementation/live validation; polling and app-actor comments remain the complete fallback. |
| **Linear Coding Session** | The intended cloud execution adapter. The Basic plan is eligible and the workspace feature is on, but no moviecal environment or AI-credit pilot has been verified; `MOV-153` remains the configuration gate. |
| **Local dispatcher** | The Mac execution adapter. Built and running (`MOV-120`); polls `Ready for Agent`, promotes from `Backlog` (`MOV-129`), provisions worktrees, spawns workers. |
| **GitHub checks** | The merge gate. `master-protection` requires `lane-baseline`, `lane-unit`, `lane-integration`, `lane-browser`, `lane-review`, with `bypass_actors: []`. Identical for both adapters. |
| **`AGENTS.md` + repo docs** | Rules that must hold even when Linear is unreachable. |

## Routing

**`MOV-142` owns the routing label schema.** It provisioned the exact
`execution:{cloud,mac,none}` labels, group semantics, inference rules, and
validation used below.

The intent: every executable issue carries an explicit, auditable route —
three mutually-exclusive options, one per adapter plus one for "executes
nowhere":

- **Mac** — iOS Companion App project, anything Xcode-dependent, anything
  in Local development workflow stabilization and governance, anything needing
  a local secret or the self-hosted runner. This is also the default and the
  fallback: an issue whose route is unclear goes here.
- **Cloud** — eligible non-iOS work, once the cloud adapter is piloted and
  proven (§Rollout gates).
- **None** — coordination/umbrella issues that must never produce their own PR
  and are excluded from the automated promoter. `MOV-139` is a canceled
  historical example; the hybrid project now owns project-wide coordination.

The route may be *inferred* by rule, but it is **materialized on the issue
before dispatch** so the decision is auditable after the fact, with an
ambiguous or conflicting route failing validation rather than defaulting
silently. `MOV-142` provisioned the labels and the inference/validation logic;
`MOV-143` made materialization a hard precondition for dispatch. Inference is
advisory and never satisfies the gate on its own.

Routing answers *which* adapter; it does not by itself answer *who may write*.
`MOV-143` pairs it with a second, independent condition — the issue's Linear
**delegate** — so that the two together give exactly one routing authority (the
`execution:*` label) and exactly one local dispatcher writer (the
`moviecal-dispatcher` delegate). Neither is a lock, and neither is implied by a
workflow-state change: Linear offers no compare-and-set on state, so moving an
issue to `Agent Working` reports a claim rather than establishing one. Any
future adapter must bring its own writer identity rather than inheriting
"claim anything in `Ready for Agent`".

Sequencing is unchanged and adapter-independent: `blocks` relations plus the
dispatcher's preflight gates decide *when*; the route decides *where*.

The **Hybrid Linear cloud + Mac workflow** project is intentionally
mixed-route. Its project name cannot infer one adapter for every issue, so an
unlabelled issue safely infers Mac while either explicit `execution:cloud` or
`execution:mac` is valid. Semantic Mac-only constraints still win: an iOS,
Xcode, self-hosted-runner, or local-secret issue cannot be labelled cloud even
inside the hybrid project.

`MOV-142` provisions these routes as a mutually-exclusive Linear label group
(`execution:cloud` / `execution:mac` / `execution:none`) and supplies the
deterministic inference: `type:coordination` → `execution:none`; the iOS
Companion App and Local development workflow stabilization and governance
projects, Xcode/Simulator/runner work, and local-secret work → `execution:mac`;
supported non-iOS product projects → `execution:cloud`; the mixed hybrid
project and anything ambiguous → `execution:mac` until an explicit route is
materialized. Inference is advisory — the label must be materialized on the
issue to be authoritative.

`MOV-142` wired this into exactly one behaviour: an issue that infers
`execution:none` never auto-promotes. `MOV-143` added the second: the local
dispatcher claims **only** issues labeled `execution:mac` *and* delegated to
`moviecal-dispatcher`, silently skipping cloud-routed, coordination-only, and
differently-delegated issues, and escalating a missing or conflicting route on
an issue delegated to it. It re-reads the issue immediately before committing,
so a route or delegation changed mid-flight is a safe no-op rather than a lost
race. Applying the labels and delegations to the existing backlog is an
operator step, not part of that change — `dispatcher dry-run` reports exactly
which queued issues are executable (`docs/operators/local-execution.md`
§Dispatch trigger). An `execution:cloud` issue is not runnable until the cloud
lane passes the environment, kickoff, and pilot gates below.

## Feasibility gates

`MOV-141` performed the original validation on 2026-09-10; later workspace
availability and the `MOV-159` decision supersede the rows noted below.
"Available" is not the same as "ready": unconfigured or Developer Preview
surfaces stay behind their implementation gates, and each has a named fallback
so the architecture degrades rather than stalls. See
`docs/governance/mov-141-linear-capability-findings.md` for evidence and cost
details.

**These gates are asymmetric.** They govern optional cloud execution or richer
Linear presentation; none replaces the Mac adapter's durable polling/comment
path. If a capability below fails, the fallback is the already-operational Mac
lane and manual Linear workflow rather than a stalled delivery system.

| Capability | Status | Fallback if unsupported |
|---|---|---|
| Loops available on the workspace plan | **available, but not enabled for moviecal intake**; `MOV-156` is optional paid `Icebox` work | Manual/`Triage` intake as today |
| Loop can delegate directly to the `moviecal-dispatcher` agent | **not a required gate**; any future Loop must call the same bounded routing/delegation operation | **Proven:** write `execution:mac` + `moviecal-dispatcher` delegate; dispatcher polling reads both (`MOV-165`) |
| Coding Session can be resumed/followed-up after CI or review feedback | product-supported, but same-branch behavior **unproven in moviecal** until `MOV-153` | Human repairs the original cloud PR branch on the Mac; `MOV-149`/`MOV-157` must support existing cloud branches before automating the handoff |
| Agent Session lifecycle (create / activity / prompt / stop-signal / stale-session / PR-link) for the custom app actor | `MOV-159` decided **GO** on an authenticated hosted receiver; `MOV-166` is authorized but not implemented/live-validated | Continue stable app-actor GraphQL (issue fields, comments, states) and let the Mac adapter carry the work |
| Webhook delivery sufficient to replace polling | **deliberately no**; `MOV-166` may add an authenticated hosted receiver plus outbound Mac stream for latency, never authority | Retain 30s polling as the complete durable-workflow fallback; never expose the Mac directly |
| AI-credit consumption per cloud session | **known formula, not yet measured:** provider token cost + $0.25 per 20-minute sandbox block | Cloud pilot stays off until a human verifies/adds a capped balance and `MOV-153` records the first session's actual cost |

**Developer Preview caveat.** Linear's custom Agent Session APIs are Developer
Preview. Nothing on the durable control path may depend on them without the
proven polling/comment fallback. A preview API breaking must lose presentation
or latency, never issue/PR/branch identity or dispatch. `MOV-158` supplies the
feature-gated lifecycle bridge; `MOV-166` may enable it only after the approved
receiver passes live validation.

**Plan and cost.** Coding Sessions and Loops can consume paid capacity. Their
current UI availability does not authorize a subscription change, AI-credit
purchase, or automatic spend. `MOV-153` owns the capped Coding Session proof;
`MOV-156` remains optional paid `Icebox` work and must not become a hidden
hybrid dependency.

## Rollout gates

The rollout is a dependency graph, not a requirement to serialize every
adjacent milestone. Milestone order communicates the narrative; native issue
relations enforce only the hard gates below. Independent branches may advance
in parallel, and every component remains independently reversible.

1. **Architecture and feasibility** (`MOV-140`, `MOV-141`) — completed.
2. **Routing and Mac foundations** (`MOV-142`–`MOV-146`, plus repository-model
   alignment in `MOV-213`) — route labels, single-writer delegation, recovery,
   safety, and service behavior must be valid before unified kickoff.
3. **CI/review observation and bounded reaction** (`MOV-147`–`MOV-152`) —
   completed before pilots rely on merge reconciliation or repair.
4. **Cloud environment and kickoff** — `MOV-153` proves the environment, then
   `MOV-157` proves exactly-one route-aware kickoff and the Mac fallback.
5. **Cloud pilots** — `MOV-157` gates `MOV-154`; the low-risk pilot gates
   `MOV-155`, which publishes the eligibility matrix.
6. **Agent Session branch** — `MOV-159` authorized the receiver; `MOV-166`
   implements and live-validates it. This branch may run in parallel with the
   cloud work because polling/comments remain complete without it.
7. **Local handoff and policy** — local stabilization exits through
   `MOV-211` → `MOV-212`; `MOV-160` resolves testing/readiness policy. These may
   also proceed in parallel.
8. **Convergence and autonomy** — required cloud, Mac, Agent Session, policy,
   and local-handoff deliverables block `MOV-161`; acceptance drills then gate
   risk-scoped auto-readiness/merge in `MOV-162`.

`MOV-156` is excluded from this graph while it remains optional `Icebox` work.

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
- The blanket rejection of **Loops** on tier grounds in the same section.
  Loops are now available as an intake candidate, but `MOV-156` remains an
  optional paid experiment rather than a required delivery gate.

Retired GitHub-Project-era material in `docs/operators/archive/` and
`docs/planning/archive/` is unaffected and remains historical reference only.
