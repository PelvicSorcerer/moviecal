# Linear workspace information architecture

This document is the authoritative design for how `moviecal` uses Linear as the product/work-item/agent-governance control plane. It replaces the GitHub Project (`moviecal Delivery`) as the source of live queue state. See `docs/governance/hybrid-execution-architecture.md` for the active local-first execution model and its separately deferred cloud option, `docs/operators/local-execution.md` for how a Linear work item becomes execution on the Mac, and `docs/operators/archive/` for the retired GitHub-Project-centric model this supersedes.

## Why Linear, and why this shape

The previous system used a GitHub Project v2 as the control plane because agents ran in cloud containers that could not reliably reach GitHub's GraphQL API and needed a single-writer, single-dispatch-slot model to avoid races. On a local Mac with a real dispatcher process, that constraint disappears: dependency graphs, ordering, and concurrency can be enforced by code and by Linear's native relations instead of by a hand-maintained text field and a single global mutex.

This design deliberately does not reproduce the GitHub Project's fields one-for-one. Linear has native primitives for most of what the old system had to invent (typed relations instead of a `Dependencies` text field, native issue ordering instead of a `Queue Order` number, Projects/Initiatives instead of a `Track` enum). Where Linear's native model is strictly better, use it; only fall back to labels where Linear has no first-class equivalent.

## Plan

**Plan facts are dated evidence, not routing policy.** `MOV-141` verified Basic on 2026-09-10; the workspace was subsequently upgraded and Loops became available. The exact current checkout/credit balance remains an authenticated-UI fact and must be rechecked before paid execution.

**Paid AI capabilities remain explicitly bounded.** `MOV-156` is active local-delivery work for least-privilege intake enrichment, with a capped budget and no Coding Session permission; `MOV-220` separately owns the Loop-to-Mac handoff. Coding Session work (`MOV-153`–`MOV-155`, plus `MOV-157`) is isolated in the deferred-cloud project and remains in `Icebox`. Nothing here authorizes a credit purchase, cloud pilot, or automatic paid execution. See `docs/governance/mov-141-linear-capability-findings.md` for dated evidence and `docs/governance/hybrid-execution-architecture.md` for current gates and fallbacks.

`MOV-156` subsequently validated and enabled the intake Loop with a $2 weekly
per-Loop cap. At validation the workspace had $0 workspace credits, automatic
reload disabled, and $20 promotional Loop credits; three runs cost $1.21. See
`docs/governance/mov-156-linear-intake-loop-validation.md` for the live
configuration and audit evidence.

**Initiatives:** initiative creation and linking is enabled on this workspace. The original Basic-plan probe found the lead-team sub-feature gated, but with one team (`MOV`) that field adds nothing; `provision-linear-workspace.mjs` therefore creates initiatives without a lead-team assignment.

## Workspace / Teams

One workspace (`moviecal`), one team (`MOV`). GitHub Issues Sync is one-repo-to-one-team; a single-developer project gains nothing from splitting teams.

## Initiatives

An initiative is a **completable outcome**: it has a definition of done and ends. It is not a permanent bucket for a platform or product area. Three initiatives group the active product, release, and development-system outcomes:

- **Deliver Shared Watchlists across Web and iOS** — the *feature* outcome. Contains Shared Watchlists Core & API, Web Shared Watchlists, and iOS Shared Watchlists. It completes when shared watchlists work end to end on both clients.
- **First iOS TestFlight beta** — the *release* outcome. Contains iOS Companion App, Shared Watchlists Core & API, and iOS Shared Watchlists. It does **not** contain Web Shared Watchlists: the first TestFlight build requires native Shared Watchlists and the Core & API capability it needs, not completion of the web collaboration experience.
- **Automate moviecal Development and Delivery** — cross-cutting development infrastructure that supports every current and future product initiative. Its active projects are Autonomous local-agent delivery and Deferred Linear cloud execution option; completed/canceled predecessor projects remain associated for history.

**Feature versus release membership.** A feature initiative groups the projects that together deliver one capability; a release initiative groups the projects that must be complete to cut one release. The same project may belong to both. Shared Watchlists Core & API and iOS Shared Watchlists are in both initiatives above, so their progress is counted in both rollups. Overlapping rollups are intentional and must not be added together as a portfolio total. Membership never gates dispatch; real prerequisites are issue-level blocking relations.

