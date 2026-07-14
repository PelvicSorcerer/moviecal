# Agent platform pilot development workflow

## Status

**Experimental.** This document governs only the GitHub-native and OpenHands
pilot-development workspace. It is not repository operating policy and does
not change the authority of `AGENTS.md`, `docs/operators/`, or the live
`moviecal Delivery` GitHub Project.

## Purpose

The pilot plans contain assumptions that cannot be treated as established
behavior until real platform runs validate them. This workflow preserves those
plans and their evidence without turning an experimental branch into a shadow
default branch or exposing ordinary delivery work to unproven automation.

## Branch model

### Long-lived experimental branch

Use:

```text
experiment/agent-platform-pilots
```

This branch is the laboratory notebook for:

- experimental pilot plans
- milestone observations and evidence summaries
- corrections when platform behavior contradicts an assumption
- rejected approaches and decision rationale
- proposed, not-yet-authoritative automation designs

The branch must not become an alternate product-integration branch. Do not
accumulate unrelated product changes, completed feature work, or permanent
queue state on it.

After the branch is pushed, keep its history stable. Bring current `master`
into it when repository guidance or relevant implementation changes; do not
force-push rewritten history merely to make it linear.

### Short-lived milestone branches

When a milestone needs repository code, workflow, or configuration changes,
create a fresh branch from current `master`, for example:

```text
chore/github-agent-m0-readiness
chore/github-agent-m2-dispatch-spike
chore/openhands-m0-readiness
chore/openhands-m2-dispatcher
```

Each branch owns one milestone-sized change. It must not absorb later
automation phases merely because they are related.

### Disposable worker branches

Platform-created worker branches belong to one canary run. Preserve them while
the PR, CI, or review is active, then remove them after merge or explicit
abandonment according to normal repository practice.

Record the actual platform-assigned branch family before proposing a permanent
branch-prefix or CI-filter change.

## Pull-request targets

### Pull requests to `master`

Target `master` only when a milestone produces a safe repository change that
must exist on the default branch or is independently worth retaining. Examples
include:

- a minimal, disabled-by-default setup file
- a dry-run dispatcher with no worker-launch authority
- a tightly scoped workflow required for a GitHub trigger test
- a verified compatibility fix
- a legitimate canary implementation PR

Every such PR must be independently reviewable and reversible. It must not
claim that the full pilot plan is validated.

GitHub's `workflow_dispatch`, `issues`, and `issue_comment` workflow events
require the workflow file to exist on the default branch. When testing one of
those surfaces, merge only the minimum scaffold needed for the next milestone.
The initial scaffold should use read-only permissions, dry-run behavior, an
explicit pilot allowlist or environment approval, a kill switch, and no queue
mutation or automatic merge.

### Changes kept only on the experimental branch

Keep the following off `master` until validated:

- detailed unverified runbooks
- speculative API or gateway integration instructions
- raw or summarized pilot evidence that is useful for the decision but not
  durable repository guidance
- abandoned implementation designs
- automation that has not passed its preceding maintainer checkpoint

Minor evidence and plan corrections may be committed directly to the
experimental branch. When multiple agents contribute or a change materially
alters experimental scope, use a short-lived branch and a PR targeting
`experiment/agent-platform-pilots` so the experimental decision remains
reviewable.

## Milestone execution cycle

Use this cycle for each platform milestone:

1. Update the experimental plan with current assumptions, scope, spending cap,
   stop conditions, and maintainer checkpoint.
2. Confirm live queue state and verify the canary does not overlap active work.
3. Create a short-lived branch from current `master` only if repository changes
   are required.
4. Implement the smallest change needed to make the milestone testable.
5. Run the maintainer checkpoint and one bounded real test.
6. Capture success, failure, cost, human effort, branch behavior, permissions,
   environment behavior, and cleanup results using the shared evidence schema.
7. Update the experimental plans to mark behavior as verified, disproven, or
   still assumed.
8. Stop until the maintainer explicitly authorizes the next milestone.

Do not enable a later trigger, wider issue selector, stronger permission, or
larger spending ceiling as an incidental part of completing an earlier
milestone.

## Initial execution order

The first hands-on sequence is:

1. GitHub-native Milestone 0: inspect account, permissions, UI, agent, and model
   availability.
2. GitHub-native Milestone 1: manually assign one low-risk canary and observe
   the complete issue-to-PR path.
3. Reconcile GitHub assumptions and evidence on the experimental branch.
4. OpenHands Milestone 0: inspect account, permissions, hosted runtime, provider
   path, usage reporting, and spending controls.
5. OpenHands Milestone 1: run one observable sandbox smoke task without a
   production PR.
6. Reconcile OpenHands assumptions and evidence on the experimental branch.
7. Decide whether either platform may proceed to its first automation
   milestone.

This order may change only through an explicit maintainer decision recorded on
the experimental branch.

## Keeping the experiment current

Before each milestone:

- fetch current `origin/master`
- compare repository instructions, CI, issue templates, and operator guidance
  with the experimental assumptions
- merge current `master` into the experiment branch when those changes affect
  the plans
- create milestone implementation branches from current `master`, not from the
  long-lived experiment branch

The experiment branch may link to a real canary PR, but the worker should not
need the branch to become the repository's default guidance. Put the necessary
bounded maintainer authorization directly in the approved issue/run brief.

## Validation and final merge

Do not merge the long-lived experiment branch wholesale to `master`.

After both early pilots have enough evidence:

1. classify every material plan statement as verified behavior, chosen policy,
   remaining assumption, or rejected approach
2. remove temporary evidence and abandoned designs from the durable version
3. create a fresh governance branch from current `master`
4. copy or cherry-pick only the cleaned, validated documents and any separately
   approved workflow guidance
5. reconcile `AGENTS.md`, `docs/operators/`, templates, branch conventions, and
   CI filters only where the validated operating model requires it
6. open a normal governance PR to `master`

The final PR should explain which milestones ran, what was observed, which
assumptions changed, and what authority is being made permanent.

## Cleanup and rollback

- Keep a kill switch for any pilot dispatcher that reaches `master`.
- Revoke unused platform and provider credentials after a stopped experiment.
- Close or clearly mark abandoned PRs and remove disposable branches after
  evidence is captured.
- Leave `Agent Dispatch = No` on pilot items unless a separate, approved policy
  change explicitly says otherwise.
- If the experiment ends without adoption, retain the branch or tag long enough
  to preserve the decision evidence, then archive it without merging it to
  `master`.

## References

- `docs/planning/agent-platform-comparison-plan.md`
- `docs/planning/github-native-agent-pilot-plan.md`
- `docs/planning/openhands-agent-pilot-plan.md`
- `docs/operators/multi-platform-dispatch-policy.md`
- [GitHub: Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
