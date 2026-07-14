# Agent coding platform comparison plan

## Status

**Experimental and partially unverified.** This document is a working
evaluation hypothesis maintained on `experiment/agent-platform-pilots`. It is
not authoritative operating policy and does not override `AGENTS.md`, the live
GitHub Project, or `docs/operators/`.

Merge a cleaned, evidence-backed version to `master` only after the early
GitHub-native and OpenHands milestones distinguish verified behavior from
assumptions. Follow
`docs/planning/agent-platform-pilot-development-workflow.md` while the pilots
are in progress.

## Purpose

This document defines the common evaluation contract for two agentic coding
platform pilots:

1. GitHub-native coding agents
2. OpenHands with a provider-neutral model path

The platform-specific plans define how each pilot is implemented. This document
defines what must remain comparable, what evidence must be captured, and how a
later adoption decision is made.

The comparison is about the complete delivery system, not only model price. A
platform succeeds when it turns a valid engineering task into an acceptable
pull request with low total cost and low operator effort while preserving the
repository's normal verification, review, security, and queue controls.

## Evaluation question

For small and medium, well-specified software tasks, which platform produces
the lowest **total cost per accepted pull request** without reducing quality or
requiring more human supervision than the maintainer is willing to provide?

Use this accounting model:

```text
total task cost =
  inference/model charges
  + platform and execution charges
  + CI/runner charges
  + retry and escalation charges
  + monetized human intervention time

cost per accepted PR =
  total cost across attempted tasks / accepted PR count
```

Record human minutes separately even if the initial decision does not assign a
dollar value to them. Subscription fees are reported as fixed monthly costs,
not misleadingly divided across a small pilot unless the allocation method is
stated.

## What is being compared

This is a **platform-level** comparison. Each platform may use the model-routing
feature that forms part of its value proposition:

- GitHub may use its native `Auto` selection after a fixed-model feasibility
  canary proves the basic worker path.
- OpenHands may use an explicit economy/standard/premium policy through its
  selected provider or gateway.

Do not require the two platforms to use the same model for the primary
comparison. A same-model, same-task harness experiment may be added later, but
it answers a different question and must be reported separately.

## Shared safety and workflow boundary

Until a later governance decision explicitly changes the repository contract:

- pilot issues use the existing direct-assignment path and keep
  `Agent Dispatch = No`
- the formal dispatch slot is not consumed, paused, or reinterpreted
- only a human or existing authorized orchestrator changes Project workflow
  fields
- every worker owns one issue, one branch, and one focused pull request
- normal branch protection, required checks, manual testing, review, and merge
  authority remain in force
- pilot work may not overlap the active dispatch issue or another open PR
- production secrets, private user data, and long-lived personal credentials
  are prohibited
- permanent queue/governance changes land separately from implementation PRs

A platform may automate its own pilot trigger without gaining authority to
select arbitrary repository work. The selected issue must already be approved
for that pilot run.

## Experimental stages

### Stage A: feasibility

Run one low-risk, merge-worthy canary on each platform. The goal is to prove:

- the worker receives the intended issue and repository instructions
- the execution environment can install dependencies and run required checks
- the worker creates a correctly scoped PR against `master`
- the normal review and merge path remains intact
- usage and cost evidence can be collected

One successful task proves feasibility only. It does not establish which
platform is cheaper.

### Stage B: matched canaries

Run at least two additional tasks per platform. Use different issues with
similar characteristics; never give the second platform an issue whose solution
is already visible in a merged PR.

Match tasks using:

- task category: docs/configuration, test work, bug fix, or feature
- target PR size
- risk
- expected file count
- required verification lanes
- dependency and secret requirements
- issue-contract completeness

Record any meaningful mismatch rather than pretending the samples are equal.

### Stage C: routed operation trial

After both platforms pass feasibility, allow their intended routing policy and
run enough approved work to observe:

- economy-model success rate
- escalation frequency
- cost of failed first attempts
- variance in human intervention
- reliability of unattended state transitions

