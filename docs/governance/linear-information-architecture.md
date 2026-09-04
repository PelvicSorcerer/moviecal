# Linear workspace information architecture

This document is the authoritative design for how `moviecal` uses Linear as the product/work-item/agent-governance control plane. It replaces the GitHub Project (`moviecal Delivery`) as the source of live queue state. See `docs/operators/local-execution.md` for how a Linear work item becomes local execution on this Mac, and `docs/operators/archive/` for the retired GitHub-Project-centric model this supersedes.

## Why Linear, and why this shape

The previous system used a GitHub Project v2 as the control plane because agents ran in cloud containers that could not reliably reach GitHub's GraphQL API and needed a single-writer, single-dispatch-slot model to avoid races. On a local Mac with a real dispatcher process, that constraint disappears: dependency graphs, ordering, and concurrency can be enforced by code and by Linear's native relations instead of by a hand-maintained text field and a single global mutex.

This design deliberately does not reproduce the GitHub Project's fields one-for-one. Linear has native primitives for most of what the old system had to invent (typed relations instead of a `Dependencies` text field, native issue ordering instead of a `Queue Order` number, Projects/Initiatives instead of a `Track` enum). Where Linear's native model is strictly better, use it; only fall back to labels where Linear has no first-class equivalent.

## Plan

