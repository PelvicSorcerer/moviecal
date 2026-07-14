# GitHub-native coding agent pilot — Milestone 0 observations

## Status

**Experimental evidence log.** Maintained on `experiment/agent-platform-pilots`
(via the milestone working branch `claude/agent-platform-milestone-0-sjqb1j`).
This file records Milestone 0 readiness findings for the GitHub-native pilot. It
is **not** authoritative operating policy and does not override `AGENTS.md`, the
live `moviecal Delivery` GitHub Project, or `docs/operators/`.

Milestone scope is defined by
`docs/planning/github-native-agent-pilot-plan.md` → "Milestone 0: account and
repository readiness". This log follows the branch/PR discipline in
`docs/planning/agent-platform-pilot-development-workflow.md` and the evidence
schema in `docs/planning/agent-platform-comparison-plan.md`.

## Run metadata

```text
milestone:            GitHub-native Milestone 0 (readiness only)
run_date:             2026-07-14
executed_by:          Claude Code (remote execution environment)
model:                claude-opus-4-8
working_branch:       claude/agent-platform-milestone-0-sjqb1j (based on
                      experiment/agent-platform-pilots @ bb6aacb)
repo:                 PelvicSorcerer-Software/moviecal
master_commit:        550bad9 (feat: enforce Dependencies project field, #241)
authority_limits:     readiness only. No issue assigned, no Milestone 1, no live
                      Project mutation, no Agent Dispatch consumption, no PR to
                      master, no automation enabled.
stop_condition:       stop at the Milestone 0 maintainer checkpoint.
```

## Evidence-confidence legend

- **VERIFIED** — directly confirmed this session against the repo or GitHub API.
- **OBSERVED / NEEDS CONFIRMATION** — an API/file signal was seen but it can be
  incomplete or superseded by a surface this session cannot read.
- **REQUIRES MAINTAINER** — an account/organization/browser setting that cannot
  be inspected from this environment; the signed-in maintainer must confirm.
- **ASSUMPTION** — carried from the plan or general knowledge; not tested here.

A deliberate constraint on this run: external GitHub documentation
(`docs.github.com`) is **blocked by this session's egress policy** (HTTP 403 at
the agent proxy). Current third-party-coding-agent capability details therefore
could not be independently re-verified against live GitHub docs and are recorded
below as REQUIRES MAINTAINER / ASSUMPTION rather than as fact.

---

## Milestone 0 work items

### 1. Paid Copilot plan exposes third-party coding agents

- **REQUIRES MAINTAINER.** Copilot plan tier and the "third-party / partner
  coding agents" exposure are billing/organization settings not readable from
  this environment or via the available GitHub MCP tools.