Set the task count and spending cap before this stage starts. Do not let a
favorable or unfavorable early result silently change the sample.

## Canary selection

Every comparison issue must be legitimate work worth merging. For Stage A,
prefer a low-risk `XS` or `S` task with no external secrets, migrations, iOS
requirements, production infrastructure, or ambiguous acceptance criteria.

Before starting a run, record:

- issue number and Project fields
- `origin/master` commit
- task category and expected PR size
- relevant files and verification commands
- platform, harness, requested model policy, and effective model if known
- spending and time limits
- open PR/file-overlap check
- current dispatch-slot invariant

## Required measurements

Capture the following for every attempt, including failed and abandoned runs:

```text
comparison_run_id:
issue:
task_category:
expected_pr_size:
risk:
platform:
harness:
trigger_mode: manual | operator-triggered | event-triggered
routing_policy:
requested_model:
effective_model:
provider:
start_commit:
branch:
session_or_run_url:
pull_request:
started_at:
first_edit_or_first_progress_at:
pr_opened_at:
completed_at:
input_tokens:
cached_input_tokens:
output_tokens:
reasoning_tokens:
inference_cost_usd:
platform_cost_usd:
runner_or_actions_cost_usd:
total_metered_cost_usd:
human_setup_minutes:
human_supervision_minutes:
human_review_minutes:
automated_retries:
model_escalations:
ci_result:
manual_test_result:
first_pass_acceptable: yes | no
review_iterations:
human_code_repair_required: yes | no
merged: yes | no
outcome: accepted | rejected | stopped | infrastructure-failure
notes:
```

Use `unknown` rather than zero when a platform does not expose a measurement.
Unknown cost is itself a platform limitation and must be included in the final
assessment.

## Quality gates

A PR counts as accepted only when:

- it implements the issue acceptance criteria without material scope expansion
- required CI and issue-specific verification pass
- required manual checks pass
- security and secret-handling requirements are satisfied
- no maintainer-written code repair is required before merge, unless that
  repair is explicitly counted and the run is classified as not first-pass
- the resulting change is maintainable under the same standard as human work

Do not create an artificial review correction merely to test follow-up
behavior during cost-measurement runs. If a real correction is needed, record
it. Follow-up responsiveness can be tested in a separate feasibility run.

## Routing and escalation rules

Use a small, documented model portfolio rather than an unrestricted model
catalog:

- economy: mechanical, localized, low-risk work
- standard: ordinary implementation and debugging
- premium: architecture, security-sensitive work, or escalation

Prefer deterministic task metadata for routing. A cheap structured classifier
may classify uncategorized tasks, but it may not start implementation or mutate
queue state.

Escalate only on an explicit condition such as:

- verification failure after the allowed repair attempt
- worker-declared blocker or low confidence
- scope/risk boundary discovered during implementation
- tool-calling or context failure attributable to the selected model

Start escalation as a fresh run with a concise evidence packet. Do not carry an
unbounded conversation into a more expensive model.

## Decision criteria

Do not select a winner from one PR. After the agreed sample completes, compare:

1. accepted PRs per attempted task
2. total metered cost per accepted PR
3. human minutes per accepted PR
4. first-pass acceptance rate
5. escalation and retry rate
6. median and worst-case completion time
7. cost transparency and budget enforcement
8. instruction, environment, and CI reliability
9. security and operational burden
10. model/provider flexibility

The final decision may be one platform, a platform split by task class, or no
production adoption. Preserve the evidence even if a pilot is stopped.

## References

- `AGENTS.md`
- `docs/operators/multi-platform-dispatch-policy.md`
- `docs/planning/agent-platform-pilot-development-workflow.md`
- `docs/planning/github-native-agent-pilot-plan.md`
- `docs/planning/openhands-agent-pilot-plan.md`
- [GitHub: Optimizing AI usage](https://docs.github.com/en/copilot/tutorials/optimize-ai-usage)
- [OpenHands Index](https://index.openhands.dev/)