**Free**, to start. Free includes issues, projects, cycles, Triage, labels, estimates, custom views, API + webhooks, and GitHub Issues Sync — everything this design needs. **Initiatives are not included on Free** (confirmed live, see below — Linear's own docs pages did not make this clear at the time this plan was written). The binding constraint on Free is a 250-issue cap; importing ~110 GitHub issues leaves headroom. Upgrade to Basic ($10/user/mo annual) only if that cap is reached. Do not upgrade to Business for Coding Sessions — those run in Linear's own cloud sandbox on Linear AI credits, which is the opposite of this repo's "local Mac is the execution environment" architecture.

## Workspace / Teams

One workspace (`moviecal`), one team (`MOV`). GitHub Issues Sync is one-repo-to-one-team; a single-developer project gains nothing from splitting teams.

## Initiatives — not provisioned (plan-gated)

The original design here proposed two initiatives (**Web App**, **Native iOS App**) grouping the five projects below. Provisioning them live confirmed **Initiatives are gated behind Linear's Business plan** on this workspace (`initiativeCreate` returns `FEATURE_NOT_ACCESSIBLE`: *"Subscribe to the Business plan to access team initiatives in your workspace"*) — this was not correctly reflected in Linear's own marketing/docs pages at the time this plan was written. Given initiatives were already evaluated as a marginal nice-to-have at this project's scale (5 projects, 1 team), this is skipped rather than upgrading the plan for it. The five projects below exist standalone, ungrouped. Revisit if the plan is ever upgraded for another reason.

## Projects

| Linear project | Replaces GitHub `Track` |
|---|---|
| Shared Watchlists | `Shared Watchlists` |
| Calendar Feed | `Calendar` |
| Platform & Infrastructure | `Platform` |
| Developer Governance & Agent Infrastructure | (new) |
| iOS Companion App | `iOS` |

`Docs` and `Migration` are not projects — they are work *types*, represented as labels. `Future` is not a project — it is the `Icebox` backlog state.

## Project milestones

Used only where real sequencing exists. Initial milestones live under **iOS Companion App**: `Skeleton` → `Auth + API client` → `Navigation shell`, matching the dependency chain that was GitHub issues #237 → #238/#239 → #240. Other projects get milestones only when a real release boundary exists — do not add milestones for their own sake.

## Workflow states

| Category | State | Meaning |
|---|---|---|
| Triage | Triage | Linear Triage inbox — external GitHub bug/feature intake lands here |
| Backlog | Backlog | Accepted, not yet specified |
| Backlog | Icebox | Deliberately deferred (replaces `Track = Future`) |
| Unstarted | Spec Ready | Has acceptance criteria + Testing Expectations; not yet cleared for an agent |
| Unstarted | Ready for Agent | Delegable — the dispatcher only picks up issues in this state |
| Started | Agent Working | A worktree is open and a worker is running |
| Started | Needs Input | The agent asked a question; waiting on a human |
| Started | Blocked | A dependency, missing secret, or infra gate failed preflight |
| Started | In Review | A PR is open; CI is running or green |
| Started | Needs Human Decision | An explicit governance boundary was hit (see `docs/operators/local-execution.md` §Security model) |
| Completed | Done | PR merged (set automatically by the GitHub magic word, e.g. `Fixes MOV-123`) |
| Completed | Released | Shipped to production |
| Canceled | Canceled / Duplicate | — |

This state list is the supervision surface a human uses to answer: what's waiting on me, what's the agent doing right now, what shipped. It replaces the six-state GitHub Project `Status` field plus the `Agent Dispatch` boolean.

## Labels

- `area:{watchlist,calendar,auth,database,tests,deployment,docs,process}` — routing (replaces GitHub `Area`)
- `risk:{low,medium,high}` — replaces GitHub `Risk`
- `worker:{claude,codex,any}` — which worker binary should implement this (see `docs/operators/worker-routing.md`)
- `model:{cheap,default,strong}` — model tier override (see `worker-routing.md`)
- `human-only` — never a dispatch candidate (replaces GitHub `Execution Mode = Human`)
- `needs-secrets` — dispatcher refuses to start until the required local secret is present (replaces GitHub `Needs Infra/Secrets`)
- `type:{feat,fix,chore,docs,test}` — work type (absorbs the old `Track = Docs` / `Migration` distinction)
- `upgrade:{multi-system,ambiguous-spec,security-critical,prior-failure,architecture}` — cites the upgrade condition when `model:strong` is applied (see `docs/operators/worker-routing.md`); the dispatcher's routing logic requires at least one of these alongside `model:strong`

No separate `migration` label: the historical-import marker is Linear's own auto-applied `Migrated` label (added to every issue by the GitHub Issues import assistant), not a hand-rolled one. A `migration` label was created here in Stage 3 before that was known, then deleted once confirmed unused — see "GitHub Issues: migration and ongoing sync" below.

## Estimates

Replace GitHub `Target PR Size` (XS/S/M/L) with Linear's native Estimate field (1/2/3/5). Rough mapping: XS→1, S→2, M→3, L→5.

## Relations

Replace the free-text `Dependencies` GitHub field with native Linear `blocked by` / `blocks` relations. Linear enforces these referentially — there is no equivalent of the old dependency-syntax validator (`scripts/lib/project-queue-common.sh`) because malformed or dangling references are not representable in the first place.

## Custom views

The supervision dashboard for a human overseeing autonomous work. **Build these by hand in the Linear UI** (Views → New view), not via the API: the saved-view `filterData` JSON shape isn't part of the documented public schema, and getting it wrong risks a saved view that looks legitimate but silently returns nothing — a few minutes of manual setup is cheaper than that risk. Each takes under a minute using Linear's own filter builder:

- **Needs me** — `Needs Input` ∪ `Needs Human Decision` ∪ `Blocked`
- **Agent activity** — `Agent Working`, grouped by project
- **Ready to delegate** — `Ready for Agent`, sorted by priority
- **In review** — `In Review`, showing PR + CI state
- **Dependency chains** — issues with blocking relations
- **This release** — grouped by milestone
- **Shipped** — `Released`, last 30 days

## Deliberately not adopted

- **Cycles** — recurring sprint ceremony has no value for a solo, agent-paced project with no velocity commitment to report. Milestones give sequencing without the calendar overhead.
- **Linear Coding Sessions** — runs in Linear's cloud sandbox on Linear AI credits; the local dispatcher (`docs/operators/local-execution.md`) supersedes this for the "This Mac = primary execution environment" architecture.
- **Triage Intelligence / Loops / Insights / Asks** — Business-plan features; this project's intake volume does not justify the tier.
- **Project health / updates** — solo project, no external stakeholders to report to. Revisit if that changes.

## Agent Guidance vs. repository files

- **Linear (team-level Agent Guidance)** carries process rules: how to read an issue, what each workflow state means, when to ask a question vs. proceed, escalation boundaries, branch/PR conventions. It is a pointer at the repo, never a duplicate of it.
- **Repository (`AGENTS.md` and friends)** carries everything that must hold even when Linear is unreachable: verification lanes, security constraints, testing policy, coding conventions, the PR template's Test Impact requirement.

Any rule that constrains code lives in the repo. Any rule that constrains process lives in Linear.

## Source-of-truth boundaries

| Domain | Authority |
|---|---|
| What to build, why, priority, acceptance criteria, discussion, decisions, status, release planning, agent delegation, human ownership | **Linear** |
| Source code, tests, CI config, dispatcher code, testing lanes, security constraints, coding conventions, `AGENTS.md`, architecture docs | **Git repository** |
| Branches, commits, PRs, code review, CI results, releases, external bug intake | **GitHub** |
| Live agent progress narration, tool calls, intermediate reasoning | **Dispatcher run logs** (referenced from Linear, never authoritative) |

No agent conversation is ever a source of truth. Every decision an agent makes that affects the work must be written to Linear (as a comment) or to the repo (as code/docs) before the session ends. If it only exists in a chat transcript, it did not happen.

## GitHub Project / Issue field mapping (for migration reference)

| GitHub Project field | Linear representation |
|---|---|
| `Status` | Workflow state (above) |
| `Agent Dispatch` | Retired — replaced by Linear delegation + dispatcher concurrency semaphore |
| `Track` | Project (product tracks) / label (`type:docs`, `migration`) / `Icebox` state (`Future`) |
| `Queue Order` | Native issue ordering + Priority |
| `Dependencies` | Native `blocked by` / `blocks` relations |
| `Priority` | Native Priority |
| `Risk` | Label `risk:*` |
| `Execution Mode` | Label `human-only` (absence = agent-eligible) |
| `Target PR Size` | Estimate |
| `Area` | Label `area:*` |
| `Needs Infra/Secrets` | Label `needs-secrets` |

## Provisioning

The team settings, workflow states, labels, projects, and milestones described above are provisioned by `tools/dispatcher/scripts/provision-linear-workspace.mjs`, an idempotent script safe to re-run any time the workspace needs to be reconciled back to this design (e.g. after a manual mistake, or when setting up a second environment). It reads `LINEAR_API_KEY` from `~/.config/moviecal/linear.env` and does not create initiatives or custom views (see above).

## GitHub Issues: migration and ongoing sync

**Completed 2026-09-04.** All 110 existing GitHub issues (7 open, 103 closed) were imported into Linear team `MOV` via Linear's GitHub Issues import assistant (`issueImportCreateGithub`), landing as 114 total issues (110 imported + 4 Linear-default onboarding issues), split exactly as expected: 103 → `Done`, 7 → `Backlog`. Every imported issue carries a GitHub source-link attachment and a `Migrated` label (Linear's own, auto-applied — there is deliberately no separate hand-rolled `migration` label; one was created in Stage 3 and deleted once confirmed unused, since it duplicated this).

