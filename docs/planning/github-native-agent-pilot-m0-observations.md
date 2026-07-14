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
| Safe first-canary task profile agreed | ✓ DONE — issue #248 agreed as first canary (see below) |

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

7. ✓ **Decide. DONE — Milestone 0 complete; proceed to Milestone 1.**
   Maintainer authorized Milestone 1. All exit criteria are met or have known,
   acceptable gaps recorded. Claude is selectable; `master` is the base branch;
   #248 is the agreed first canary. Cancellation path is deferred to the first
   action of Milestone 1.

---

## Agreed first-canary: issue #248

**Issue:** [#248 — Fix real-stack timestamp format mismatch in watchlist-memberships tests](https://github.com/PelvicSorcerer/moviecal/issues/248)

**Maintainer authorization:** granted (2026-07-14).

| Field | Value |
|---|---|
| Size / risk | XS / Low |
| Track | Platform |
| Agent Dispatch | No (direct-assignment path) |
| Model | `claude-haiku-4-5` (specified in issue) |
| Base branch | `master` @ `16e3f01` |
| File scope | `test/watchlist-memberships.real-stack.test.ts` (2 assertions) |
| Required PR checks | `lane-baseline`, `lane-unit`, `lane-integration` |
| Known gap | `lane:real-stack` requires a live Supabase DB; no Actions secrets are configured so the agent cannot run it. The fix is correct by inspection. The `supabase-verify` CI check is not a required PR check. The agent should note the constraint. Observing how it handles this is part of the canary data. |

**Pre-assignment baseline to record at Milestone 1 start:**
- `origin/master` commit: `16e3f01`
- No open PRs touching `test/watchlist-memberships.real-stack.test.ts`
- Queue invariant: `Agent Dispatch = No` on #248; formal dispatch slot unaffected
- Cancellation/rollback owner: maintainer

---

## Additional M0 observations (captured during M1 assignment UI walkthrough)

### Model picker — both agents

- **VERIFIED (MAINTAINER-CONFIRMED):** Both the Claude agent and the Copilot
  agent offer **Auto** as a model option.
- **VERIFIED (MAINTAINER-CONFIRMED):** The **Copilot agent has more Anthropic
  models available than the Claude agent.** Specifically, the Copilot agent
  offers Opus-class models that the Claude agent does not expose.
- **Implication for pilot plan:** the pilot plan calls for "GitHub-hosted Claude
  with an explicit standard model" and specified `claude-haiku-4-5`. If the
  Claude agent's model picker does not include the exact model IDs the plan
  specifies, model selection may need to use the closest available option or
  switch to the Copilot agent for model coverage. This should be resolved
  before the comparison sample (the Claude agent model list needs to be
  recorded at the start of each run).

### Cancellation path — in-flight session

- **VERIFIED (MAINTAINER-CONFIRMED):** The "Cancel" button in the assignment
  modal closes the modal without assigning — it is **not** an in-flight session
  stop control.
- **UNRESOLVED:** in-flight session cancellation controls are only visible once
  a session is running. Now that PR #250 is open and a session is active, the
  maintainer can observe and record where the stop/cancel surface appears (issue
  page sidebar, Copilot dashboard, Actions tab, etc.).

---

## Milestone 0 summary

**Status: COMPLETE.** Maintainer authorized Milestone 1 on 2026-07-14.

| Exit criterion | Final status |
|---|---|
| Agent and intended model visibly available | ✓ Claude in agent picker; Anthropic model picker shown; `master` pre-selected |
| Permissions and repository access acceptable | ⚠ Opacity gap — OAuth authorization (Authorized GitHub Apps), no scope list visible; repo-side controls are the effective boundary |
| Branch protection and required CI checks in place | ✓ Ruleset `master-protection` active |
| No production secrets in worker environment | ✓ No Actions secrets, no copilot environment |
| Maintainer understands how to cancel a session | ⚠ Deferred — cancel controls not visible pre-flight; first action of M1 is to locate and confirm them |
| Safe first-canary task profile agreed | ✓ Issue #248, `claude-haiku-4-5`, `master` @ `16e3f01` |

The two ⚠ items are known, acceptable gaps — not blockers. The permissions
opacity is a platform characteristic (OAuth vs App installation); the
cancellation deferral is a UI constraint resolved at M1 start.

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

## Milestone 1 observations — issue #248 canary (in progress)

```text
run_date:             2026-07-14
pr:                   #250 — https://github.com/PelvicSorcerer/moviecal/pull/250
branch:               claude/fix-timestamp-format-mismatch
branch_prefix:        claude/** (VERIFIED — first observed platform-assigned prefix)
base_branch:          master @ 16e3f01 ✓
pr_state:             Draft (opened as [WIP])
session_status:       Failed during session (MCP error) — details TBD
```

### What went right

- **Branch prefix VERIFIED:** `claude/fix-timestamp-format-mismatch`. Both
  `claude/**` and `copilot/**` were already wired into CI; this is consistent
  with CI coverage.
- **Base branch correct:** PR targets `master` @ `16e3f01`. ✓
- **Diff is correct and well-targeted:**
  ```diff
  -  expect(result.acceptedAt).toBe(acceptedAt);
  +  expect(new Date(result.acceptedAt).toISOString()).toBe(new Date(acceptedAt).toISOString());
  ```
  Both assertions normalised via `new Date(x).toISOString()`. This satisfies
  the acceptance criterion ("normalises the comparison rather than weakening
  the assertion"). The fix is correct by inspection.
- **Scope contained:** only `test/watchlist-memberships.real-stack.test.ts`
  touched. ✓
- **No queue mutations:** `Agent Dispatch` and Project fields unchanged. ✓

### What went wrong

- **Session failed while using MCP.** The agent opened the PR and made the
  correct code change, then encountered an MCP error. The PR description was
  not updated to a completion summary. Session status shows `in_progress` in
  the API at time of recording; the UI reported a failure to the maintainer.
  Root cause and exact error TBD — maintainer to provide session log or error
  message.

### Open questions from this run

- What was the exact MCP error? (Error message, which MCP tool, at what point
  in the session.)
- Was the session using any MCP server that isn't provisioned in the GitHub
  agent environment?
- Does the cancellation surface appear on the issue page or in a Copilot
  dashboard now that the session is active?
- What model was actually selected/used? (The PR body doesn't report it.)
- Do the required CI checks (`lane-baseline`, `lane-unit`, `lane-integration`)
  pass on the branch?

### Next decision

The code change is correct. Options:
1. **Merge as-is** after human review confirms the diff — counts as M1 success
   with a note that the session ended in an MCP error after completing the work.
2. **Re-run** the session on the existing branch to see if the agent can
   complete the PR description and CI without the MCP error.
3. **Human merges** the correct diff directly, recording the MCP failure as an
   infrastructure observation.

## References

- `docs/planning/github-native-agent-pilot-plan.md`
- `docs/planning/agent-platform-pilot-development-workflow.md`
- `docs/planning/agent-platform-comparison-plan.md`
- `docs/operators/github-copilot.md`
- `docs/operators/branch-and-ci-conventions.md`
- `docs/operators/branch-prefixes.json`
- `docs/operators/multi-platform-dispatch-policy.md`
