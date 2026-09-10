# MOV-141: Linear entitlement and hybrid-agent capability findings

**Validated 2026-09-10.** This record closes the feasibility gate created by
`MOV-140`. A capability being plan-eligible is not the same as it being ready
to use: the cloud lane, Loops, and custom Agent Sessions remain disabled until
their implementation issues satisfy the prerequisites below.

No plan change, AI-credit purchase, Loop run, Coding Session, production
secret, deployment, or release was used for this validation.

## Executive decision

- Keep the **Mac lane and 30-second Linear polling as the complete operational
  fallback**. The existing app-actor GraphQL path is live and sufficient for
  route/delegate discovery, issue state, comments, and PR/check reporting.
- The current **Basic** plan is eligible for Coding Sessions, but the moviecal
  coding environment has not been verified and the exact AI-credit balance is
  not exposed by the public API. `MOV-153` remains the configuration and
  disposable-PR gate.
- **Loops are not available on the current plan.** They require Business plus
  AI credits. Do not upgrade for `MOV-156` until the cost is explicitly
  approved.
- The custom `moviecal-dispatcher` app is installed and delegable, but **Agent
  Sessions are disabled** for it. The Developer Preview lifecycle must not sit
  on the critical path. Enabling it would require an HTTPS webhook receiver;
  the local Mac must not expose an inbound listener.
- Linear documents follow-up and review-repair actions for Coding Sessions,
  but no same-branch cloud repair was run here because doing so would consume
  AI credits. Until `MOV-153` proves that path, repair stays on the original
  GitHub branch and PR and is performed manually on the Mac.

## Workspace evidence

Live reads used the existing `moviecal-dispatcher` app credential without
printing any credential value.

| Observation | Live result | Consequence |
|---|---|---|
| Workspace subscription | `basic_monthly_12`, one seat, no active trial | Coding Sessions are plan-eligible; Loops are not. |
| Workspace feature state | `codingAgentEnabled: true`; no coding-agent settings were exposed by the public API | The product surface is enabled, but the moviecal coding environment is not proven. Inspect it in the authenticated UI during `MOV-153`. |
| AI add-on state | `aiAddonEnabled: false` | Treat the usable paid balance as unavailable. Before a pilot, an admin must verify the exact balance in **Settings → Usage & limits** and explicitly authorize any top-up. |
| Custom app identity | `moviecal-dispatcher` is an active, non-admin app user and can be set as an issue delegate | The local handoff can use Linear's native `delegate` field without changing human ownership. |
| Disposable route/delegate probe | `MOV-165` accepted `execution:mac` plus the `moviecal-dispatcher` delegate; the real dispatcher client read both fields back as the app actor | Route label + polling is a proven Loop-to-Mac fallback. The fixture synced to GitHub issue `#355`; canceling it closed the GitHub issue with the expected labels intact. |
| Custom Agent Session creation | `agentSessionCreateOnIssue` returned `agent sessions disabled` before an activity was emitted | Session activity, prompts, stop signals, stale recovery, and PR-link UI are unavailable for this app until Agent Session webhooks are enabled. |

The GraphQL schema exposes the Developer Preview Agent Session mutations, but
schema presence is not entitlement. The failed live mutation is the workspace
authority for the current state.

## Capability matrix

| Capability | Classification | Evidence and required path |
|---|---|---|
| Loops on the current workspace | **Unsupported on the current plan** | Moviecal is on Basic; Linear makes Loops available on Business and Enterprise. Manual/Triage intake remains live. |
| Loop directly delegates to `moviecal-dispatcher` | **Unproven and not required** | A Loop cannot be created on the current plan. Linear documents Loop permission to start its own Coding Session and to use MCP connectors, but does not document a dedicated arbitrary-agent delegation action. `MOV-156` may test a plain issue-field update after an approved upgrade; it must not depend on that outcome. |
| Loop-to-Mac handoff | **Supported through the fallback** | `MOV-165` proved that the route label and delegate are writable and readable by the existing poller. A future Loop need only leave an issue with `execution:mac`, delegate it to `moviecal-dispatcher`, and place it in the existing lifecycle; the Mac remains private and polls outbound. |
| Coding Sessions on the current plan | **Plan-supported, operationally gated** | Basic is eligible and the workspace feature flag is on. Repository access, environment preparation, branch/PR behavior, and actual credits remain unproven and belong to `MOV-153`. |
| Follow-up after cloud CI/review feedback | **Product-supported, same-branch behavior unproven here** | Linear documents steering/follow-up in a session and delegating review fixes, rebases, and lint repairs. No paid session was started. `MOV-153` must prove that a follow-up updates the original PR branch. |
| Cloud repair fallback | **Documented Mac fallback** | Preserve the original GitHub PR and branch. Until an automated repair mode can attach to a cloud-created branch, a human checks out that branch on the Mac, applies the bounded repair, verifies it, and pushes to the same PR. Changing the issue to `execution:mac` plus the dispatcher delegate is only a routing signal; the ordinary first-run dispatcher must not be used because it branches from `origin/master`. `MOV-149`/`MOV-157` must explicitly support an existing cloud branch before automating this handoff. |
| Custom Agent Session creation and activity | **Unsupported in the current app configuration** | Live creation failed with `agent sessions disabled`. Continue using ordinary app-actor issue mutations and comments. |
| Custom Agent Session prompts, stop signal, stale recovery, PR link | **Fallback required** | These cannot be tested without a session. The preview contract says prompt/stop arrive as Agent Session events, stale sessions recover on a new activity, and PR URLs use session external URLs. None is a current moviecal dependency. Removing delegation or canceling/changing the issue remains the polling-based stop control at the dispatcher's safe re-read boundary. |
| Webhooks replacing polling | **Unsupported as a replacement** | Agent Session UI requires the OAuth app's Agent Session event category and a webhook receiver. Polling cannot receive Agent Activity prompts, but it remains the full recovery path for the durable issue/PR lifecycle. |