Connecting GitHub itself required the repo owner's browser: `integrationGithubConnect` needs an OAuth `code` + `installationId` obtained by clicking through GitHub's App-install consent screen, confirmed via the public API schema to have no API-key-only path. Once connected (**Linear → Settings → Integrations → GitHub**), the import proceeded via the UI wizard's guided steps (Configure → Export → Select issues → Map users → Confirm).

**The import wizard's "sync" is confirmed one-way (GitHub → Linear only) — not the two-way sync this design calls for.** Verified directly: a test comment posted on a synced Linear issue via the API never appeared on the corresponding GitHub issue after several minutes of polling. This means GitHub-side changes (e.g. an external bug reporter commenting) flow into Linear, but Linear-side changes (status, comments, new issues) do **not** flow back to GitHub — so "GitHub kept in sync for visibility" is not yet true. **Tracked as [MOV-115](https://linear.app/moviecal/issue/MOV-115) — research + build two-way sync** (options: a native two-way toggle that may exist outside the public API surface, or a mechanism piggybacked on the dispatcher's existing Linear-reporting hooks). Do not let this doc's "kept in sync" language above imply that gap is closed; MOV-115 is the source of truth on its status until resolved.

After the one-time import:

- **Linear is the sole authority for new work.** New issues are created in Linear, not GitHub.
- **GitHub Issues remain open for external bug/feature intake** (via `.github/ISSUE_TEMPLATE/bug_report.md` and `feature_request.md`) and get pulled into Linear Triage.
- **No GitHub issue is ever deleted.** The `moviecal Delivery` GitHub Project is archived (read-only) once Linear is verified end-to-end; existing `#NNN` references in 139+ merged PRs and every commit message remain resolvable forever.
- **Two imported issues (`MOV-113`, `MOV-114`) were flagged to `Needs Human Decision`** rather than silently carried forward: both concern governance mechanisms this migration retires (a GitHub Copilot dispatch pilot, and a `/project-update` workflow test fix), and whether they're still worth doing is a call for the repo owner, not something to assume either way.
