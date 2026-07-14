# GitHub-native coding agent pilot plan

## Status

**Experimental and partially unverified.** This runbook is maintained on
`experiment/agent-platform-pilots` while actual GitHub behavior is tested. It
is not authoritative operating policy and does not override `AGENTS.md`, the
live GitHub Project, or `docs/operators/`.

Mark observations as verified only after a real run. Keep unsupported API,
branch, cost, and automation assumptions explicit until tested. Follow
`docs/planning/agent-platform-pilot-development-workflow.md` for branch and PR
handling during the experiment.

## Purpose and target state

This plan evaluates GitHub-native coding agents as an incrementally adoptable
issue-to-PR platform. It deliberately begins with a manual canary so the
maintainer can see and test the real worker experience before any dispatcher is
built. Later milestones automate one boundary at a time.

Target state:

```text
approved issue
  -> GitHub-native dispatch
  -> model selection/routing
  -> isolated implementation
  -> PR and CI
  -> bounded repair/escalation
  -> human review and merge
```

This plan does not authorize permanent queue or governance changes. Every
milestone has its own try/observe/approve checkpoint, and later milestones do
not begin automatically when an earlier one passes.

Read `docs/planning/agent-platform-comparison-plan.md` for the common evidence
and cost-measurement contract.

## Initial platform decision

Use **GitHub-hosted Claude with an explicit standard model** for the first
manual canary, subject to availability. This preserves the original
feasibility decision because the repository already contains `CLAUDE.md`,
`docs/operators/claude-code.md`, the `claude/**` CI convention, and a Claude
model-selection policy.

After the fixed-model canary works, evaluate GitHub `Auto` in the routed trial.
GitHub-hosted Codex may be added as a later candidate, but it must not be
treated as equivalent to the repo's Codex Desktop `spawn_agent` worker
contract.

If GitHub-hosted Claude is unavailable, stop Milestone 1 and record the
availability result. Switching agents requires an explicit amendment so the
evidence remains interpretable.

## Workflow boundary

During the pilot:

- the pilot issue remains `Agent Dispatch = No`
- the existing formal dispatch slot, if any, remains under current policy
- the worker implements exactly one approved issue and opens one focused PR
- only a human or existing authorized orchestrator changes Project fields
- pilot work does not overlap another active branch or PR
- normal verification, review, merge, and security rules remain unchanged

The current live queue may legitimately be blocked with zero dispatched items.
Record that state rather than manufacturing a dispatch candidate for the pilot.

## Milestone 0: account and repository readiness

### Goal

Prove the agent is available and the repository can present a safe execution
environment before assigning implementation work.

### Work

1. Confirm the paid Copilot plan exposes third-party coding agents.
2. Enable the Anthropic Claude coding agent for the account or organization and
   make it available to `PelvicSorcerer-Software/moviecal`.
3. Confirm the GitHub UI exposes the repository, `master`, agent, and model
   selection controls.
4. Confirm branch protection and required PR checks remain enabled.
5. Review the permissions granted to the installed agent app.
6. Confirm no production secrets or private user data will enter the worker
   environment.
7. Confirm the expected branch family is covered by relevant CI, or constrain
   the first canary to paths whose PR checks provide the acceptance gate.

### Maintainer checkpoint

The maintainer opens the assignment UI, reviews the available controls and
permissions, and decides whether to proceed. No issue is assigned and no code
is changed in this milestone.

### Exit criteria

- the agent and intended model are visibly available
- permissions and repository access are acceptable
- the maintainer understands how to cancel a session
- a safe first-canary task profile is agreed

## Milestone 1: manual issue-to-PR canary

### Goal

Let the maintainer try the complete GitHub-native process once before any
automation is introduced.

### Canary issue

Choose a legitimate `XS` or `S`, low-risk issue that:

- has no unresolved dependencies
- avoids iOS/Xcode, migrations, auth, calendar tokens, production
  infrastructure, and external secrets
- has no expected file overlap with active work
- contains current acceptance criteria, relevant docs, expected files,
  out-of-scope boundaries, Testing Expectations, and a manual checklist
- is added to the Project with canonical taxonomy and
  `Agent Dispatch = No`

### Pre-assignment baseline

Record the common comparison fields plus:

- current queue invariant
- requested fixed Claude model
- expected target branch and branch family
- cancellation/rollback owner

### Assignment brief

Post an issue comment and copy its essential points into GitHub's additional
instructions:

```markdown
## Maintainer authorization: GitHub-native agent pilot

You are directly assigned to implement issue #NNN under
`docs/operators/multi-platform-dispatch-policy.md`.

- This is not dispatch-slot work. Keep `Agent Dispatch = No`.
- Start from `master` at COMMIT_SHA.
- Read `AGENTS.md`, `.github/copilot-instructions.md`, `CLAUDE.md`,
  `docs/operators/claude-code.md`, and every document linked by the issue.
- Use the requested fixed model and report the effective model if exposed.
- Work only on this issue and keep the PR focused.
- Run the issue's verification commands and report exact results.
- Include Test Impact, the manual checklist, and applicable security notes.
- Open a PR against `master` that closes #NNN.
- Do not merge, select another issue, or mutate queue authority fields.
```

### Maintainer trial

The maintainer manually assigns Claude, selects the fixed model and `master`,
starts the session, watches its progress, reviews the PR, runs the manual
checklist, and either merges or stops the canary.

Follow-up behavior may be tested with one bounded PR comment, but an artificial
correction is reported separately from implementation cost.

### Exit criteria

