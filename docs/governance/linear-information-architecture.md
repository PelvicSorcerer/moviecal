# Linear workspace information architecture

This document is the authoritative design for how `moviecal` uses Linear as the product/work-item/agent-governance control plane. It replaces the GitHub Project (`moviecal Delivery`) as the source of live queue state. See `docs/governance/hybrid-execution-architecture.md` for the two-adapter (Linear-managed cloud + local Mac) execution model this workspace design feeds, `docs/operators/local-execution.md` for how a Linear work item becomes execution on the Mac adapter, and `docs/operators/archive/` for the retired GitHub-Project-centric model this supersedes.

## Why Linear, and why this shape

The previous system used a GitHub Project v2 as the control plane because agents ran in cloud containers that could not reliably reach GitHub's GraphQL API and needed a single-writer, single-dispatch-slot model to avoid races. On a local Mac with a real dispatcher process, that constraint disappears: dependency graphs, ordering, and concurrency can be enforced by code and by Linear's native relations instead of by a hand-maintained text field and a single global mutex.

This design deliberately does not reproduce the GitHub Project's fields one-for-one. Linear has native primitives for most of what the old system had to invent (typed relations instead of a `Dependencies` text field, native issue ordering instead of a `Queue Order` number, Projects/Initiatives instead of a `Track` enum). Where Linear's native model is strictly better, use it; only fall back to labels where Linear has no first-class equivalent.

## Plan

**Free**, to start. Free includes issues, projects, cycles, Triage, labels, estimates, custom views, API + webhooks, and GitHub Issues Sync — everything this workspace design needs. The binding constraint on Free is a 250-issue cap; importing ~110 GitHub issues leaves headroom. Upgrade to Basic ($10/user/mo annual) only if that cap is reached.

**Paid-tier capabilities (Loops, Coding Sessions) are now in scope but not authorized.** The hybrid execution architecture (`docs/governance/hybrid-execution-architecture.md`) makes Linear Coding Sessions the intended *cloud* execution adapter and Loops a candidate for intake — superseding this document's earlier blanket rejection of both. Neither is enabled. The required plan tier and expected AI-credit consumption are **unmeasured**, and `MOV-141` must record them before any purchase or enablement. Nothing here authorizes an upgrade.

