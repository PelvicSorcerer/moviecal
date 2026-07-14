# OpenHands provider-neutral coding agent pilot plan

## Status

**Experimental and partially unverified.** This runbook is maintained on
`experiment/agent-platform-pilots` while actual OpenHands, GitHub integration,
branch, provider, and cost behavior is tested. It is not authoritative
operating policy and does not override `AGENTS.md`, the live GitHub Project, or
`docs/operators/`.

Mark observations as verified only after a real run. Follow
`docs/planning/agent-platform-pilot-development-workflow.md` for branch and PR
handling during the experiment.

## Purpose and target state

This plan evaluates OpenHands as a model-neutral coding harness for unattended
issue-to-PR work. It uses progressive milestones so the maintainer can try and
inspect the runtime before event-triggered automation or model routing is
enabled.

Target state:

```text
approved task trigger
  -> deterministic validation
  -> OpenHands hosted sandbox
  -> selected model/provider
  -> implementation and verification
  -> PR
  -> bounded repair or model escalation
  -> human review and merge
```

Use OpenHands Cloud for the initial pilot to avoid making self-hosted runtime
operations part of the first comparison. A later decision may move the same
harness to self-hosted OpenHands and LiteLLM if volume justifies it.

Read `docs/planning/agent-platform-comparison-plan.md` for common evidence,
quality, cost, and task-selection requirements.

## Initial provider decision

Begin with one provider path only:

1. Prefer the OpenHands at-cost model provider for the first smoke run if it
   exposes sufficient per-run usage and cost data.
2. Otherwise use OpenRouter through the documented configurable model/base-URL
   path.
3. Evaluate Vercel AI Gateway or self-hosted LiteLLM only after the basic
   OpenHands lifecycle works.

Do not add multiple gateways to Milestone 1. Gateway comparison and coding
platform comparison are different experiments.

Select model IDs from the provider's current catalog at execution time. Record
the exact model and price; do not hardcode a planning-document model that may
be stale before the pilot runs.

## Workflow boundary

During the pilot:

- the issue remains `Agent Dispatch = No`
- an OpenHands trigger does not become queue authority
- only explicitly approved issue numbers may start a run
- the worker owns one issue, branch, and focused PR
- Project mutations, review, and merge remain human/existing-orchestrator work
- branch protections and required checks remain unchanged
- production secrets, private user data, and long-lived personal credentials
  are prohibited
- the OpenHands app/API and model provider receive least-privilege credentials
- pilot work may not overlap another active PR or worker branch

## Milestone 0: account, permissions, and cost-controls review

### Goal

Make the hosted runtime and billing boundary visible before allowing it to
write code.

### Work

1. Create or confirm the OpenHands Cloud account and inspect current plan
   limits.
2. Install the GitHub integration with access limited to the moviecal repo.
3. Review requested repository permissions and revoke unnecessary scope.
4. Configure a pilot-only OpenHands API key and model-provider credential.
5. Set the smallest practical gateway/provider spending cap and disable
   automatic top-up for the initial experiment.
6. Confirm usage, token, and cost reporting surfaces.
7. Confirm how to stop a conversation, revoke the API key, and remove GitHub
   access.
8. Verify the hosted runtime can use Node 24 and the repo's required bootstrap
   commands without exposing production secrets.
9. Determine whether OpenHands lets the operator configure a branch family. If
   it does not, plan to record the platform-assigned branch during the smoke
   run; do not guess a permanent prefix in advance.

### Maintainer checkpoint

The maintainer reviews the OpenHands dashboard, GitHub permissions, configured
model/provider, hard spending limit, and cancellation controls. No
implementation task starts.

### Exit criteria

- repository and provider access are least privilege
- a hard or operationally equivalent pilot spending limit exists
- usage evidence can be retrieved
- cancellation and credential revocation are understood

## Milestone 1: observable sandbox smoke run

### Goal

Let the maintainer observe OpenHands reading and operating the repository before
it is allowed to publish a production PR.

### Work

Launch one hosted conversation against a disposable pilot branch with a
read/inspect-and-verify task. The agent should:

- identify and report applicable repository instructions
- report the current branch and commit
- install dependencies using the approved bootstrap path
- run one safe, representative verification command
- report the actual platform-assigned branch name and prefix
- make no issue, Project, PR, or merge changes
- stop after reporting environment findings and measured cost

If OpenHands requires write access to operate, allow only an explicitly named
disposable branch and delete it after evidence is collected.

### Maintainer trial

The maintainer starts or approves the smoke conversation, watches its tool and
terminal activity in OpenHands, confirms the model/provider shown, and stops or
allows completion.

### Exit criteria

- repository instructions and starting state are correctly discovered
- bootstrap and representative verification work
- the maintainer can observe and cancel execution
- tokens, cost, runtime, and environment gaps are recorded
- the observed branch family is compared with
  `docs/operators/branch-and-ci-conventions.md`
- no production PR or queue mutation occurs

## Milestone 2: operator-triggered issue-to-PR canary

### Goal

Run one real, merge-worthy issue through OpenHands while keeping dispatch an
explicit maintainer action.

This is not a manual assignment workflow. The maintainer supplies an approved
issue number to one dispatcher action; the dispatcher performs validation,
launch, and evidence setup.

### Canary issue