**Retired initiatives.** The former perpetual **Web App** and **iOS App** initiatives (and the empty **Calendar Feed** project) are superseded. The live objects and their historical project links are preserved as audit history; the provisioner never creates, relinks, or deletes them. Permanent platform grouping is provided by project labels and views (see §Project labels and platform views), not by initiatives.

(A first attempt at provisioning these hit `FEATURE_NOT_ACCESSIBLE` — initiatives were originally plan-gated on this workspace, so this doc briefly shipped a "skip initiatives, projects stand alone" design. The repo owner then enabled the feature directly in Linear, and the initiatives + links above were created and verified live. The `leadTeamId` sub-feature remains gated, see "Plan" above — irrelevant here with one team.)

## Projects

| Linear project | Initiative | Role |
|---|---|---|
| Shared Watchlists Core & API | Deliver Shared Watchlists across Web and iOS + First iOS TestFlight beta | Shared watchlist data, authorization, invitations, calendar behavior, and versioned API used by both clients. Required for the first TestFlight build to the extent native Shared Watchlists depends on it |
| Web Shared Watchlists | Deliver Shared Watchlists across Web and iOS | Finite browser collaboration experience using the shared core. Not a TestFlight prerequisite |
| iOS Shared Watchlists | Deliver Shared Watchlists across Web and iOS + First iOS TestFlight beta | Finite native collaboration experience using the shared API. Required before the first TestFlight build |
| Platform & Infrastructure | None (historical link to the retired Web App initiative) | **Completed.** Finite platform outcome; audit history |
| iOS Companion App | First iOS TestFlight beta | Finite native-app outcome (personal-watchlist parity and release engineering) |
| Documentation aligned with shipped product | None | Finite product documentation reconciliation; deliberately not an ongoing documentation bucket |
| Autonomous local-agent delivery | Automate moviecal Development and Delivery | **Active.** Finish bounded local intake, handoff, acceptance, and controlled autonomy |
| Deferred Linear cloud execution option | Automate moviecal Development and Delivery | **Deferred.** Keep cloud environment/kickoff/pilots independently authorizable and out of the local critical path |
| Local development workflow stabilization and governance | Automate moviecal Development and Delivery | **Completed history.** Finite Mac/local stabilization and handoff |
| Hybrid workflow foundations (completed) | Automate moviecal Development and Delivery | **Completed history.** Architecture, routing, CI/review, and Agent Session foundations |
| Developer Governance & Agent Infrastructure | Automate moviecal Development and Delivery | **Canceled audit history.** Do not assign new issues |

`Docs` and `Migration` are not projects — they are work *types*, represented as labels. `Future` is not a project — it is the `Icebox` backlog state. There is no Calendar Feed project: the calendar feed shipped inside the existing product projects, and the empty project was retired rather than kept as a topic bucket.

The legacy Developer Governance & Agent Infrastructure project is deliberately retained so its former organization remains auditable. Its old milestones remain empty; all issues were moved to finite successors. Do not delete or repopulate it. The provisioner leaves it and the completed predecessor projects untouched and never performs issue migration. Documentation aligned with shipped product has no initiative because it is a bounded reconciliation task spanning product surfaces, not an initiative outcome on its own.

**The three Shared Watchlists project boundaries.**

- **Shared Watchlists Core & API** owns capability shared by both clients: data model, authorization, invitation and acceptance safety, calendar behavior, and the bearer-authenticated `v1` API with cross-client authorization parity. Nothing client-specific belongs here.
- **Web Shared Watchlists** owns the browser collaboration flows and the two-account web journey. It consumes the core; it does not own API behavior.
- **iOS Shared Watchlists** owns the native SwiftUI collaboration flows, accessibility, and web/iOS parity. It consumes the core's `v1` API; it does not own API behavior.

Shared Watchlists Core & API is in both the feature initiative and the TestFlight release initiative, and iOS Shared Watchlists is in both, because each initiative depends on those capabilities. Progress is counted in every initiative that contains a project; percentages therefore overlap and must not be added together as a portfolio total. Web and iOS delivery remain separate projects, so each initiative's status can be read alongside the core project's status. New feature work belongs to the project that owns its capability, regardless of which client is scheduled to ship first. Use issue-level blocking relations for actual API-to-client prerequisites; project membership and milestone order do not impose sequencing. A future Android app can gain its own feature project and initiative without moving shared-core issues.