- the agent starts from the approved commit
- repository instructions are followed
- a focused PR is opened against `master`
- required checks and manual testing pass
- the PR can be reviewed and merged without bypassing protections
- comparison evidence, including cost and human minutes, is captured
- queue state is unchanged except for the pilot item's ordinary status updates

Passing Milestone 1 proves feasibility, not automation or cost superiority.

## Milestone 2: supported automation interface spike

### Goal

Determine the smallest supported way to start a GitHub-native agent without a
human reproducing the assignment form for every issue.

### Work

1. Verify GitHub's current supported API or workflow surface for starting the
   selected native/partner coding agent.
2. Reject browser automation, undocumented endpoints, and credential reuse
   that violates the platform's intended authentication model.
3. Prototype a read-only dispatcher that accepts an explicit issue number,
   validates eligibility, and prints the exact dispatch request without
   starting an agent.
4. Validate permissions, audit-log visibility, idempotency key, cancellation,
   and duplicate-run detection.
5. Add a hard allowlist so only a specifically approved pilot issue can pass.

If GitHub does not expose a supported programmatic interface for the partner
agent, stop this milestone. Document the gap and decide whether to evaluate
GitHub Agentic Workflows as the GitHub-native automation surface. Do not quietly
replace the worker technology inside the same experiment.

### Maintainer checkpoint

The maintainer runs the dry-run dispatcher with an approved issue number and
reviews the generated request, permissions, and expected charge boundary. No
agent is started.

### Exit criteria

- a documented, supported dispatch interface is identified, or the milestone
  records that none is available
- the dry run cannot mutate queue state or create duplicate sessions
- cancellation and audit paths are understood

## Milestone 3: operator-triggered automated canary

### Goal

Let the maintainer start one real run with a single explicit action while the
system performs validation, dispatch, evidence setup, and status reporting.

### Work

Implement a `workflow_dispatch` or equivalent operator-triggered workflow that:

1. requires an issue number and explicit confirmation input
2. checks the issue is open, approved, dependency-valid, and
   `Agent Dispatch = No`
3. checks for conflicting PRs and existing pilot runs
4. records the comparison baseline
5. starts the GitHub-native agent through the supported interface
6. posts or stores the run/session link
7. does not merge or promote another issue
8. enforces a per-run budget or documented spending ceiling where supported

### Maintainer trial

The maintainer selects **Run workflow**, enters the approved issue, watches the
validation output and agent session, then reviews the resulting PR normally.

### Exit criteria

- one click plus explicit inputs replaces the manual assignment sequence
- invalid, stale, or duplicate requests fail before model work starts
- the PR and evidence record link back to the correct run
- cancellation and rollback work

## Milestone 4: event-triggered single-issue automation

### Goal

Start an approved canary from a repository event without requiring the
maintainer to open the workflow interface.

### Work

1. Choose one explicit trigger surface, such as a dedicated pilot label,
   command comment, or project-field transition.
2. Keep it separate from `Agent Dispatch`; the pilot trigger is not new queue
   authority.
3. Reuse Milestone 3's validation and idempotency logic.
4. Remove or consume the trigger atomically when a run starts.
5. Report blocked, started, PR-opened, stopped, and completed states.
6. Require human review and merge.

### Maintainer trial

The maintainer applies the approved trigger to one canary and observes the
entire issue-to-PR lifecycle. The maintainer may disable the trigger after that
single run before deciding whether to continue.

### Exit criteria

- exactly one approved event creates exactly one agent session
- retries and webhook redelivery do not duplicate work
- removing or disabling the trigger prevents new runs
- ordinary queue authority remains unchanged

## Milestone 5: native Auto and cost-efficiency trial

### Goal

Evaluate GitHub's intended cost-saving behavior after the execution lifecycle
is reliable.

### Work

1. Enable `Auto` only for the approved comparison sample.
2. Record selected/effective model when GitHub exposes it, AI credits, Actions
   usage, session limits, retries, and human minutes.
3. Run the matched-canary and routed-operation stages from the shared plan.
4. Use normal CI as the deterministic quality gate.
5. Stop or require approval when a session reaches its configured cost limit.

### Maintainer checkpoint

After each canary, show the maintainer the PR, GitHub usage record, evidence
record, and cumulative pilot spend before the next run is authorized.

### Exit criteria

- the agreed sample and spending cap are complete
- costs are known or explicitly classified as unavailable
- comparison metrics can be evaluated against OpenHands
- no permanent governance change has been made implicitly

## Stop conditions

Stop the current milestone if:

- the supported agent or automation interface is unavailable
- the worker starts from the wrong repository, branch, commit, or issue
- queue authority fields are mutated outside the approved operator path
- duplicate sessions or PRs are created
- required CI cannot run without an unapproved governance change
- secrets, private data, or excessive permissions are exposed
- the worker expands scope or cannot produce a reviewable PR
- the spending ceiling cannot be enforced or observed sufficiently for the
  current experimental stage

A stopped milestone is useful evidence. Repair governance or platform
compatibility separately before retrying.

## References

- `docs/planning/agent-platform-comparison-plan.md`
- `docs/planning/agent-platform-pilot-development-workflow.md`
- `docs/operators/multi-platform-dispatch-policy.md`
- `docs/operators/claude-code.md`
- `docs/operators/claude-model-selection-policy.md`
- `docs/operators/branch-and-ci-conventions.md`
- [GitHub: Third-party coding agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)
- [GitHub: Agentic Workflows](https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows)
- [GitHub: Optimizing AI usage](https://docs.github.com/en/copilot/tutorials/optimize-ai-usage)
