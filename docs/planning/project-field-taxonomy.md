# GitHub Project field taxonomy

Status: normative for `moviecal Delivery` custom field **values**. Read `AGENTS.md` first for the generic queue contract.

## Authority

| Surface | Authoritative for |
|---|---|
| **Live GitHub Project** (`PelvicSorcerer/2`) | Current allowed option values for `Track`, `Area`, `Status`, `Agent Dispatch`, and other project custom fields |
| **This document** | Canonical allowed values, dispatch-eligibility mapping, and mismatch handling when repo docs or issue bodies disagree with the live project |
| **`docs/planning/github-project-migration-plan.md`** | Historical schema design and bootstrap examples; field option lists here match the live project |
| **GitHub issue bodies** | Execution contracts only: background, acceptance criteria, verification, security notes, dependencies — **not** project field values |
| **`docs/operators/multi-platform-dispatch-policy.md`** | Dispatch rights and orchestrator lifecycle; uses **product delivery** as a policy category, not always as a literal project `Track` option |

When sources disagree, follow `AGENTS.md`: reconcile the **live GitHub Project first**, then update issue state if needed, then update docs. Orchestrators must **not** silently substitute the “closest” project field value.

## Canonical `Track` values

These are the only valid values for the project `Track` single-select field:

| Project `Track` value | Dispatch eligible | Meaning |
|---|---|---|
| `Shared Watchlists` | Yes | User-facing watchlist / shared-list product delivery |
| `Calendar` | Yes | User-facing calendar feed / subscription product delivery |
| `Docs` | Yes | User-facing or repo-facing documentation delivery that belongs on the product board (not governance-only `docs/**` PRs) |
| `Future` | Yes | Executable non-product workstreams (testing programs, architecture hardening, strategic infrastructure) |
| `iOS` | Yes | Native iOS delivery work; mixed execution, with promotion and start-time eligibility gated by the self-hosted macOS runner policy |
| `Platform` | No | Compatibility, governance, process |
| `Migration` | No | Cutover work |

There is **no** project `Track` option named `Product`.

### Policy category: product delivery

Docs and issue bodies often say **product delivery** or `Track = Product`. That is a **dispatch-policy category**, not a project field value. Map product-delivery work to a domain `Track` above:

| Issue scope (examples) | Use project `Track` |
|---|---|
| Shared watchlist features, watchlist API surfaces, movie search for personal-watchlist parity | `Shared Watchlists` |
| Calendar feeds, calendar tokens, `.ics` subscription work | `Calendar` |
| Documentation shipped as a tracked delivery item | `Docs` |
| Testing programs, hardening, or infrastructure not tied to one product domain | `Future` |
| Native iOS app work under `ios/` and related mobile delivery issues | `iOS` |
| Governance, operator tooling, queue mechanics | `Platform` |
| Project cutover / migration | `Migration` |

If the issue scope does not clearly map to one domain track, **stop and escalate to a human**. Do not guess.

## Canonical `Area` values

These are the only valid values for the project `Area` single-select field:

`watchlist`, `calendar`, `auth`, `database`, `tests`, `deployment`, `docs`, `process`

There is **no** project `Area` option named `backend`.

Map work by primary functional surface:

| Issue scope (examples) | Use project `Area` |
|---|---|
| Watchlist persistence, watchlist UI/API, movie search endpoints for watchlist flows | `watchlist` |
| Bearer/JWT/session validation, sign-in boundaries (when auth is the primary deliverable) | `auth` |
| Schema, migrations, RLS, query modules | `database` |
| Test-only or lane-coverage issues | `tests` |
| Deploy, cron, hosting, CI wiring | `deployment` |
| Operator/process/governance docs | `docs` or `process` |

If the issue scope does not clearly map to one area, **stop and escalate to a human**. Do not guess.

## Orchestrator-owned workflow fields

`Status`, `Agent Dispatch`, `Queue Order`, `Priority`, `Risk`, `Execution Mode`, `Target PR Size`, and `Needs Infra/Secrets` remain **orchestrator-owned** on the project item. Issue bodies may suggest values in a `Track / priority` or queue note section; treat those as **hints only**.

Orchestrators set workflow fields from live queue policy (`docs/operators/multi-platform-dispatch-policy.md`) and current board state.

## Taxonomy mismatch protocol

Stop **before** writing project fields when:

1. An issue body or template contains `Track = Product`, `Area = backend`, or any value not listed in this document.
2. More than one domain `Track` or `Area` plausibly applies and the issue does not state a preference.
3. `/project-update` or `gh project item-edit` would need an unsupported option ID.

Report:

- issue number
- unsupported or ambiguous requested value
- relevant issue scope excerpt
- the allowed values from this document
- whether human triage is required before project writes

Do **not** post `/project-update` with unsupported values; the workflow validates against live project options and will fail without fixing the underlying mismatch.

Exception: the table in **Resolved open-issue mappings** below is an explicit, one-time resolution for issues #221–#224. It does not authorize agents to invent mappings for other issues.

## Resolved open-issue mappings (issues #221–#224)

These issues were created with `Track = Product` and/or `Area = backend` shorthand in their bodies. The canonical live project `Track` / `Area` pair for each issue is:

| Issue | Project `Track` | Project `Area` | Rationale |
|---|---|---|---|
| #221 | `Future` | `tests` | Real-Supabase / full-stack bearer-auth test coverage |
| #222 | `Shared Watchlists` | `watchlist` | Movie search for native personal-watchlist parity; bearer auth is an implementation constraint, not the primary functional area |
| #223 | `Calendar` | `calendar` | Calendar subscription URL endpoint |
| #224 | `Calendar` | `calendar` | Calendar token rotation endpoint |

Orchestrators must apply these mappings when reconciling #221–#224 from issue-body shorthand. For any **other** issue with unsupported taxonomy values, continue to stop and report rather than guess.

## Issue template and new issues

Use only canonical values in new issues. Prefer:

```markdown
## Queue note

- Suggested project `Track`: <one canonical Track value>
- Suggested project `Area`: <one canonical Area value>
- Dispatch: `Agent Dispatch = No` unless an orchestrator promotes the issue
- Orchestrator sets `Status`, `Queue Order`, and other workflow fields
```

Do not write `Track = Product` or `Area = backend` in new issues.

## Automation alignment

`scripts/lib/project-queue-common.sh` currently treats these project `Track` values as dispatch-eligible: `Shared Watchlists`, `Calendar`, `Docs`, and `Future`. The iOS mixed-execution runner gate and the authoritative `Dependencies` field are tracked as follow-up automation work in issue `#241`; until then, the live project fields and operator docs remain authoritative for iOS queue eligibility. `Platform` and `Migration` must keep `Agent Dispatch = No`.

`scripts/export-open-issue-order.sh` exports ordering for open product-board items by excluding `Future`, `Platform`, `Migration`, and non-product areas — see that script for the compatibility artifact filter.

## Live project schema follow-up

This document describes the **current** live project. Adding new `Track` or `Area` options (for example a literal `Product` track) requires a **human/admin GitHub Project schema change** plus a follow-up docs and automation PR. Do not add project options from agent sessions.