**First TestFlight scope.** The first TestFlight build requires the completed iOS Companion App outcome, completed iOS Shared Watchlists, and the Core & API capability that native Shared Watchlists needs. It does not require completion of Web Shared Watchlists. The web project can finish before or after the beta without moving the release. See `docs/planning/native-ios-app-plan.md` (decision D6).

### Project labels and platform views

Web and iOS are permanent *classifications*, not outcomes, so they do not get initiatives. Group them with workspace **project labels** `platform:web` and `platform:ios`, provisioned by `provision-linear-workspace.mjs` and applied to active projects (Core & API carries both; Web Shared Watchlists carries `platform:web`; iOS Shared Watchlists and iOS Companion App carry `platform:ios`). Permanent per-platform project views filter on those labels and are built by hand in the Linear UI, like the issue views in §Custom views; the provisioner deliberately does not create saved views through the undocumented `filterData` shape.

## Planning-object semantics

Use the smallest Linear object that expresses the actual planning relationship:

- **Initiative:** a strategic outcome spanning one or more projects, with a definition of done. An initiative is completable — never a permanent platform or topic bucket — and may be cross-cutting. A feature initiative and a release initiative may share projects; their rollups overlap by design.
- **Project:** a finite, completable outcome with an explicit boundary. A project is not a permanent topic bucket for every future issue in an area. Later defects or enhancements belong in the ordinary backlog or a new bounded project unless they are required to satisfy the original completion criteria.
- **Milestone:** a project-local phase containing multiple issues and a recognizable exit condition. Milestones never span projects and should not be used as reusable topic tags.
- **Parent issue:** one bounded deliverable split into child issues, normally one implementation issue per PR. A parent must not duplicate the scope of its project or act as a permanent milestone coordinator. Parent completion is derived from child state.
- **Label:** reusable classification across projects, such as execution route, work type, risk, worker, model, or area.

Classify an issue by its actual scope, parent/child role, and dependency graph—not by whichever milestone or project historically contained it. Coordination-only work uses `type:coordination` plus `execution:none` and produces no implementation PR.

## Project milestones

Used only where a real multi-issue phase exists. Every milestone is local to one project, has a recognizable exit condition, and may omit a target date when dependency order rather than calendar time is the useful boundary. Milestone display order communicates the intended project narrative; it does **not** gate issue execution.

**iOS Companion App** uses `Skeleton` → `Auth + API client` → `Navigation shell`, matching the dependency chain that was GitHub issues #237 → #238/#239 → #240.

**Shared Watchlists Core & API** uses `Access and invitation safety` and `Cross-client shared API`. The first exits when ownership, invitation concurrency, and acceptance safety are proven; the second exits when the bearer-authenticated API and cross-client authorization parity are verified. **Web Shared Watchlists** uses `Complete web collaboration` for the browser flows and two-account journey. **iOS Shared Watchlists** uses `Native experience` for accessible SwiftUI flows and web/iOS parity. Each milestone belongs only to its own project; genuine issue-level prerequisites cross those project boundaries.

**Autonomous local-agent delivery** uses `Automated intake & local kickoff` → `Local acceptance & controlled autonomy`. The first phase records the architecture, configures bounded intake enrichment, and proves the separate Loop-to-Mac handoff. The second resolves local testing policy, runs local acceptance/recovery drills, and only then permits risk-scoped automatic readiness/merge. The project ends at that local outcome; cloud execution is not an exit criterion.

**Deferred Linear cloud execution option** uses `Cloud environment & kickoff` → `Cloud pilots & eligibility`. Every delivery issue remains in `Icebox` until the cloud option is explicitly authorized, and the chain never blocks the active local project.

**Completed history:** Local development workflow stabilization and governance retains its five 100%-complete phases, and Hybrid workflow foundations (completed) retains its seven historical phases. Their unfinished cloud/local-convergence concepts were moved into the two active/deferred projects rather than used to keep a partially complete project open.

A project reaching 100% means its defined outcome is complete. Do not keep a finished project open merely as a future maintenance container; create or select the bounded project that owns the new outcome.

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