Use the Stage A task profile from the shared comparison plan: legitimate,
low-risk, `XS` or `S`, dependency-free, secret-free, and fully specified. Keep
`Agent Dispatch = No`. Until the observed OpenHands branch family is added to
any affected path-restricted push workflow in a separate governance change,
choose a canary that does not depend on such a push trigger; normal required PR
checks must still pass.

### Work

Create a `workflow_dispatch` or small operator command that:

1. requires an issue number and explicit confirmation
2. confirms the issue is open and approved for the pilot
3. validates dependency data, file overlap, and absence of an existing run
4. captures the comparison baseline
5. creates an OpenHands Cloud conversation through the supported API
6. passes the issue contract, repository instruction entry points, base branch,
   verification commands, model, and cost ceiling
7. records the conversation URL and resulting branch/PR
8. never merges or selects another issue

### Maintainer trial

The maintainer triggers the dispatcher once, observes the OpenHands session,
reviews its PR and evidence, runs the manual checklist, and decides whether to
merge or abandon it.

### Exit criteria

- one operator action creates exactly one conversation
- the worker starts from the approved commit and issue
- a focused PR is opened against `master`
- required CI and manual testing pass
- cost and human-effort evidence is complete
- cancellation and abandonment leave no active worker or stale credential

## Milestone 3: event-triggered single-issue canary

### Goal

Prove unattended launch from one explicit repository event while retaining
human review and merge.

### Work

1. Choose a dedicated pilot label, command comment, or project-field
   transition that is separate from `Agent Dispatch`.
2. Reuse Milestone 2's eligibility, overlap, idempotency, and budget checks.
3. Atomically consume or lock the trigger before launching OpenHands.
4. Report run-started, blocked, PR-opened, stopped, and completed states.
5. Reject webhook redelivery and duplicate trigger events.
6. Allow a kill switch to disable new OpenHands launches without changing the
   normal queue.

### Maintainer trial

The maintainer applies the trigger to one approved issue, observes the run and
PR, then disables or leaves disabled further event dispatch until reviewing
the evidence.

### Exit criteria

- one event creates one run and one PR
- invalid or duplicated events perform no model work
- the kill switch and cancellation path work
- ordinary Project authority remains intact

## Milestone 4: explicit model tiers and escalation

### Goal

Evaluate the cost-efficient OpenHands design rather than merely running every
task on one premium model.

### Work

1. Select a current, tested model for each portfolio tier:
   economy, standard, and premium.
2. Route primarily from deterministic task metadata.
3. If metadata is insufficient, use a cheap structured classifier with no repo
   write or dispatch authority.
4. Start the worker once with the selected model and a hard task budget.
5. Permit at most the documented repair attempt before escalation.
6. On escalation, start a fresh OpenHands run with a concise packet containing
   the issue, relevant files, current diff or branch, failing checks, and reason
   for escalation.
7. Record first-attempt and escalation cost separately.

Do not use unrestricted gateway auto-routing inside a long agent conversation.
Provider failover may keep the same model available, but changing model tiers
is a controller decision at a clean run boundary.

### Maintainer checkpoint

Before each routed canary, show the maintainer the selected tier, model,
provider price, task budget, and escalation ceiling. After it completes, show
the PR and cost breakdown before authorizing another run.

### Exit criteria

- routing decisions are explainable and reproducible
- the spending ceiling stops or pauses runaway work
- escalation does not duplicate PRs or lose task ownership
- the comparison record separates initial and escalated costs

## Milestone 5: matched comparison and operating decision

### Goal

Collect the Stage B and Stage C sample defined by the shared comparison plan
and decide whether OpenHands merits continued use.

### Work

1. Run the predeclared matched task sample.
2. Keep the harness, controller, instruction set, and evidence schema stable
   across the sample unless a safety issue requires a stop.
3. Count every attempt, including infrastructure failures and rejected PRs.
4. Compare total cost per accepted PR, human minutes, first-pass acceptance,
   escalation rate, completion time, transparency, and operational burden with
   the GitHub-native sample.
5. Decide among OpenHands Cloud, a future self-hosted OpenHands/LiteLLM test, a
   task-class split, or no continued adoption.

### Maintainer checkpoint

No permanent trigger remains enabled until the maintainer reviews the complete
comparison and explicitly approves the next operating state.

## Stop conditions

Stop the current milestone if:

- OpenHands cannot reliably read the repository instruction chain
- the runtime cannot reproduce required verification
- the wrong repo, issue, branch, commit, or model receives work
- duplicate conversations or PRs are created
- provider or platform cost cannot be bounded for the current stage
- the worker needs production secrets or excessive GitHub permissions
- sensitive content appears in logs or model prompts
- scope expands beyond the approved issue
- cancellation, credential revocation, or cleanup fails

Do not fix a platform limitation by weakening branch protection, verification,
security, or queue governance inside an implementation PR.

## References

- `docs/planning/agent-platform-comparison-plan.md`
- `docs/planning/agent-platform-pilot-development-workflow.md`
- `docs/operators/multi-platform-dispatch-policy.md`
- `docs/operators/branch-and-ci-conventions.md`
- [OpenHands pricing and deployment options](https://www.openhands.dev/pricing/)
- [OpenHands GitHub Issue Resolver](https://github.com/OpenHands/OpenHands/blob/main/openhands/resolver/README.md)
- [OpenHands Cloud CLI](https://docs.openhands.dev/openhands/usage/cli/cloud)
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)
- [LiteLLM](https://docs.litellm.ai/)
