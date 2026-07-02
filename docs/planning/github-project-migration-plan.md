# GitHub Project migration plan

This document captures the planned transition from the current repo-driven execution queue to a GitHub Project-driven operating model.

Status: proposed migration plan.

## Goals

- Make GitHub Project the authoritative human-facing system for workflow, ordering, and dispatch.
- Keep GitHub issues as the authoritative execution contract for scoped work.
- Reduce repo docs to policy, guidance, architecture, and templates rather than live queue state.
- Preserve a strict machine-readable invariant so agents can start work without ambiguity.

## Transition rule

Until cutover is complete:

- GitHub Project is planning-only.
- The current repo model remains authoritative for agent dispatch.
- Agents must not infer execution order from the project yet.

This rule stays in place until project automation and repo doc updates land.

## Target operating model

Use four layers with distinct responsibilities:

### GitHub Project

Authoritative for:

- backlog state
- workflow status
- queue ordering
- dispatch selection
- grouping and reporting

### GitHub Issues

Authoritative for:

- background
- goal
- acceptance criteria
- verification steps
- relevant docs
- security notes
- out-of-scope boundaries
- dependency notes

### Automation

Authoritative for:

- sync enforcement
- dispatch uniqueness validation
- compatibility label sync during migration
- queue integrity checks

### Repo docs

Authoritative for:

- workflow policy
- orchestration rules
- templates
- architecture and planning context

Not authoritative for:

- live queue order
- live workflow state
- current dispatch target

## Project design

Recommended project name:

- `moviecal Delivery`

### Fields

- `Status`: `Backlog`, `Ready`, `In Progress`, `Review`, `Blocked`, `Done`
- `Priority`: `P0`, `P1`, `P2`, `P3`
- `Queue Order`: numeric ordering for execution priority
- `Track`: `Migration`, `Shared Watchlists`, `Calendar`, `Platform`, `Docs`, `Future`
- `Area`: `watchlist`, `calendar`, `auth`, `database`, `tests`, `deployment`, `docs`, `process`
- `Execution Mode`: `Agent`, `Human`, `Either`
- `Agent Dispatch`: `Yes`, `No`
- `Needs Infra/Secrets`: `Yes`, `No`
- `Risk`: `Low`, `Medium`, `High`
- `Target PR Size`: `XS`, `S`, `M`, `L`

### Field semantics

#### `Status`

- `Backlog`: shaped work that is not yet ready to execute
- `Ready`: executable work that satisfies readiness standards
- `In Progress`: implementation is underway
- `Review`: implementation is complete enough for review or manual testing
- `Blocked`: not executable due to dependencies, missing infra, or unresolved decisions
- `Done`: completed and closed

#### `Queue Order`

- Lower numbers mean earlier dispatch preference.
- Only items that could plausibly be dispatched should receive queue-order values.
- Draft future ideas can omit this field until they become real queue candidates.

#### `Execution Mode`

- `Agent`: intended for autonomous or semi-autonomous implementation
- `Human`: requires direct human execution or judgment
- `Either`: may be handled by either path

#### `Agent Dispatch`

- `Yes` marks the single issue a fresh agent may start.
- `No` marks every other issue.
- This field becomes authoritative after cutover.

## Recommended views

### Migration

Filter:

- `Track = Migration`

Purpose:

- manage rollout of the new operating model

### Dispatch Queue

Filter:

- open issues only
- `Execution Mode != Human`

Sort:

- `Queue Order` ascending

Purpose:

- show the ordered execution queue

### Ready

Filter:

- `Status = Ready`

Purpose:

- show shaped work that could become dispatch candidates

### In Progress

Filter:

- `Status = In Progress`

### Blocked

Filter:

- `Status = Blocked`

### Review

Filter:

- `Status = Review`

### Future

Filter:

- `Track = Future` or draft items without executable issue contracts

Purpose:

- hold forward-looking ideas that should not yet drive execution

## New invariant after cutover

After cutover:

- Exactly one open issue may have `Agent Dispatch = Yes`.
- That issue must also have `Status = Ready`.
- Agents start only from that issue.
- If no issue qualifies, the queue is intentionally blocked.

## Compatibility strategy

Recommended migration path:

- Keep `agent-ready` during migration.
- Make it a derived compatibility label.
- Automation syncs:
  - `Agent Dispatch = Yes` -> add `agent-ready`
  - `Agent Dispatch = No` -> remove `agent-ready`

Possible final state:

- either keep `agent-ready` as a compatibility surface
- or remove it later once all scripts and docs stop depending on it

## Project-to-label sync rules

This section is the authoritative compatibility policy for project metadata and retained issue labels during and after migration.

### Primary rule

- GitHub Project fields are the authoritative source for workflow state and dispatch state after cutover.
- Issue labels are not authoritative for workflow state after cutover.
- During migration, `agent-ready` remains the active dispatch label, but the target model is still project-first.

### Dispatch compatibility rule

- `Agent Dispatch = Yes` means the issue is the single dispatchable implementation issue.
- `Agent Dispatch = No` means the issue is not dispatchable.
- If compatibility labels are retained, `agent-ready` is derived from `Agent Dispatch`, not the other way around.

Required mapping:

- `Agent Dispatch = Yes` -> add label `agent-ready`
- `Agent Dispatch = No` -> remove label `agent-ready`