**The readiness contract (MOV-129).** An issue in `Backlog` is auto-promoted to `Ready for Agent` when it is not labeled `human-only`, its description has a non-empty acceptance-criteria section (heading matching `/^#+\s*acceptance criteria/i`) and a non-empty Testing Expectations section (`/^#+\s*testing expectations/i`), and every issue that `blocks` it is in a completed/canceled state. `blocks` relations plus the dispatcher's preflight do all sequencing; the promoter only judges readiness. It runs as a phase of `dispatcher run` (and standalone as `dispatcher promote [--dry-run]`). In `enforce` mode it additionally requires the issue to satisfy §Issue completeness contract below; that gate ships as `report`, so readiness is unchanged until the owner raises it. See `docs/operators/local-execution.md` §Automated promotion.

## Labels

- `area:{watchlist,calendar,auth,database,tests,deployment,docs,process}` — routing (replaces GitHub `Area`)
- `risk:{low,medium,high}` — replaces GitHub `Risk`
- `worker:{claude,codex,any}` — which worker binary should implement this (see `docs/operators/worker-routing.md`)
- `model:{cheap,default,strong}` — model tier override (see `worker-routing.md`)
- `human-only` — never a dispatch candidate (replaces GitHub `Execution Mode = Human`)
- `needs-secrets` — dispatcher refuses to start until the required local secret is present (replaces GitHub `Needs Infra/Secrets`)
- `type:{feat,fix,chore,docs,test,coordination}` — work type (absorbs the old `Track = Docs` / `Migration` distinction); coordination issues also require `execution:none`
- `upgrade:{multi-system,ambiguous-spec,security-critical,prior-failure,architecture}` — cites the upgrade condition when `model:strong` is applied (see `docs/operators/worker-routing.md`); the dispatcher's routing logic requires at least one of these alongside `model:strong`
- `execution:{cloud,mac,none}` — mutually-exclusive execution adapter route, provisioned as one Linear label group by `tools/dispatcher/scripts/provision-linear-workspace.mjs`; `type:coordination` issues use `execution:none` and never auto-promote

No separate `migration` label: the historical-import marker is Linear's own auto-applied `Migrated` label (added to every issue by the GitHub Issues import assistant), not a hand-rolled one. A `migration` label was created here in Stage 3 before that was known, then deleted once confirmed unused — see "GitHub Issues: migration and ongoing sync" below.

## Issue completeness contract

**Outside `Triage`, an issue is filed fully specced.** All applicable labels, a project, and a milestone — a milestone may be omitted only when one genuinely does not apply. This applies to every issue whose state is not `Triage`, `Done`, `Released`, `Canceled`, or `Duplicate`: `Backlog`, `Icebox`, `Spec Ready`, and every started state included.

`tools/dispatcher/src/issue-spec.mjs` is the machine-checkable expression of everything below, and the only one. It is consumed by the promoter's gate, dispatch preflight, and the audit pass. The promoter and preflight are separate checkpoints: a human or Loop can move an issue to `Ready for Agent` without the promoter, but preflight always runs before dispatch. The audit covers the remaining open non-`Triage` issues. It runs at most once per `MOVIECAL_ISSUE_SPEC_AUDIT_INTERVAL_MS` (24 hours by default), or immediately on demand via `dispatcher audit-issues`.

**Labels, by kind:**

