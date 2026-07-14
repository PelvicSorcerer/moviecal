# GitHub-native coding agent pilot — Milestone 0 observations

## Status

**Experimental evidence log.** Maintained on `experiment/agent-platform-pilots`
(via the milestone working branch `claude/agent-platform-pilot-m0-b1j05m`).
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
model:                claude-sonnet-4-6
working_branch:       claude/agent-platform-pilot-m0-b1j05m (rebased onto
                      master @ 16e3f01)
repo:                 PelvicSorcerer/moviecal (transferred from
                      PelvicSorcerer-Software/moviecal to personal ownership;
                      transfer required to enable third-party partner agents)
master_commit:        16e3f01 (Point project automation to personal ownership, #249)
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

- **VERIFIED (MAINTAINER-CONFIRMED):** The issue assignment modal includes an
  **agent picker** with Claude listed as a selectable option alongside the
  built-in Copilot agent. Third-party partner agents are visibly exposed by the
  current Copilot plan.
- **NOTE:** agent runs are scoped to the personal seat (PelvicSorcerer), not an
  org policy, consistent with the prior observation that no "Copilot" section
  appears in org settings.

### 2. Enable the Anthropic Claude coding agent and make it available to the repo

- **VERIFIED (MAINTAINER-CONFIRMED):** The Claude partner agent is enabled.
  Personal Settings → Copilot → Partner Agents (Preview) → "Allow Claude coding
  agent" toggle is **On**.
- **VERIFIED (precondition):** Enabling third-party partner agents required
  moving the repository from the `PelvicSorcerer-Software` GitHub organization
  to personal account ownership (`PelvicSorcerer/moviecal`). This transfer was
  completed (see #249 / commit `16e3f01`).
- **VERIFIED (MAINTAINER-CONFIRMED):** Claude appears as a named, selectable
  option in the agent picker — it is not merged into or hidden behind the
  built-in Copilot agent entry.

### 3. GitHub UI exposes repository, `master`, agent, and model selection controls

- **VERIFIED (repository + branch reachable):** `PelvicSorcerer/moviecal`
  (post-transfer) is accessible and `master` exists at `16e3f01`.
- **VERIFIED (MAINTAINER-CONFIRMED):** The assignment modal exposes:
  - **Agent picker:** present; Claude is a selectable option.
  - **Model picker:** appears when Claude is selected; lists multiple Anthropic
    models (specific model names not yet recorded — capture at start of M1).
  - **Base branch:** selectable; `master` is pre-selected by default. ✓
  - **Branch name format:** not shown in the modal. The platform-assigned branch
    name will only be known once a session is started. Record the observed
    prefix during Milestone 1 (both `copilot/**` and `claude/**` are already
    wired into CI, so either is safe).

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

- **VERIFIED (MAINTAINER-CONFIRMED):** Claude appears under Personal Settings →
  Applications → **Authorized GitHub Apps**, not "Installed GitHub Apps".
  The authorized entry shows no permission inventory, no repository scope
  selector, and no configuration surface — it is an OAuth authorization with
  opaque scope, not a GitHub App installation.
- **Implication:** there is no visible per-repository permission grant, no way
  to restrict Claude's access to only `moviecal` from this settings page, and
  no granular read/write permission list to audit. The effective permissions
  are determined by what GitHub's partner-agent platform grants the OAuth token
  at session time, which is not surfaced to the maintainer.
- **Risk note:** this is a weaker permission-review posture than a GitHub App
  installation (which shows explicit scopes and per-repo access). Record as a
  known opacity gap. The repo-side mitigations (branch protection, no secrets
  in Actions, placeholder-only `.env.example`) still apply regardless.

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
| Agent and intended (fixed Claude) model visibly available | ✓ DONE — Claude appears in agent picker; model picker lists Anthropic models when Claude selected; `master` pre-selected as base branch |
| Permissions and repository access acceptable | OPACITY GAP — Claude is an OAuth authorization (Authorized GitHub Apps), not a GitHub App installation; no per-repo scope or permission list is visible |
| Branch protection and required CI checks in place | ✓ DONE — ruleset `master-protection` active |
| No production secrets in worker environment | ✓ DONE — no Actions secrets, no copilot environment |
| Maintainer understands how to cancel a session | DEFERRED — cancel controls not visible without an active session; to be observed at start of Milestone 1 before implementation work begins |
| Safe first-canary task profile agreed | OPEN — proposed profile in this doc; awaiting maintainer agreement |

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

3. ✓ **Claude partner agent enabled (work item 2, partial).** Maintainer
   confirmed: Personal Settings → Copilot → Partner Agents (Preview) →
   "Allow Claude coding agent" toggle is **On**. Repo transfer to personal
   ownership (`PelvicSorcerer/moviecal`) was the necessary precondition.

4. ✓ **Agent app permissions (work item 5). DONE — opacity gap recorded.**
   Claude appears under **Authorized GitHub Apps** (not Installed GitHub Apps).
   No permission inventory or repository scope is shown — it is an OAuth
   authorization with no auditable scope list. The repo-side mitigations
   (branch protection, no Actions secrets, placeholder `.env.example`) remain
   the effective safety boundary. This opacity is recorded as a known gap.

5. ✓ **Assignment UI + model/agent controls (work items 2–3). DONE.**
   Maintainer-confirmed from the issue assignment modal:
   - **Agent picker:** present; Claude is a named, selectable option.
   - **Model picker:** appears when Claude is selected; lists multiple Anthropic
     models. Specific model names to be recorded at start of Milestone 1.
   - **Base branch:** selectable; `master` pre-selected by default. ✓
   - **Branch name format:** not shown in the modal. Record observed prefix
     once the first session starts.

6. **Cancellation path. DEFERRED to Milestone 1 start.**
   Cancel/stop controls are not visible in the assignment modal before a session
   is started. The maintainer must assign the issue to observe them. Agreed
   action: at the very start of Milestone 1, before any implementation work is
   expected, locate and record the stop/cancel surface — then confirm it works
   before letting the session proceed. Do not advance through Milestone 1 until
   cancellation is understood.

7. **Decide.** Proceed to Milestone 1 only with an explicit go. If Anthropic
   Claude is not separately selectable in the assignment UI, record the result
   and stop — do not silently substitute the default Copilot cloud agent.

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