### Dispatch invariants

- Exactly one open issue may have `Agent Dispatch = Yes` after cutover.
- That same issue must also have `Status = Ready`.
- No closed issue may retain `Agent Dispatch = Yes`.
- No issue may be treated as dispatchable based only on `agent-ready` once cutover completes.

### Pre-cutover rule

Before cutover:

- `agent-ready` remains the operational dispatch gate.
- Project `Agent Dispatch` values should remain `No` for all items unless you are explicitly rehearsing the future model in a controlled way.
- The project may describe readiness, but it does not yet authorize execution by itself.

### Workflow-state rule

After cutover, workflow state belongs in the project only.

That means:

- do not create labels for `backlog`
- do not create labels for `ready`
- do not create labels for `in progress`
- do not create labels for `review`
- do not create labels for `blocked`
- do not create labels for `done`

Those concepts belong to the project `Status` field, not issue labels.

### Classification-label rule

Labels remain valid for classification and routing.

Recommended retained labels:

- `watchlist`
- `calendar`
- `auth`
- `database`
- `tests`
- `deployment`
- `docs`
- `security`

Optional retained labels:

- `blocked-external` if you need a cross-board signal that something is blocked by an external dependency

### Authoritative direction of sync

The sync direction is one-way:

- project -> label

Not:

- label -> project

That prevents operators from creating a second authoritative queue by toggling labels directly.

### Manual-edit rule

After automation lands:

- operators may still edit classification labels directly
- operators should not manually edit `agent-ready` except as a temporary recovery step when automation is unavailable
- any manual `agent-ready` correction should be reconciled back into the project field state immediately

### Closed-issue rule

When an issue closes:

- `Agent Dispatch` must resolve to `No`
- `agent-ready` must be absent

This prevents stale dispatch signals on completed work.

### Migration-era allowance

During migration, some issues may still carry `agent-ready` without project authority because the old model is still active.

That is allowed only until cutover.

Once cutover happens:

- treat `agent-ready` as derived compatibility metadata only
- treat project fields as the sole workflow/dispatch authority

### Failure handling rule

If project state and label state disagree:

Before cutover:

- the active repo-driven dispatch model wins for operational dispatch
- the inconsistency should be corrected quickly

After cutover:

- project state wins
- automation should correct the label state
- do not dispatch from the label alone

### Examples

Correct post-cutover example:

- Issue `#74` has `Status = Ready`
- Issue `#74` has `Agent Dispatch = Yes`
- Issue `#74` has label `agent-ready`
- every other open issue has `Agent Dispatch = No`

Incorrect post-cutover examples:

- two open issues have `Agent Dispatch = Yes`
- one issue has `Agent Dispatch = Yes` but `Status = Backlog`
- one issue has label `agent-ready` but `Agent Dispatch = No`
- an operator dispatches work from a label without reconciling the project state

## What changes in the repo

### Keep

- issue-as-contract workflow
- explicit acceptance criteria and verification
- security notes for sensitive work
- forward-looking planning docs as non-executable input

### Remove or deprecate

- hand-maintained live queue order in repo docs
- repo docs acting as the active execution queue
- status workflow encoded primarily through labels

### Candidate files to update

- `AGENTS.md`
- `docs/planning/AGENT_GUIDANCE.md`
- `docs/planning/agent-orchestration.md`
- `.github/ISSUE_TEMPLATE/agent_task.md`
- `docs/planning/open-issue-order.json`

## Migration phases

### Phase 0: Project bootstrap

- Create the GitHub Project and fields.
- Add recommended views.
- Add the migration items listed below.
- Add current live execution issue(s) to the project.

Authority during this phase:

- current repo model for dispatch

### Phase 1: Model the migration in the project

- Use the project to track the migration work itself.
- Keep project state advisory only.
- Do not let agents dispatch from project state yet.

### Phase 2: Implement sync and governance changes

- Add automation for dispatch uniqueness and label sync.
- Update docs so project becomes the queue source of truth.
- Update templates and scripts to align with the new model.

### Phase 3: Cutover

- Project becomes authoritative for queue status and ordering.
- Issues remain authoritative for execution contracts.
- Repo docs become policy-only for workflow guidance.
- `open-issue-order.json` is removed or becomes generated-only.

### Phase 4: Cleanup

- Remove obsolete queue language from docs.
- Simplify labels to classification only.
- Consider removing `agent-ready` if compatibility is no longer needed.

## Initial migration backlog

These should be the first project items, and likely the first migration issues if you want the rollout itself to be issue-driven.

1. Create and document the GitHub Project schema
2. Backfill current open issues into the project
3. Define project-to-label sync rules
4. Add automation to enforce a single dispatchable issue
5. Update repo docs so the project becomes queue source of truth
6. Deprecate `docs/planning/open-issue-order.json`
7. Update scripts that assume repo-local queue state
8. Remove old queue rules after cutover validation

Current live product issue to include immediately:

- `#74 Aggregate shared watchlists into calendar feeds and add shared-watchlist regressions`

## Platform compatibility track (after migration cutover)

These issues complete the multi-agent / multi-environment work from `docs/planning/agent-environment-compatibility-plan.md`. They are **not** feature-delivery items: do not label them `agent-ready` or add them to `docs/planning/open-issue-order.json`.