## Plan and AI-credit cost

The live plan is **Basic**, not Free. Linear's published annual pricing on the
validation date is $10 per user/month for Basic and $16 per user/month for
Business. Enabling Loops would therefore require a Business plan change; the
checkout total and tax remain authoritative. No upgrade is authorized by
`MOV-141`.

AI credits are a separate prepaid, workspace-level USD balance:

- Coding Sessions are available on Basic, Business, and Enterprise. Each
  session costs provider model tokens at the provider's published rate, with no
  Linear markup, plus **$0.25 per 20-minute sandbox-runtime block**. There is no
  honest fixed per-session estimate before the model and task token use are
  observed.
- Loops are available on Business and Enterprise. A run without a Coding
  Session typically costs **$0.07–$0.20**. The six disposable `MOV-156`
  fixtures therefore have an expected Loop-only range of **$0.42–$1.20**; any
  run that starts coding also adds the Coding Session cost above.
- The minimum ad-hoc top-up is **$10**; automatic reload has a **$50** minimum.
  Purchased funds expire after 12 months. Failed runs, retries, and partial
  completions still consume the resources they used.
- Promotional launch credits are not a planning assumption. Linear's launch
  eligibility window has passed, and the live workspace reports the AI add-on
  disabled.

Safe pilot rule: if `MOV-153` is approved, verify the balance in the
authenticated UI, buy at most one $10 ad-hoc top-up, leave automatic reload
off, set a $10 workspace/user limit, run one disposable docs-only session, and
record its model-token, runtime, and total cost before any second session. If
Loops are later approved, set a separate $2 Loop budget for the six non-coding
fixtures and disable Coding Session permission during that test.

## Webhook contract and fallback boundary

To enable custom Agent Sessions, the OAuth application must subscribe to
**Agent Session events** and supply a reachable HTTPS webhook endpoint. Linear
requires the receiver to respond within five seconds and the agent to emit its
first activity or update its external URL within ten seconds. Follow-up prompts
arrive as `prompted` events; the `stop` signal forbids further agent actions
after it is received. Linear marks an inactive session stale after 30 minutes,
and a later activity can recover it.

This cannot point directly at the local Mac. If `MOV-158` still justifies Agent
Sessions, it needs a narrow signed relay or another hosted receiver, with event
signature validation, idempotency, short retention, and polling recovery. That
infrastructure is an optional richer interaction layer, not a prerequisite for
local dispatch. `MOV-159` remains the decision gate for whether its latency and
operational value justify the added attack surface.

### What MOV-158 did with this finding

`MOV-158` built the dispatcher-side half and stopped exactly at the boundary
above. It added **no** listener, receiver, relay, port, webhook secret, plan
change, or paid-credit dependency — `tools/dispatcher/test/dispatcher-wiring.test.mjs`
asserts structurally that none has since appeared. Concretely:

- One semantic lifecycle, serialized once, published as an Agent Activity when
  the capability is available and as an app-actor comment when it is not. The
  comment surface is the complete operational lifecycle, not a degraded mode.
- Capability detection latched per process, so the `agent sessions disabled`
  rejection above costs at most one failed mutation per daemon lifetime rather
  than one per issue per poll cycle.
- Stale recovery and new linked attempts, following the 30-minute contract
  documented above. Identity is the issue + branch + PR, so a CI repair that
  needs a fresh session still reads as the same work.
- Inbound `prompted`/`stop` payload verification, normalization, trust, and
  idempotent replay — all driven by fixtures and `dispatcher agent-signal
  --fixture`, with no transport.
- Polling stop controls (de-delegation, cancellation, incompatible state)
  honoured at explicit safe interruption boundaries. This is the half that
  works today with no entitlement.

The mutation shapes in `linear-client.mjs` remain **unverified against a live
session**. `MOV-166` owns live enablement and validation, and is the issue that
would first exercise them for real. See
`docs/operators/local-execution.md` §Reporting back to Linear and §Stop controls.

## Sources and reproducibility

Official product documentation, retrieved 2026-09-10:

- [AI credits](https://linear.app/docs/ai-credits)
- [Coding Sessions](https://linear.app/docs/coding-sessions)
- [Loops](https://linear.app/docs/loops)
- [Pricing](https://linear.app/pricing)
- [AI Agents](https://linear.app/docs/agents-in-linear)
- [Developing the Agent Interaction](https://linear.app/developers/agent-interaction)
- [Agent interaction best practices](https://linear.app/developers/agent-best-practices)
- [Agent signals](https://linear.app/developers/agent-signals)

Workspace-specific evidence is retained on `MOV-141` and the canceled
disposable fixture `MOV-165` / GitHub `#355`. The probe did not create a code
branch. It queried subscription and feature state, delegated and labeled the
fixture, read it through the production dispatcher client, attempted one
custom Agent Session creation, recorded the rejection, and canceled the
fixture.
