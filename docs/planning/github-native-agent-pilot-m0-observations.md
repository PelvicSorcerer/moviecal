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

- **VERIFIED (partial):** personal account Settings → Copilot shows a "Copilot
  cloud agent" setting, which is enabled. This confirms the coding-agent feature
  surface exists on the current plan.
- **UNRESOLVED:** it is unclear whether "Copilot cloud agent" is GitHub's own
  built-in agent or the entry point for third-party/partner agents such as
  Anthropic Claude. No model selection or Anthropic/Claude branding was visible
  in the settings section. The pilot plan specifically requires "GitHub-hosted
  Claude with an explicit standard model" — this needs to be resolved before
  Milestone 1.
- **NOTE:** no "Copilot" section exists in the org settings, confirming the
  Copilot plan is on the personal account (PelvicSorcerer), not the org. This
  is consistent with the prior #105 session and is fine for the pilot, but
  means agent runs are scoped to the personal seat, not an org policy.
- Open question: where does model selection (or Anthropic Claude selection)
  appear? Likely at issue-assignment time in the UI, not in settings. To be
  confirmed at the start of Milestone 1 before any issue is assigned.

### 2. Enable the Anthropic Claude coding agent and make it available to the repo

- **UNRESOLVED.** The plan requires a specific Anthropic Claude agent; the
  available UI surface is "Copilot cloud agent" (enabled) with no visible
  model or partner-agent selector in settings. Whether the assignment UI
  exposes model/agent choice is unknown until an issue assignment is opened.
- Per the pilot plan: if GitHub-hosted Claude is not separately selectable,
  stop Milestone 1 and record the result. Do not silently substitute a
  different agent.

### 3. GitHub UI exposes repository, `master`, agent, and model selection controls

- **VERIFIED (repository + branch reachable):** `PelvicSorcerer-Software/moviecal`
  is accessible and `master` exists at `550bad9` (GitHub branches API + local
  fetch). Other live branches seen: `experiment/agent-platform-pilots`,
  `copilot/update-issue-fields`, `claude/pelvicsorcerer-repo-migration-52y71y`.
- **UNRESOLVED:** the assignment UI's agent picker and model-selection control
  were not inspected. These need to be checked at the start of Milestone 1
  (look before assigning — just open the UI and record what appears).

### 4. Branch protection and required PR checks

- **VERIFIED (before):** classic branch protection `enabled: false`; rulesets
  array empty. `master` was unprotected.
- **VERIFIED (after):** ruleset `master-protection` (id 18903059) created,
  `enforcement: active`, targeting `~DEFAULT_BRANCH`. Required status checks:
  `lane-baseline`, `lane-unit`, `lane-integration` (integration_id 15368,
  GitHub Actions). Also blocks deletion and non-fast-forward pushes.
  `current_user_can_bypass: never`. ✓ Done.
- **VERIFIED (CI gate wiring):** `verify.yml` and `browser-verify.yml` both
  use `on: pull_request:` with no branch filter — the gate runs on every
  canary PR and is now required for merge.

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
- **VERIFIED (secret store):** Settings → Secrets and variables → Actions —
  no secrets present. No `copilot` environment exists. ✓ Done.

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

| Exit criterion | Status |
|---|---|
| Agent and intended (fixed Claude) model visibly available | UNRESOLVED — "Copilot cloud agent" enabled; model/agent picker not yet inspected |
| Permissions and repository access acceptable | OPEN — agent app permissions not yet reviewed |
| Branch protection and required CI checks in place | ✓ DONE — ruleset `master-protection` active |
| No production secrets in worker environment | ✓ DONE — no Actions secrets, no copilot environment |
| Maintainer understands how to cancel a session | OPEN — to be confirmed at start of Milestone 1 |
| Safe first-canary task profile agreed | OPEN — awaiting maintainer agreement |

---

## Maintainer checkpoint — guided walkthrough

The plan's Milestone 0 checkpoint is: *"The maintainer opens the assignment UI,
reviews the available controls and permissions, and decides whether to proceed.
No issue is assigned and no code is changed in this milestone."* Suggested steps
using your signed-in GitHub session:

1. ✓ **Branch protection (work item 4).** Done — ruleset `master-protection`
   active with `lane-baseline`, `lane-unit`, `lane-integration` required.

2. ✓ **Secret store (work item 6).** Done — no Actions secrets, no `copilot`
   environment.

3. **Agent app permissions (work item 5). OPEN.**
   Personal Settings → Applications → Installed GitHub Apps, or the Copilot
   coding-agent app entry. Review the repository permission set and confirm it
   is minimal (branch + PR + read issues) with no unexpected admin/secret/
   org-wide write scope.

4. **Assignment UI + model/agent controls (work items 2–3). OPEN.**
   On any issue, open the "Assign to Copilot" or coding-agent UI — **do not
   assign yet**. Record: which agent(s) are offered? Is Anthropic Claude
   selectable separately from the built-in Copilot cloud agent? Is there a
   model picker? Can you target `master`? This resolves the key open question
   from work items 1–3.

5. **Cancellation path. OPEN** (to be captured at start of Milestone 1).
   When the assignment UI is open, note whether there is a stop/cancel control
   visible before starting. Record exact steps for stopping an in-flight
   session.

6. **Decide.** Proceed to Milestone 1 only with an explicit go. If the
   Anthropic Claude agent is not separately selectable, record that result and
   stop — do not silently substitute the default Copilot cloud agent.

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