**Initiatives:** basic initiative creation and linking (used below) is enabled on this workspace — the repo owner unlocked it directly in Linear (exact mechanism not confirmed from the API side; possibly a trial or a workspace-level toggle distinct from a full Business subscription). One sub-feature remains gated regardless: assigning an initiative a "lead team" (`initiativeCreate`'s `leadTeamId` field) still returns `FEATURE_NOT_ACCESSIBLE` ("Subscribe to the Business plan to access team initiatives in your workspace"). That's not needed here — with a single team (`MOV`), a lead-team assignment wouldn't add anything — so `provision-linear-workspace.mjs` creates initiatives without it.

## Workspace / Teams

One workspace (`moviecal`), one team (`MOV`). GitHub Issues Sync is one-repo-to-one-team; a single-developer project gains nothing from splitting teams.

## Initiatives

Two initiatives group the five projects below:

- **Web App** — everything shipping to the Next.js application: Shared Watchlists, Calendar Feed, Platform & Infrastructure, Developer Governance & Agent Infrastructure.
- **Native iOS App** — the future companion app: iOS Companion App.

(A first attempt at provisioning these hit `FEATURE_NOT_ACCESSIBLE` — initiatives were originally plan-gated on this workspace, so this doc briefly shipped a "skip initiatives, projects stand alone" design. The repo owner then enabled the feature directly in Linear, and the initiatives + links above were created and verified live. The `leadTeamId` sub-feature remains gated, see "Plan" above — irrelevant here with one team.)

## Projects

| Linear project | Initiative | Replaces GitHub `Track` |
|---|---|---|
| Shared Watchlists | Web App | `Shared Watchlists` |
| Calendar Feed | Web App | `Calendar` |
| Platform & Infrastructure | Web App | `Platform` |
| Developer Governance & Agent Infrastructure | Web App | (new) |
| iOS Companion App | Native iOS App | `iOS` |

`Docs` and `Migration` are not projects — they are work *types*, represented as labels. `Future` is not a project — it is the `Icebox` backlog state.

## Project milestones

Used only where real sequencing exists. Initial milestones live under **iOS Companion App**: `Skeleton` → `Auth + API client` → `Navigation shell`, matching the dependency chain that was GitHub issues #237 → #238/#239 → #240. Other projects get milestones only when a real release boundary exists — do not add milestones for their own sake.

## Workflow states

| Category | State | Meaning |
|---|---|---|
| Triage | Triage | Linear Triage inbox — external GitHub bug/feature intake lands here |
| Backlog | Backlog | Accepted. The automated promoter (MOV-129) evaluates every issue here each cycle and moves the ready ones to `Ready for Agent`; an unspecified issue simply doesn't qualify yet and stays. |
| Backlog | Icebox | Deliberately deferred (replaces `Track = Future`) |
| Unstarted | Spec Ready | **Manual hold.** A specced issue parked here deliberately, to keep it out of the automated flow — the promoter never touches this state. Move it back to `Backlog` to let it flow. |
| Unstarted | Ready for Agent | Delegable — the dispatcher only picks up issues in this state. Filled by the promote pass, not by hand. |
| Started | Agent Working | A worktree is open and a worker is running |
| Started | Needs Input | The agent asked a question; waiting on a human |
| Started | Blocked | A dependency, missing secret, or infra gate failed preflight. The promoter auto-recovers issues blocked purely on a now-resolved `blocks` relation; anything blocked for another reason waits for a human. |
| Started | In Review | A PR is open; CI is running or green |
| Started | Needs Human Decision | An explicit governance boundary was hit (see `docs/operators/local-execution.md` §Security model) |
| Completed | Done | PR merged (set automatically by the GitHub magic word, e.g. `Fixes MOV-123`) |
| Completed | Released | Shipped to production |
| Canceled | Canceled / Duplicate | — |

This state list is the supervision surface a human uses to answer: what's waiting on me, what's the agent doing right now, what shipped. It replaces the six-state GitHub Project `Status` field plus the `Agent Dispatch` boolean.

**The readiness contract (MOV-129).** An issue in `Backlog` is auto-promoted to `Ready for Agent` when it is not labeled `human-only`, its description has a non-empty acceptance-criteria section (heading matching `/^#+\s*acceptance criteria/i`) and a non-empty Testing Expectations section (`/^#+\s*testing expectations/i`), and every issue that `blocks` it is in a completed/canceled state. `blocks` relations plus the dispatcher's preflight do all sequencing; the promoter only judges readiness. It runs as a phase of `dispatcher run` (and standalone as `dispatcher promote [--dry-run]`). See `docs/operators/local-execution.md` §Automated promotion.

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

**Relation direction — do not create these by hand.** Linear's `issueRelationCreate` mutation reads `input.issueId` as the *source* of the named relation and `input.relatedIssueId` as its *target*, so `type: "blocks"` means "`issueId` **blocks** `relatedIssueId`". Passing the pair the intuitive-but-wrong way (earlier issue as `relatedIssueId`) builds the whole chain backwards — the last issue ends up unblocked and the first shows as blocked by its successor. This has happened more than once. Use `LinearClient.addBlocksRelation({ blockerId, blockedId })` or `LinearClient.linkBlockingChain([...orderedIds])` (`tools/dispatcher/src/linear-client.mjs`), which take role-named arguments and are unit-tested against the field mapping; if you must call the raw GraphQL, verify the direction with a readback query before moving on.

**Reading the direction back is just as easy to invert (MOV-128, and its follow-up fix).** An issue's own `relations` field of type `blocks` lists issues *it* blocks (its dependents), not its blockers — the same inversion class as the write-side bug above, just on the read path. The issues that actually block a given issue show up under that issue's `inverseRelations`. One more trap inside `inverseRelations`: for a `blocks` entry there, **`issue` is the blocker and `relatedIssue` is the issue itself** — read `issue`, not `relatedIssue` (`relatedIssue` is just self, and keying gate state off it makes an issue look blocked by itself, which never clears). `LinearClient.issuesInState()` derives `blockedByIds` from `inverseRelations[].issue.id`, and `tools/dispatcher/src/dependency-gate.mjs`'s `buildIsIssueSatisfied()` resolves each blocker's workflow state from `inverseRelations[].issue.state` in the same query (no extra Linear call) to gate dispatch in `bin/dispatcher.mjs`'s real run path.

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
- **Triage Intelligence / Insights / Asks** — Business-plan features; this project's intake volume does not justify the tier.
- **Project health / updates** — solo project, no external stakeholders to report to. Revisit if that changes.

**No longer rejected — now gated instead:** **Linear Coding Sessions** and **Loops** were previously listed here as deliberately not adopted (Coding Sessions because cloud execution contradicted a Mac-only architecture; Loops on tier grounds). The hybrid execution architecture supersedes both rejections: Coding Sessions are the intended **cloud execution adapter** for eligible non-iOS work, and Loops are a candidate for intake/enrichment. Neither is adopted *yet* — both are gated on `MOV-141`'s feasibility and cost findings. See `docs/governance/hybrid-execution-architecture.md` §Feasibility gates. Cloud execution never covers iOS/Xcode work, which stays on the Mac adapter permanently.

## Agent Guidance vs. repository files

- **Linear (team-level Agent Guidance)** carries process rules: how to read an issue, what each workflow state means, when to ask a question vs. proceed, escalation boundaries, branch/PR conventions. It is a pointer at the repo, never a duplicate of it.
- **Repository (`AGENTS.md` and friends)** carries everything that must hold even when Linear is unreachable: verification lanes, security constraints, testing policy, coding conventions, the PR template's Test Impact requirement.

Any rule that constrains code lives in the repo. Any rule that constrains process lives in Linear.

## Source-of-truth boundaries

| Domain | Authority |
|---|---|
| What to build, why, priority, acceptance criteria, discussion, decisions, **desired** status, release planning, agent delegation, human ownership | **Linear** |
| Source code, tests, CI config, dispatcher code, testing lanes, security constraints, coding conventions, `AGENTS.md`, architecture docs | **Git repository** |
| Branches, commits, PRs, code review, CI results, releases, external bug intake — **delivered** status | **GitHub** |
| Which execution adapter runs a given issue (cloud vs Mac) | **A Linear route label**, scheme defined by `MOV-142` (not yet provisioned), materialized on the issue before dispatch |
| Live agent progress narration, tool calls, intermediate reasoning | **Run logs** — dispatcher run logs (Mac adapter) or Linear Agent Session activity (cloud adapter); referenced from Linear, never authoritative |

Where Linear and GitHub disagree about whether something *shipped*, GitHub wins and Linear is corrected to match. Where they disagree about whether something *should* ship, Linear wins. See `docs/governance/hybrid-execution-architecture.md` §Source-of-truth boundaries.

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

The team settings, initiatives, workflow states, labels, projects, and milestones described above are provisioned by `tools/dispatcher/scripts/provision-linear-workspace.mjs`, an idempotent script safe to re-run any time the workspace needs to be reconciled back to this design (e.g. after a manual mistake, or when setting up a second environment). It reads `LINEAR_API_KEY` from `~/.config/moviecal/linear.env`. It does not create custom views (see above).

## GitHub Issues: migration and ongoing sync

**Completed 2026-09-04.** All 110 existing GitHub issues (7 open, 103 closed) were imported into Linear team `MOV` via Linear's GitHub Issues import assistant (`issueImportCreateGithub`), landing as 114 total issues (110 imported + 4 Linear-default onboarding issues), split exactly as expected: 103 → `Done`, 7 → `Backlog`. Every imported issue carries a GitHub source-link attachment and a `Migrated` label (Linear's own, auto-applied — there is deliberately no separate hand-rolled `migration` label; one was created in Stage 3 and deleted once confirmed unused, since it duplicated this).