- **VERIFIED (supporting, not sufficient):** the repo is already provisioned for
  a *GitHub Copilot coding-agent* environment generally — `.github/workflows/copilot-setup-steps.yml`
  (correct `copilot-setup-steps` job name, Node 24 install) and
  `.github/copilot-instructions.md` both exist, and `docs/operators/github-copilot.md`
  records a prior verified Copilot coding-agent session (issue #105). This proves
  the *default* Copilot coding agent has run here before; it does **not** prove
  the *Anthropic Claude third-party agent* is exposed on the current plan.
- Maintainer action: confirm the plan tier that includes third-party coding
  agents and that the org policy exposes them.

### 2. Enable the Anthropic Claude coding agent and make it available to the repo

- **REQUIRES MAINTAINER.** Enabling a partner agent and scoping it to
  `PelvicSorcerer-Software/moviecal` is an organization Copilot setting. Not
  inspectable here.
- Note (interpretation, not fact): the pilot plan's "Initial platform decision"
  requires **GitHub-hosted Claude with an explicit standard model**. If the
  third-party Claude agent is not exposed, the plan says to **stop Milestone 1
  and record the availability result** rather than substitute a different agent.
- Maintainer action: confirm whether the Anthropic Claude agent can be enabled
  org-wide and granted access to this repo; record the result either way.

### 3. GitHub UI exposes repository, `master`, agent, and model selection controls

- **VERIFIED (repository + branch reachable):** `PelvicSorcerer-Software/moviecal`
  is accessible and `master` exists at `550bad9` (GitHub branches API + local
  fetch). Other live branches seen: `experiment/agent-platform-pilots`,
  `copilot/update-issue-fields`, `claude/pelvicsorcerer-repo-migration-52y71y`.
- **REQUIRES MAINTAINER:** the *assignment UI* itself — the agent picker, the
  per-session model-selection control, and the ability to target `master` — is a
  browser surface. Confirm the agent and a fixed model can be chosen at
  assignment time.

### 4. Branch protection and required PR checks — enable before canary

- **VERIFIED:** classic branch protection on `master` is `enabled: false`
  (`enforcement_level: off`, zero required status checks). The rulesets array
  is also empty. `master` is currently unprotected — a PR can be merged
  without CI passing.
- **VERIFIED (CI gate wiring):** `verify.yml` and `browser-verify.yml` both
  use `on: pull_request:` with no branch filter, so the full
  baseline/unit/integration/browser gate runs on every canary PR. The checks
  exist; they are just not *required*.
- **ACTION REQUIRED (before Milestone 1):** enable branch protection on
  `master` — at minimum a required-status-checks rule covering
  `lane-baseline`, `lane-unit`, and `lane-integration` — so a canary PR
  cannot be merged while CI fails. This can be done in repo Settings →
  Branches (classic) or Settings → Rules (ruleset). Complete after the other
  account/org settings steps below.

### 5. Review permissions granted to the installed agent app

- **REQUIRES MAINTAINER.** The installed GitHub App / coding-agent permission
  set (contents, pull requests, issues, actions, etc.) is an org GitHub Apps
  setting; the available tooling cannot enumerate app permissions.
- Maintainer action: review the agent app's repository permissions and confirm
  they are the minimum needed to open a branch + PR and read issues — no
  unexpected admin, secrets, or org-wide write scope.

### 6. No production secrets or private user data enter the worker environment

- **VERIFIED (repo policy layer):** `.env.example` is placeholder-only (keys:
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `TMDB_API_KEY`, `CRON_SECRET` — all empty).
  `AGENTS.md` "Environment policy" and `.github/copilot-instructions.md` both
  prohibit production secrets, long-lived personal credentials, and real user
  data, and require disposable/dev-only resources.
- **REQUIRES MAINTAINER:** the *actual* secret store the agent's environment
  would inherit — repository/organization Actions secrets and any `copilot`
  environment secrets — must be confirmed to contain only disposable/dev values.
  `docs/operators/github-copilot.md` notes a `copilot`-environment PAT pattern
  that is documented but "not tested in this repo yet"; confirm no production
  credential is wired there before a real run.

### 7. Expected branch family is covered by relevant CI (or canary is path-gated)

- **VERIFIED.** Both plausible GitHub-native branch families are already wired
  into CI:
  - `copilot/**` (GitHub Copilot coding-agent branches) and `claude/**` are
    explicitly listed in the path-restricted push triggers of
    `supabase-verify.yml` and `ios-verify.yml`, and are enumerated in
    `docs/operators/branch-prefixes.json`.
  - `verify.yml` + `browser-verify.yml` run on **every** PR (no branch filter),
    so the baseline/unit/integration/browser acceptance gate applies to a PR
    from any branch family.
- **Consequence:** a first canary constrained to paths **outside** `supabase/**`,
  `ios/**`, and the other path-gated triggers still receives the full
  PR-triggered verify + browser gate as its acceptance surface. No new CI wiring
  is required for Milestone 0.
- Open question for the maintainer: confirm which branch prefix the *third-party
  Claude* agent actually assigns (`copilot/**` vs a Claude-specific prefix). The
  workflow doc requires recording the real platform-assigned branch family
  before proposing any branch-prefix/CI-filter change. Both `copilot/**` and
  `claude/**` are already covered, so either is safe for a canary; record the
  observed prefix during Milestone 1.

---

## Milestone 0 exit criteria — status

| Exit criterion | Status | Owner of remaining step |
|---|---|---|
| Agent and intended (fixed Claude) model visibly available | REQUIRES MAINTAINER | maintainer in assignment UI |
| Permissions and repository access acceptable | REQUIRES MAINTAINER | maintainer in org GitHub Apps / repo access |
| Maintainer understands how to cancel a session | GUIDED (below) — maintainer to confirm in UI | maintainer |
| Safe first-canary task profile agreed | PROPOSED (below) — awaiting maintainer agreement | maintainer |

No exit criterion can be fully closed from this environment; each terminates in
a maintainer action at the checkpoint. That is expected for Milestone 0, which
the plan defines as an inspection/readiness milestone with **no issue assigned
and no code changed**.

---

## Maintainer checkpoint — guided walkthrough

The plan's Milestone 0 checkpoint is: *"The maintainer opens the assignment UI,
reviews the available controls and permissions, and decides whether to proceed.
No issue is assigned and no code is changed in this milestone."* Suggested steps
using your signed-in GitHub session:

1. **Plan / third-party agent exposure (work items 1–2).**
   Organization settings → Copilot → Coding agent (and policies). Confirm the
   plan tier exposes third-party/partner coding agents and that the Anthropic
   Claude agent can be enabled and scoped to this repo. Record: available? which
   models are offered? can a fixed model be pinned?

2. **Assignment + model controls (work item 3).**
   On an issue (do **not** assign one yet), open the assignment UI and confirm
   you can select the Claude agent, pin a specific model, and target `master`.
   Record exactly which controls appear.

3. **Permissions review (work item 5).**
   Organization settings → GitHub Apps (or the coding-agent app entry). Review
   the repository permission set. Confirm it is minimal (branch + PR + read
   issues) with no unexpected admin/secret/org-write scope.

4. **Branch protection / required checks (work item 4) — enable, don't just confirm.**
   `master` is verified unprotected (no classic rule, no rulesets). Repo
   Settings → Branches or Rules: add a required-status-checks rule covering at
   minimum `lane-baseline`, `lane-unit`, `lane-integration`. Do after steps 1–3.

5. **Secret store (work item 6).**
   Repo/org Settings → Secrets and variables → Actions, and any `copilot`
   environment. Confirm only disposable/dev values are present — no production
   Supabase service-role key, TMDb key, or cron secret.

6. **Cancellation path (exit criterion 3).**
   Confirm how to stop an in-flight agent session: from the agent session/run
   view and from the resulting PR (e.g. stop the session and/or close the draft
   PR). This repo's operator docs do not yet document a GitHub-native cancel
   procedure — capture the real steps you see so we can record them. (See
   "Documentation gap" below.)

7. **Decide.** Proceed to Milestone 1 only with an explicit go, or stop and
   record the blocking availability/permission result.

---

## Proposed safe first-canary profile (for agreement, not execution)

Per the plan and the comparison contract, a Milestone 1 canary should be a
legitimate, merge-worthy `XS`/`S` task that:

- has no unresolved dependencies and no file overlap with active work;
- avoids iOS/Xcode, Supabase migrations, auth, calendar tokens, production
  infrastructure, and any external secret;
- **stays outside `supabase/**` and `ios/**`** so the full PR-triggered
  `verify` + `browser-verify` gate is the deterministic acceptance surface
  (see work item 7);
- carries current acceptance criteria, expected files, out-of-scope boundary,
  a **Testing Expectations** section, and a manual checklist;
- is added to the Project with canonical taxonomy and **`Agent Dispatch = No`**
  (direct-assignment path — does not consume the dispatch slot).

A docs/config/test-only task fits this profile well. **No specific issue is
selected or created in Milestone 0** — issue selection and assignment are
Milestone 1 and require explicit maintainer authorization.

---

## Documentation gap identified

`docs/operators/github-copilot.md` documents the default Copilot coding agent
but does **not** cover: (a) the Anthropic Claude *third-party* agent path,
(b) per-session model pinning, or (c) how to cancel a GitHub-native agent
session. These should be captured from the maintainer's Milestone 0 walkthrough
and folded into the operator doc only after a real Milestone 1 run confirms
behavior (per the workflow doc's verified-vs-assumed discipline). Left here as a
follow-up, not a repo change in this milestone.

## What was explicitly NOT done (authority limits honored)

- No issue assigned; Milestone 1 not started.
- No live GitHub Project field changed; no `Agent Dispatch` consumed.
- No PR opened to `master`; no automation/workflow/trigger enabled or added.
- No repository code, workflow, or config file changed — this milestone produced
  observations only, on the experimental branch.

## References

- `docs/planning/github-native-agent-pilot-plan.md`
- `docs/planning/agent-platform-pilot-development-workflow.md`
- `docs/planning/agent-platform-comparison-plan.md`
- `docs/operators/github-copilot.md`
- `docs/operators/branch-and-ci-conventions.md`
- `docs/operators/branch-prefixes.json`
- `docs/operators/multi-platform-dispatch-policy.md`
