# MOV-156: bounded Linear intake Loop validation

**Validated 2026-09-17.** The
[Moviecal intake enrichment](https://linear.app/moviecal/loop/moviecal-intake-enrichment-b231081005de)
Loop is published, enabled, and scheduled daily at 1:00 PM. It enriches exactly
one oldest `Triage` issue per run and stops before execution or delegation.

## Active boundary

- Scope is the single public `Moviecal` team. The Loop may read and update
  synced issues and comments; it has no MCP connectors and web search is off.
- The run plan must name exactly one issue before any mutation. The Loop may
  not inspect or mutate a second issue during that run.
- It may deduplicate, classify area/risk/platform, write acceptance criteria
  and Testing Expectations, split independent platform work, materialize
  execution routes, and create dependency relations.
- Cross-platform parents receive `type:coordination` and `execution:none`.
  Independent children receive explicit `execution:mac` routes and blocking
  relations that preserve server-first sequencing.
- Ambiguous work stops in `Needs Input`; production, security, account,
  billing, credential, or similarly high-risk work stops in
  `Needs Human Decision`.
- It may not start a Coding Session or any other agent session, write code,
  create branches or pull requests, delegate work, spend outside the Loop, or
  act directly on GitHub. Linear's Loop permission editor exposed no separate
  Coding Session switch, so the published instructions contain this explicit
  hard deny and no code or connector capability was granted.

## Budget and audit trail

Before the first live run, the Loop received a **$2 per-loop weekly spend
limit**. At validation time the workspace had $0 workspace credits, automatic
reload disabled, and $20 promotional Loop credits. Three live runs cost
**$1.21 total**:

| Run | Purpose | Cost |
|---|---|---:|
| `de6562be-4132-41a0-9a1a-48c56df0ac61` | Initial fixture batch | $0.35 |
| `0db3b0b6-6de4-4cb8-a9a6-24498e58c1ac` | Corrected cross-platform fixture | $0.67 |
| `4da58db8-d90e-4f68-8cfb-3031d64fcaac` | Corrected high-risk fixture | $0.19 |

The published version, instructions, permissions, run history, and metered
cost remain visible in Linear. The weekly limit is the hard cost ceiling; a
human must approve any change to it.

## Fixture results

All fixtures were disposable and were canceled after validation so none can
enter dispatch. Their issue and run histories remain in Linear.

| Fixture | Result |
|---|---|
| Existing spam (`MOV-218`) | Rejected and canceled instead of enriched. |
| iOS-only (`MOV-221`) | Complete acceptance/testing structure and `execution:mac`; stopped for human review rather than executing. |
| Duplicate (`MOV-222` / `MOV-223`) | `MOV-222` marked duplicate of the canonical issue. |
| Web-only (`MOV-223`) | Complete acceptance/testing structure and explicit route; the deterministic promoter recognized it as ready. |
| Cross-platform (`MOV-224`) | Coordination parent plus server (`MOV-228`), web (`MOV-229`), and iOS (`MOV-230`) children; the server child blocks both clients and every route is materialized. |
| Ambiguous (`MOV-225`) | Stopped in `Needs Input` with a human-facing question. |
| High risk (`MOV-226`) | Stopped in `Needs Human Decision` before classification or execution, naming authorization, rollback, data-boundary, and ownership decisions. |
| External GitHub source (`#478` / `MOV-227`) | Synced through the normal GitHub intake path, then received a complete specification and explicit route. |

The initial prompt allowed a batch of up to six fixtures, but the first run
also encountered and canceled an older spam issue, producing seven mutations.
That failed the intended boundedness test. The Loop was republished with the
one-oldest-issue rule above. Each corrective run then mutated only its named
fixture and left the next `Triage` issue untouched.

## Fallback and rollback

The Loop was disabled before fixture creation. Manual Linear intake and the
GitHub-to-Linear `Triage` sync still worked, the promoter unit suite passed
(`19/19`), and `npm run dispatcher:dry-run` completed without mutation. This
proves the Loop is additive rather than load-bearing.

Rollback is one switch: disable the Loop. Issues continue to arrive in
`Triage`, humans can enrich them manually, and the deterministic promoter
continues to move only contract-complete `Backlog` work into
`Ready for Agent`. Loop disablement does not affect the Mac dispatcher,
GitHub sync, existing issue data, or run history.