Connecting GitHub itself required the repo owner's browser: `integrationGithubConnect` needs an OAuth `code` + `installationId` obtained by clicking through GitHub's App-install consent screen, confirmed via the public API schema to have no API-key-only path. Once connected (**Linear → Settings → Integrations → GitHub**), the import proceeded via the UI wizard's guided steps (Configure → Export → Select issues → Map users → Confirm).

**Resolved 2026-09-08 — sync is now genuinely two-way.** The workspace's `GitHub Issues Sync` link (`Settings → Integrations → GitHub`) was switched from one-way to two-way in place (our existing repo↔team relationship was the same underlying link, not a separate one — editing it in place was safe, no duplication). Verified afterward, not just assumed: issue counts on both sides were unchanged post-switch (Linear 120, GitHub 110 — no phantom copies), and a live round-trip test (a reply posted inside an existing issue's synced comment thread, and its later deletion) both propagated to GitHub within seconds.

**Comments only sync if posted as a reply inside the issue's synced thread** (the auto-generated root comment reading "This comment thread is synced to a corresponding GitHub issue..."). A new top-level comment is a private, Linear-only note by design — this is what made the original 2026-09-04 test (a top-level comment that never appeared on GitHub) look like proof of one-way-only sync, when it was partly a methodology gap: that test would have failed the same way even with two-way sync enabled, since it wasn't posted in the synced thread. Worth remembering if this needs re-verifying later.

GitHub-side changes and Linear-side changes (status, comments-in-thread, new issues going forward) now both flow in both directions — "GitHub kept in sync for visibility" is true as of this date. See [MOV-115](https://linear.app/moviecal/issue/MOV-115) for the full verification record.

After the one-time import:

- **Linear is the sole authority for new work.** New issues are created in Linear, not GitHub.
- **GitHub Issues remain open for external bug/feature intake** (via `.github/ISSUE_TEMPLATE/bug_report.md` and `feature_request.md`) and get pulled into Linear Triage.
- **No GitHub issue is ever deleted.** The `moviecal Delivery` GitHub Project is archived (read-only) once Linear is verified end-to-end; existing `#NNN` references in 139+ merged PRs and every commit message remain resolvable forever.
- **Two imported issues (`MOV-113`, `MOV-114`) were flagged to `Needs Human Decision`** rather than silently carried forward: both concern governance mechanisms this migration retires (a GitHub Copilot dispatch pilot, and a `/project-update` workflow test fix), and whether they're still worth doing is a call for the repo owner, not something to assume either way.