| Kind | Required |
|---|---|
| **Dispatchable** (not `human-only`, not `type:coordination`) | exactly one each of `execution:*`, `type:*`, `risk:*`, `worker:*`, `model:*`; at least one `area:*`; at least one `upgrade:*` when `model:strong` is set |
| **`human-only`** | `execution:none`, one `type:*`, one `risk:*`, at least one `area:*`. No `worker:*` or `model:*` — nothing routes it. Precedent: [MOV-292](https://linear.app/moviecal/issue/MOV-292) |
| **Coordination** (`type:coordination`) | `execution:none`, one `risk:*`, at least one `area:*`. Its type label is what identifies it, and it produces no implementation PR |

The `model:strong` rule is not restated in the validator: it calls `resolveRouting()` (`worker-routing.mjs`) directly, so the intake check and the dispatch-time check cannot drift. Before this, `model:strong` without an `upgrade:*` label was caught only at routing time — after the issue had already been promoted — so it bounced at dispatch instead of at intake.

**Project:** required, and it must not be a completed or canceled project. A finished project is not a maintenance bucket (see §Projects).

**Milestone:** required when the issue's project defines at least one milestone. A project with no milestones cannot require one. The single exception is an explicit, reasoned opt-out line in the description:

```
Milestone: N/A — <reason>
```

The reason is mandatory: `Milestone: N/A` with nothing after it does not satisfy the rule, because an unexplained opt-out is indistinguishable from having forgotten the field. The line may be bulleted and/or bold, and an em dash, en dash, or plain hyphen all separate it.

**Relations are required but are not machine-checked.** Genuine `blocks` / `blocked by` / parent relations are part of this contract (see §Relations for what "genuine" means). Their *completeness* is not mechanically decidable — nothing distinguishes "this issue has no prerequisites" from "its prerequisites were never recorded" — so the validator deliberately does not check it. This half of the contract is carried by documentation and review, not by code.

**Nothing is ever auto-filled, with one narrowly-scoped exception.** The promoter never writes a label, project, or milestone. Choosing them is a human or authoring-agent decision, and a dispatcher-written guess would be indistinguishable from a real one the moment it landed. The state write to `Ready for Agent` itself is not a guess — it is the promoter's own defined role — and the one field-level exception is the assignee (MOV-359): an otherwise-promotable issue with **no assignee at all** gets the single operator-configured human owner (`MOVIECAL_DEFAULT_OWNER_EMAIL`) immediately before that state write, because Linear refuses to let the handoff Loop (MOV-220) delegate an unowned issue. An issue that already has any assignee is never touched, and the owner is always the one configured human — never inferred from the issue's creator or any other heuristic. See `docs/operators/local-execution.md` §Configured human owner before handoff for the full mechanism.

## Estimates

Issue estimates are deliberately not used. Agent routing and decomposition are governed by explicit acceptance criteria, Testing Expectations, risk, model tier, execution route, and dependency relations. An issue that is too broad should be split into parent/sub-issues rather than assigned an otherwise unused point value.

## Relations

Replace the free-text `Dependencies` GitHub field with native Linear `blocked by` / `blocks` relations. Linear enforces these referentially — there is no equivalent of the old dependency-syntax validator (`scripts/lib/project-queue-common.sh`) because malformed or dangling references are not representable in the first place.

Dependencies encode genuine prerequisites, not presentation order. If work in a later milestone would be invalid before an earlier phase is accepted, gate it with a meaningful exit/acceptance issue: required phase work → phase exit → later entry work. Do not make an arbitrary "last-looking" implementation issue the gate, and do not connect milestones merely to force a linear display. Leave independent work unblocked so it can proceed in parallel. Cross-project blocking is appropriate only for a real required handoff. Optional or deferred `Icebox` work—especially the cloud-execution chain—must not block a local release or project exit unless a human explicitly promotes it into that scope.

Priority ranks issues that are simultaneously actionable; it is not a substitute for dependencies. Use Urgent/High/Medium/Low coarsely, and manually order only the small visible cohort of equally prioritized actionable issues. Do not curate a total ordering of the entire blocked backlog.

**Relation direction — do not create these by hand.** Linear's `issueRelationCreate` mutation reads `input.issueId` as the *source* of the named relation and `input.relatedIssueId` as its *target*, so `type: "blocks"` means "`issueId` **blocks** `relatedIssueId`". Passing the pair the intuitive-but-wrong way (earlier issue as `relatedIssueId`) builds the whole chain backwards — the last issue ends up unblocked and the first shows as blocked by its successor. This has happened more than once. Use `LinearClient.addBlocksRelation({ blockerId, blockedId })` or `LinearClient.linkBlockingChain([...orderedIds])` (`tools/dispatcher/src/linear-client.mjs`), which take role-named arguments and are unit-tested against the field mapping; if you must call the raw GraphQL, verify the direction with a readback query before moving on.

**Reading the direction back is just as easy to invert (MOV-128, and its follow-up fix).** An issue's own `relations` field of type `blocks` lists issues *it* blocks (its dependents), not its blockers — the same inversion class as the write-side bug above, just on the read path. The issues that actually block a given issue show up under that issue's `inverseRelations`. One more trap inside `inverseRelations`: for a `blocks` entry there, **`issue` is the blocker and `relatedIssue` is the issue itself** — read `issue`, not `relatedIssue` (`relatedIssue` is just self, and keying gate state off it makes an issue look blocked by itself, which never clears). `LinearClient.issuesInState()` derives `blockedByIds` from `inverseRelations[].issue.id`, and `tools/dispatcher/src/dependency-gate.mjs`'s `buildIsIssueSatisfied()` resolves each blocker's workflow state from `inverseRelations[].issue.state` in the same query (no extra Linear call) to gate dispatch in `tools/dispatcher/src/run-context.mjs`'s `buildRunContext()` (MOV-197 moved this out of `bin/dispatcher.mjs`, which calls `main()` at module load and so cannot be imported for testing, into this importable module so the wiring itself is covered by `tools/dispatcher/test/run-loop-e2e.test.mjs` — `bin/dispatcher.mjs`'s real `run` command still calls it for the live path).