**Execution order** (also use as GitHub Project `Queue Order` values):

| Queue Order | Issue | Title | Blocked by | Notes |
|---:|---|---|---|---|
| 96 | #98 | Restructure agent docs: `docs/operators/` | — | PR #98 open. Finish during remaining migration items #93–#95 so project-as-queue docs land on the stable operator layout. |
| 97 | #102 | Define multi-platform agent dispatch policy | #95, #98 | Phase 5. Uses `Agent Dispatch` / `Execution Mode` language, not legacy `agent-ready` as primary authority. |
| 98 | #103 | Align Node.js version across agent platforms | #98 | Phase 4. Can run in parallel with #102 once #98 merges. |
| 99 | #104 | Consolidate Codex orchestration docs under `docs/operators/` | #95, #98, #102 | Phase 2 (deferred). Documentation consolidation only. |
| 100 | #105 | Verify GitHub Copilot coding agent against repo | #98, #102 | Replaces audit-only content in `docs/operators/github-copilot.md`. |
| 101 | #106 | Validate Codex operator tooling on Linux | #98 | Can run in parallel with #105 once #98 merges. |

**Migration items still in flight** (finish before or in parallel with Queue Order 96–97 as noted above):

| Queue Order | Issue | Title | Status |
|---:|---|---|---|
| 92 | #92 | Update repo docs so project becomes queue source of truth | Done (merged PR #101) |
| 93 | #93 | Deprecate `open-issue-order.json` | Open |
| 94 | #94 | Update queue-validation scripts | Open |
| 95 | #95 | Remove obsolete queue rules after cutover | Open |

**Suggested GitHub Project fields** when adding #98 and #102–#106:

| Issue | Status | Track | Area | Execution Mode | Agent Dispatch | Priority |
|---|---|---|---|---|---|---|
| #98 | In Progress (or Ready) | Platform | docs | Agent | No | P1 |
| #102 | Backlog | Platform | process | Human then Agent | No | P1 |
| #103 | Backlog | Platform | process | Agent | No | P2 |
| #104 | Backlog | Platform | docs | Agent | No | P2 |
| #105 | Backlog | Platform | process | Either | No | P3 |
| #106 | Backlog | Platform | process | Either | No | P3 |

**Concerns addressed in this sequencing:**