## Custom views

The supervision dashboard for a human overseeing autonomous work. **Build these by hand in the Linear UI** (Views → New view), not via the API: the saved-view `filterData` JSON shape isn't part of the documented public schema, and getting it wrong risks a saved view that looks legitimate but silently returns nothing — a few minutes of manual setup is cheaper than that risk. Each takes under a minute using Linear's own filter builder:

- **Moviecal — Ready now** — team `Moviecal`; status is not `Blocked`, `Done`, `Released`, `Canceled`, `Duplicate`, or `Icebox`; issue **is not blocked** by any unresolved native relation. Do not filter by initiative, project, milestone, assignee, delegate, or `human-only`. Use no grouping or sub-grouping, order by Priority, show sub-issues, and display Priority, Status, Project, Milestone, assignee/delegate, Parent issue, and Labels. Keep expanded parents collapsed during daily scanning if their terminal children add noise. The status filter and relation filter are intentionally separate: one catches an explicitly Blocked workflow state, while the other catches unresolved prerequisites even when status drifted.
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

**Gated capabilities:** **Linear Coding Sessions** are preserved as a deferred option, isolated in their own project and `Icebox` chain; they are not the current default for non-iOS work. **Loops** are adopted only for the bounded intake role validated by `MOV-156` and the distinct delegate-only local handoff validated by `MOV-220`. Neither Loop has Coding Session authorization. Manual/Triage intake, the promoter, manual delegation, and dispatcher polling remain the complete fallback. Cloud execution never covers iOS/Xcode work. See `docs/governance/hybrid-execution-architecture.md`.

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
| Which execution adapter may run a given issue (Mac, deferred cloud, or none) | **A Linear route label**, provisioned by `MOV-142` and materialized on the issue before dispatch |
| Which actor may start a local worker | **The Linear delegate field**; only `moviecal-dispatcher` may drive the local adapter |
| Live agent progress narration, tool calls, intermediate reasoning | **Run logs** plus optional Linear Agent Session activity; referenced from Linear, never authoritative |
| An attempt's lifecycle presentation (acknowledgement, PR link, errors, stop) | **Linear comments**, or Agent Activities when that capability is available (MOV-158). Presentation and history only: the authoritative identity of a piece of work is the **issue + branch + PR**, never a session id. A session or comment can be lost, replayed, or replaced by a new linked attempt without changing what the work *is*. |

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
| `Target PR Size` | Retired — use acceptance criteria and parent/sub-issue decomposition |
| `Area` | Label `area:*` |
| `Needs Infra/Secrets` | Label `needs-secrets` |

## Provisioning

The active team settings, initiatives, workflow states, labels, projects, and milestones described above are provisioned by `tools/dispatcher/scripts/provision-linear-workspace.mjs`, an idempotent script safe to re-run when the workspace needs to be reconciled back to this design or when setting up a second environment. It reads `LINEAR_API_KEY` from `~/.config/moviecal/linear.env`. It provisions the two outcome initiatives and their project memberships, the active product, local, and deferred-cloud projects, milestones, and the `platform:*` project labels; the desired topology is declared in `tools/dispatcher/src/linear-topology.mjs`. It is additive: it does not provision the retired Web App / iOS App initiatives or the Calendar Feed project, and it does not create custom views, move issues, delete or unlink anything, or mutate completed/canceled audit projects and initiatives. Run it with `--check` for a read-only drift report (it exits 1 when the live topology differs from the design, and also flags unplanned projects inside the managed initiatives for a human to resolve). Deterministic tests cover the desired topology and idempotency against a mocked GraphQL boundary; no test writes to live Linear.

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