- **#98 is not duplicated** — it already exists (PR #98); the platform track starts there, not with a new issue.
- **#92/#101 is not duplicated** — project-as-queue authority stays in migration item 5; #102 only decides which *platforms* may receive `Agent Dispatch = Yes` after cutover.
- **Orchestration doc consolidation (#104) waits** until #95 and #102 so queue rules are not reorganized twice.
- **Product queue unchanged** — `#74` remains the live feature-delivery item; after cutover its dispatch state lives in the project `Agent Dispatch` field, not `open-issue-order.json`.

If the project API is unavailable from an automation token, add these items manually in the `moviecal Delivery` project with the `Queue Order` values above.

## Recommended initial project items

### 1. Create and document the GitHub Project schema

Suggested fields:

- `Status = In Progress`
- `Track = Migration`
- `Area = process`
- `Execution Mode = Human`
- `Agent Dispatch = No`
- `Risk = Medium`
- `Target PR Size = S`

Definition of done:

- project exists
- fields exist
- views exist
- field semantics are documented in repo docs

### 2. Backfill current open issues into the project

Suggested fields:

- `Status = Ready` for `#74`
- `Track = Shared Watchlists`
- `Area = calendar`
- `Execution Mode = Agent`
- `Agent Dispatch = No` during pre-cutover unless explicitly mirrored

Definition of done:

- all current open issues are present
- obvious metadata fields are set
- migration items are present too

### 3. Define project-to-label sync rules

Definition of done:

- clear mapping exists between project dispatch state and `agent-ready`
- clear policy exists for status vs labels
- status is not duplicated manually in labels

### 4. Add automation to enforce a single dispatchable issue

Definition of done:

- automation validates exactly one open item has `Agent Dispatch = Yes`
- automation validates that item is also `Status = Ready`
- automation flags invalid queue states

### 5. Update repo docs so the project becomes queue source of truth

Definition of done:

- agent workflow docs say project is authoritative for live queue state
- issues remain authoritative for task contract
- planning docs stop claiming queue authority

### 6. Deprecate `docs/planning/open-issue-order.json`

Definition of done:

- file is either removed or marked generated-only
- no workflow docs require humans to maintain it manually

### 7. Update scripts that assume repo-local queue state

Definition of done:

- agent queue validation scripts no longer assume repo-local order files are authoritative
- scripts read project-derived state or validate only dispatch invariants

### 8. Remove old queue rules after cutover validation

Definition of done:

- obsolete instructions are removed
- compatibility paths are either retained intentionally or deleted cleanly

## Transition rules

### Before cutover

- `agent-ready` remains authoritative for dispatch.
- `open-issue-order.json` remains the fallback ordering source.
- Project fields are advisory only.

### After cutover

- `Agent Dispatch = Yes` becomes authoritative for dispatch.
- `Status` and `Queue Order` become authoritative for workflow and sequencing.
- `agent-ready` becomes derived or is removed.
- `open-issue-order.json` is removed or generated-only.

## Cutover criteria

Do not switch authority until all of these are true:

- project exists with final fields and views
- current open work is represented in the project
- automation enforces the single dispatchable-item invariant
- repo docs explicitly say the project is the queue source of truth
- `open-issue-order.json` is no longer hand-maintained
- orchestrator workflow is updated to use project state

## Recommended label strategy after cutover

Use labels for classification, not workflow state.

Keep labels like:

- `watchlist`
- `calendar`
- `auth`
- `database`
- `tests`
- `deployment`
- `docs`
- `security`

Avoid using labels as the main source for:

- ready state
- in-progress state
- blocked state
- review state

Those should live in the project.

## Draft cutover wording for repo docs

Suggested policy statement:

> GitHub Project is the authoritative source for live queue state, workflow status, and execution order. GitHub issues remain the authoritative source for scoped task requirements, acceptance criteria, verification steps, and security notes. Repo planning docs describe policy and context only; they do not define the live execution queue.

Suggested dispatch statement:

> A fresh implementation agent may start only from the single open issue whose project item has `Agent Dispatch = Yes` and `Status = Ready`. If no such issue exists, the queue is intentionally blocked pending orchestrator action.

## Recommended next actions

1. Create the GitHub Project and fields.
2. Add the migration items from this document.
3. Add issue `#74` to the project.
4. Keep the current repo queue authoritative during setup.
5. Implement the migration issues in order.
6. Cut over only after the cutover criteria are met.

## Phase 0 bootstrap checklist

Use this checklist to create the project without changing repo/process authority yet.

### Step 1: Create the project

- Create a GitHub Project named `moviecal Delivery`.
- Set the project description to make the temporary transition rule explicit.

Suggested description:

> Operational delivery board for moviecal. During the GitHub Project migration rollout, this project is planning-only and the current repo-driven queue remains authoritative for dispatch until the cutover criteria in `docs/planning/github-project-migration-plan.md` are met.

### Step 2: Create the fields

Create these fields in this order:

1. `Status`
2. `Priority`
3. `Queue Order`
4. `Track`
5. `Area`
6. `Execution Mode`
7. `Agent Dispatch`
8. `Needs Infra/Secrets`
9. `Risk`
10. `Target PR Size`

### Step 3: Create the views

Create these views in this order:

1. `Migration`
2. `Dispatch Queue`
3. `Ready`
4. `In Progress`
5. `Blocked`
6. `Review`
7. `Future`

### Step 4: Seed the initial items

Seed the project with:

- the eight migration items in this document
- issue `#74`

Do not add draft future product items yet unless you want to use the `Future` view immediately for shaping.

### Step 5: Set the transition note visibly

Put the transition rule somewhere project operators will see it immediately:

- project description
- pinned project item
- or a top-of-board migration item

Recommended text:

> Transition rule: GitHub Project is planning-only until migration cutover. The current repo-driven queue model remains authoritative for agent dispatch.

## Initial field definitions

Use these exact option sets for the initial project bootstrap.

### `Status`

Options:

- `Backlog`
- `Ready`
- `In Progress`
- `Review`
- `Blocked`
- `Done`

### `Priority`

Options:

- `P0`
- `P1`
- `P2`
- `P3`

### `Queue Order`

Type:

- number

### `Track`

Options:

- `Migration`
- `Shared Watchlists`
- `Calendar`
- `Platform`
- `Docs`
- `Future`

### `Area`

Options:

- `watchlist`
- `calendar`
- `auth`
- `database`
- `tests`
- `deployment`
- `docs`
- `process`

### `Execution Mode`

Options:

- `Agent`
- `Human`
- `Either`

### `Agent Dispatch`

Options:

- `Yes`
- `No`

### `Needs Infra/Secrets`

Options:

- `Yes`
- `No`

### `Risk`

Options:

- `Low`
- `Medium`
- `High`

### `Target PR Size`

Options:

- `XS`
- `S`
- `M`
- `L`

## Initial view definitions

Use these view definitions for the first project setup.

### `Migration`

Type:

- board or table

Filter:

- `Track = Migration`

Sort:

- `Queue Order` ascending

### `Dispatch Queue`

Type:

- table

Filter:

- `Execution Mode` is not `Human`
- item is open when linked to an issue

Sort:

- `Queue Order` ascending

### `Ready`

Type:

- board

Filter:

- `Status = Ready`

Sort:

- `Queue Order` ascending

### `In Progress`

Type:

- board

Filter:

- `Status = In Progress`

Sort:

- `Queue Order` ascending

### `Blocked`

Type:

- board

Filter:

- `Status = Blocked`

Sort:

- `Queue Order` ascending

### `Review`

Type:

- board

Filter:

- `Status = Review`

Sort:

- `Queue Order` ascending

### `Future`

Type:

- board or table

Filter:

- `Track = Future`

Sort:

- `Priority` ascending

## Initial project items and starting values

Use these starting values when creating the first project items.

### Migration item 1

Title:

- `Create and document the GitHub Project schema`

Field values:

- `Status = In Progress`
- `Priority = P0`
- `Queue Order = 1`
- `Track = Migration`
- `Area = process`
- `Execution Mode = Human`
- `Agent Dispatch = No`
- `Needs Infra/Secrets = No`
- `Risk = Medium`
- `Target PR Size = S`

### Migration item 2

Title:

- `Backfill current open issues into the GitHub Project`

Field values:

- `Status = Backlog`
- `Priority = P0`
- `Queue Order = 2`
- `Track = Migration`
- `Area = process`
- `Execution Mode = Human`
- `Agent Dispatch = No`
- `Needs Infra/Secrets = No`
- `Risk = Low`
- `Target PR Size = S`

### Migration item 3

Title:

- `Define project-to-label sync rules for dispatch compatibility`

Field values:

- `Status = Backlog`
- `Priority = P0`
- `Queue Order = 3`
- `Track = Migration`
- `Area = process`
- `Execution Mode = Either`
- `Agent Dispatch = No`
- `Needs Infra/Secrets = No`
- `Risk = Medium`
- `Target PR Size = S`

### Migration item 4

Title:

- `Add automation to enforce a single dispatchable issue`

Field values:

- `Status = Backlog`
- `Priority = P0`
- `Queue Order = 4`
- `Track = Migration`
- `Area = process`
- `Execution Mode = Agent`
- `Agent Dispatch = No`
- `Needs Infra/Secrets = No`
- `Risk = High`
- `Target PR Size = M`

### Migration item 5

Title:

- `Update repo docs so the GitHub Project becomes the queue source of truth`

Field values:

- `Status = Backlog`
- `Priority = P1`
- `Queue Order = 5`
- `Track = Migration`
- `Area = docs`
- `Execution Mode = Agent`
- `Agent Dispatch = No`
- `Needs Infra/Secrets = No`
- `Risk = Medium`
- `Target PR Size = M`

### Migration item 6

Title:

- `Deprecate docs/planning/open-issue-order.json`

Field values:

- `Status = Backlog`
- `Priority = P1`
- `Queue Order = 6`
- `Track = Migration`
- `Area = docs`
- `Execution Mode = Either`
- `Agent Dispatch = No`
- `Needs Infra/Secrets = No`
- `Risk = Medium`
- `Target PR Size = S`

### Migration item 7

Title:

- `Update queue-validation scripts for the project-first model`

Field values:

- `Status = Backlog`
- `Priority = P1`
- `Queue Order = 7`
- `Track = Migration`
- `Area = process`
- `Execution Mode = Agent`
- `Agent Dispatch = No`
- `Needs Infra/Secrets = No`
- `Risk = High`
- `Target PR Size = M`

### Migration item 8

Title:

- `Remove obsolete queue rules after project cutover validation`

Field values:

- `Status = Backlog`
- `Priority = P2`
- `Queue Order = 8`
- `Track = Migration`
- `Area = process`
- `Execution Mode = Either`
- `Agent Dispatch = No`
- `Needs Infra/Secrets = No`
- `Risk = Medium`
- `Target PR Size = S`

### Current live product issue

Linked issue:

- `#74 Aggregate shared watchlists into calendar feeds and add shared-watchlist regressions`

Initial field values:

- `Status = Ready`
- `Priority = P0`
- `Queue Order = 74`
- `Track = Shared Watchlists`
- `Area = calendar`
- `Execution Mode = Agent`
- `Agent Dispatch = No`
- `Needs Infra/Secrets = No`
- `Risk = Medium`
- `Target PR Size = M`

Transition note for `#74`:

- keep `Agent Dispatch = No` during bootstrap if you want zero ambiguity that the project is not yet authoritative
- the current repo-driven `agent-ready` model remains the real dispatch gate during Phase 0 and Phase 1

## Recommended first operating posture

After project creation but before cutover:

- treat the `Migration` view as the main working surface for process redesign
- treat `Dispatch Queue` as advisory only
- keep using the existing repo model for any actual fresh agent dispatch
- avoid setting any project item to `Agent Dispatch = Yes` until the migration explicitly reaches cutover

## Phase 0 creation runbook

Use this runbook to create the project in one pass without making process decisions ad hoc during setup.

### Recommended setup order

1. Create the project shell and description.
2. Create all custom fields.
3. Create all saved views.
4. Add the eight migration items as draft items.
5. Add issue `#74` as a linked issue item.
6. Set initial field values for every seeded item.
7. Verify the transition note is visible and accurate.

### Recommended operator checklist

- Confirm before starting that the repo-driven queue remains authoritative.
- Avoid setting any item to `Agent Dispatch = Yes`.
- Avoid changing issue labels or repo docs during bootstrap.
- Keep the migration items as the primary active work in the project.
- Treat issue `#74` as visible backlog state, not as project-authoritative dispatch.

## Initial seed order

Add the initial items in this order so the project reads clearly from the top on first creation.

1. `Create and document the GitHub Project schema`
2. `Backfill current open issues into the GitHub Project`
3. `Define project-to-label sync rules for dispatch compatibility`
4. `Add automation to enforce a single dispatchable issue`
5. `Update repo docs so the GitHub Project becomes the queue source of truth`
6. `Deprecate docs/planning/open-issue-order.json`
7. `Update queue-validation scripts for the project-first model`
8. `Remove obsolete queue rules after project cutover validation`
9. linked issue `#74`

## Initial status layout

Use this starting layout immediately after seeding the project.

### `In Progress`

- `Create and document the GitHub Project schema`

### `Backlog`

- `Backfill current open issues into the GitHub Project`
- `Define project-to-label sync rules for dispatch compatibility`
- `Add automation to enforce a single dispatchable issue`
- `Update repo docs so the GitHub Project becomes the queue source of truth`
- `Deprecate docs/planning/open-issue-order.json`
- `Update queue-validation scripts for the project-first model`
- `Remove obsolete queue rules after project cutover validation`

### `Ready`

- linked issue `#74`

Interpretation:

- `Ready` on `#74` is descriptive only during bootstrap.
- It does not make the project authoritative for dispatch.
- The real dispatch gate remains the current repo-driven `agent-ready` model.

## Bootstrap verification checklist

The project bootstrap is complete when all of the following are true:

- the project exists with the intended description
- all ten custom fields exist with the intended option sets
- all seven saved views exist
- the eight migration items are present
- issue `#74` is present
- no item has `Agent Dispatch = Yes`
- the migration item for project schema is the only item in `In Progress`
- the project description or a visible item states the transition rule

## Suggested project notes item

If you want a visible non-issue reminder inside the project, create a draft item named:

- `Project note: transition rule`

Suggested body text:

> GitHub Project is planning-only during bootstrap and migration rollout. The current repo-driven queue remains authoritative for agent dispatch until the cutover criteria in `docs/planning/github-project-migration-plan.md` are met.

Suggested field values:

- `Status = In Progress`
- `Priority = P0`
- `Track = Migration`
- `Area = process`
- `Execution Mode = Human`
- `Agent Dispatch = No`
- `Needs Infra/Secrets = No`
- `Risk = Low`
- `Target PR Size = XS`

If you use this note item, keep it outside the numbered migration backlog and use it only as a pinned operator reminder.

## Phase 0 operator worksheet

Use this section as a compact reference while clicking through project setup in GitHub.

### Project shell

| Setting | Value |
| --- | --- |
| Name | `moviecal Delivery` |
| Description | `Operational delivery board for moviecal. During the GitHub Project migration rollout, this project is planning-only and the current repo-driven queue remains authoritative for dispatch until the cutover criteria in docs/planning/github-project-migration-plan.md are met.` |

### Fields

| Field | Type | Options |
| --- | --- | --- |
| `Status` | single select | `Backlog`, `Ready`, `In Progress`, `Review`, `Blocked`, `Done` |
| `Priority` | single select | `P0`, `P1`, `P2`, `P3` |
| `Queue Order` | number | none |
| `Track` | single select | `Migration`, `Shared Watchlists`, `Calendar`, `Platform`, `Docs`, `Future` |
| `Area` | single select | `watchlist`, `calendar`, `auth`, `database`, `tests`, `deployment`, `docs`, `process` |
| `Execution Mode` | single select | `Agent`, `Human`, `Either` |
| `Agent Dispatch` | single select | `Yes`, `No` |
| `Needs Infra/Secrets` | single select | `Yes`, `No` |
| `Risk` | single select | `Low`, `Medium`, `High` |
| `Target PR Size` | single select | `XS`, `S`, `M`, `L` |

### Views

| View | Type | Filter | Sort |
| --- | --- | --- | --- |
| `Migration` | board or table | `Track = Migration` | `Queue Order` ascending |
| `Dispatch Queue` | table | `Execution Mode != Human` and open issues only | `Queue Order` ascending |
| `Ready` | board | `Status = Ready` | `Queue Order` ascending |
| `In Progress` | board | `Status = In Progress` | `Queue Order` ascending |
| `Blocked` | board | `Status = Blocked` | `Queue Order` ascending |
| `Review` | board | `Status = Review` | `Queue Order` ascending |
| `Future` | board or table | `Track = Future` | `Priority` ascending |

### Initial items

| Item | Status | Priority | Queue Order | Track | Area | Execution Mode | Agent Dispatch | Needs Infra/Secrets | Risk | Target PR Size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Create and document the GitHub Project schema` | `In Progress` | `P0` | `1` | `Migration` | `process` | `Human` | `No` | `No` | `Medium` | `S` |
| `Backfill current open issues into the GitHub Project` | `Backlog` | `P0` | `2` | `Migration` | `process` | `Human` | `No` | `No` | `Low` | `S` |
| `Define project-to-label sync rules for dispatch compatibility` | `Backlog` | `P0` | `3` | `Migration` | `process` | `Either` | `No` | `No` | `Medium` | `S` |
| `Add automation to enforce a single dispatchable issue` | `Backlog` | `P0` | `4` | `Migration` | `process` | `Agent` | `No` | `No` | `High` | `M` |
| `Update repo docs so the GitHub Project becomes the queue source of truth` | `Backlog` | `P1` | `5` | `Migration` | `docs` | `Agent` | `No` | `No` | `Medium` | `M` |
| `Deprecate docs/planning/open-issue-order.json` | `Backlog` | `P1` | `6` | `Migration` | `docs` | `Either` | `No` | `No` | `Medium` | `S` |
| `Update queue-validation scripts for the project-first model` | `Backlog` | `P1` | `7` | `Migration` | `process` | `Agent` | `No` | `No` | `High` | `M` |
| `Remove obsolete queue rules after project cutover validation` | `Backlog` | `P2` | `8` | `Migration` | `process` | `Either` | `No` | `No` | `Medium` | `S` |
| `#74 Aggregate shared watchlists into calendar feeds and add shared-watchlist regressions` | `Ready` | `P0` | `74` | `Shared Watchlists` | `calendar` | `Agent` | `No` | `No` | `Medium` | `M` |

### Bootstrap stop conditions

Stop Phase 0 bootstrap and do not continue into cutover work until all answers are `yes`.

| Check | Expected |
| --- | --- |
| Project exists | yes |
| Description includes transition rule | yes |
| All 10 custom fields exist | yes |
| All 7 views exist | yes |
| 8 migration items added | yes |
| Issue `#74` added | yes |
| Every item has `Agent Dispatch = No` | yes |
| Only schema item is `In Progress` | yes |
| Current repo queue still treated as authoritative | yes |

## Issue-ready drafts for the migration backlog

These drafts are intended to be copied into GitHub issues with minimal editing.

### Migration issue 1

Title:

- `Create and document the GitHub Project schema`

Suggested project fields:

- `Track = Migration`
- `Area = process`
- `Execution Mode = Human`
- `Status = Backlog`
- `Agent Dispatch = No`
- `Queue Order = 1`

Draft body:

```md
Background:
The repo currently uses issue labels plus repo planning docs as the operational queue for agents. We want to migrate to a GitHub Project-first workflow without introducing ambiguity during the transition.

Goal:
Create the initial GitHub Project structure and document the field semantics, views, and transition intent so later migration work has a stable target model.

Relevant docs:
- docs/planning/github-project-migration-plan.md
- AGENTS.md
- docs/planning/AGENT_GUIDANCE.md
- docs/planning/agent-orchestration.md

Acceptance criteria:
- A GitHub Project exists for moviecal delivery and migration tracking.
- The project includes the agreed fields for status, ordering, execution mode, and dispatch.
- The project includes the agreed views for migration work, dispatch queue, in-progress work, blocked work, review, and future items.
- Repo documentation records the intended semantics of those fields and views.

Verification:
- Manual inspection of the created project fields and views
- Manual inspection that the schema matches the documented migration plan

Out of scope:
- Making the project authoritative for dispatch
- Automation or label sync
- Repo script changes

Notes:
- During this issue, the current repo queue model remains authoritative for agent dispatch.
```

### Migration issue 2

Title:

- `Backfill current open issues into the GitHub Project`

Suggested project fields:

- `Track = Migration`
- `Area = process`
- `Execution Mode = Human`
- `Status = Backlog`
- `Agent Dispatch = No`
- `Queue Order = 2`

Draft body:

```md
Background:
Once the project exists, the active queue and any relevant future work need to be represented there before the project can become useful as an operating surface.

Goal:
Populate the GitHub Project with the current open issue queue and the migration work itself using consistent field assignments.

Relevant docs:
- docs/planning/github-project-migration-plan.md
- docs/planning/AGENT_GUIDANCE.md
- docs/planning/agent-orchestration.md
- docs/planning/open-issue-order.json

Acceptance criteria:
- All current open implementation issues are present in the project.
- The migration issues are present in the project.
- Current items have consistent initial field values for status, track, area, execution mode, and dispatch.
- The current live implementation issue is visible in the project without changing the existing dispatch authority yet.

Verification:
- Manual inspection of the project item list and field assignments

Out of scope:
- Project automation
- Repo doc cutover
- Removing current repo queue artifacts
```

### Migration issue 3

Title:

- `Define project-to-label sync rules for dispatch compatibility`

Suggested project fields:

- `Track = Migration`
- `Area = process`
- `Execution Mode = Either`
- `Status = Backlog`
- `Agent Dispatch = No`
- `Queue Order = 3`

Draft body:

```md
Background:
The repo currently depends on the `agent-ready` label for agent dispatch. During migration, we need an explicit compatibility strategy so project state and label state do not drift or conflict.

Goal:
Define the authoritative mapping between project dispatch state and any retained issue labels, with a clear policy for which metadata remains label-based and which moves fully into the project.

Relevant docs:
- docs/planning/github-project-migration-plan.md
- docs/planning/issue-update-plan.md
- docs/planning/AGENT_GUIDANCE.md
- docs/planning/agent-orchestration.md

Acceptance criteria:
- The repo has a documented rule for how `Agent Dispatch` maps to `agent-ready`.
- The repo has a documented rule for which workflow states live only in the project.
- The repo has a documented classification-label policy for post-cutover issue labeling.

Verification:
- Manual review of the documented sync rules

Out of scope:
- Implementing the automation itself
- Updating all scripts
```

### Migration issue 4

Title:

- `Add automation to enforce a single dispatchable issue`

Suggested project fields:

- `Track = Migration`
- `Area = process`
- `Execution Mode = Agent`
- `Status = Backlog`
- `Agent Dispatch = No`
- `Queue Order = 4`

Draft body:

```md
Background:
Moving live queue state into a GitHub Project is only safe if automation enforces the dispatch invariant. Without that, the project becomes a second manual queue and will drift.

Goal:
Add automation that validates queue integrity and enforces the single-dispatchable-item invariant for the new project model.

Relevant docs:
- docs/planning/github-project-migration-plan.md
- AGENTS.md
- docs/planning/AGENT_GUIDANCE.md
- docs/planning/agent-orchestration.md

Acceptance criteria:
- Automation validates that exactly one open issue has `Agent Dispatch = Yes` after cutover.
- Automation validates that the dispatchable issue also has `Status = Ready`.
- Automation fails clearly when the queue is invalid.
- If compatibility labels are retained, automation can keep `agent-ready` synchronized with dispatch state.

Verification:
- Automated validation against valid and invalid test states, or documented dry-run evidence against real repo state

Security notes:
- Automation must not require repository secrets beyond what is necessary for GitHub metadata access.

Out of scope:
- Full repo doc cutover
- Removing old queue docs before validation is proven
```

### Migration issue 5

Title:

- `Update repo docs so the GitHub Project becomes the queue source of truth`

Suggested project fields:

- `Track = Migration`
- `Area = docs`
- `Execution Mode = Agent`
- `Status = Backlog`
- `Agent Dispatch = No`
- `Queue Order = 5`

Draft body:

```md
Background:
The current repo docs describe repo-local planning artifacts and issue labels as the active queue mechanism. Those instructions must change before the project can safely become authoritative.

Goal:
Update the repo guidance so the GitHub Project is the source of truth for live queue state while issues remain the source of truth for scoped execution contracts.

Relevant docs:
- docs/planning/github-project-migration-plan.md
- AGENTS.md
- docs/planning/AGENT_GUIDANCE.md
- docs/planning/agent-orchestration.md
- docs/README.md
- .github/ISSUE_TEMPLATE/agent_task.md

Acceptance criteria:
- Core repo workflow docs state that the GitHub Project is authoritative for live queue state, status, and ordering.
- Core repo workflow docs state that issues remain authoritative for background, acceptance criteria, verification, and security notes.
- Transition wording is removed or clearly limited to pre-cutover contexts.

Verification:
- Manual review of updated docs for consistency

Out of scope:
- Implementing project automation
- Removing all compatibility paths immediately
```

### Migration issue 6

Title:

- `Deprecate docs/planning/open-issue-order.json`

Suggested project fields:

- `Track = Migration`
- `Area = docs`
- `Execution Mode = Either`
- `Status = Backlog`
- `Agent Dispatch = No`
- `Queue Order = 6`

Draft body:

```md
Background:
`docs/planning/open-issue-order.json` currently acts as a repo-local queue artifact. In the project-first model, hand-maintained repo files should not remain authoritative for live queue ordering.

Goal:
Deprecate `docs/planning/open-issue-order.json` and either remove it or convert it into a generated compatibility artifact.

Relevant docs:
- docs/planning/github-project-migration-plan.md
- docs/planning/recommended-issue-sequence.md
- docs/planning/AGENT_GUIDANCE.md
- docs/planning/agent-orchestration.md

Acceptance criteria:
- The repo no longer requires humans to maintain `docs/planning/open-issue-order.json` as live queue state.
- The file is either removed or explicitly documented as generated-only or compatibility-only.
- Repo docs no longer point humans to that file as the live ordering source.

Verification:
- Manual review of docs and artifact handling

Out of scope:
- Removing future planning docs that are still useful as context
```

### Migration issue 7

Title:

- `Update queue-validation scripts for the project-first model`

Suggested project fields:

- `Track = Migration`
- `Area = process`
- `Execution Mode = Agent`
- `Status = Backlog`
- `Agent Dispatch = No`
- `Queue Order = 7`

Draft body:

```md
Background:
The repo includes queue-related workflow checks that assume the current issue-label and repo-file model. Those checks need to align with the project-first operating model.

Goal:
Update the repo’s queue-validation scripts and related operator tooling so they validate the new project-driven dispatch model rather than the old repo-local ordering model.

Relevant docs:
- docs/planning/github-project-migration-plan.md
- AGENTS.md
- docs/planning/AGENT_GUIDANCE.md
- docs/planning/agent-orchestration.md
- scripts/agent-check.sh
- scripts/agent-handoff-check.sh

Acceptance criteria:
- Queue-validation scripts no longer require repo-local ordering files as the authoritative queue source.
- Queue-validation scripts validate the intended post-cutover dispatch invariant.
- Any retained compatibility behavior is explicit and documented.

Verification:
- Script-level verification appropriate to the updated implementation

Out of scope:
- Changing unrelated operator-tooling behavior
- Replacing the issue-as-contract workflow
```

### Migration issue 8

Title:

- `Remove obsolete queue rules after project cutover validation`

Suggested project fields:

- `Track = Migration`
- `Area = process`
- `Execution Mode = Either`
- `Status = Backlog`
- `Agent Dispatch = No`
- `Queue Order = 8`

Draft body:

```md
Background:
After the project-first model is live and validated, any remaining repo-era queue rules should be intentionally removed so operators and agents do not have to interpret two systems forever.

Goal:
Clean up obsolete queue assumptions, compatibility rules, and outdated wording after the new model has proven stable.

Relevant docs:
- docs/planning/github-project-migration-plan.md
- AGENTS.md
- docs/planning/AGENT_GUIDANCE.md
- docs/planning/agent-orchestration.md

Acceptance criteria:
- Obsolete queue instructions are removed from the repo.
- Any retained compatibility paths are clearly intentional.
- The final workflow is documented in one coherent way across repo guidance.

Verification:
- Manual consistency review of final workflow docs and checks

Out of scope:
- Reopening migration design debates already settled by the cutover
```
