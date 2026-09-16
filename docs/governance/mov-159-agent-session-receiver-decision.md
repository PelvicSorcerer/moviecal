# MOV-159: Agent Session receiver — architecture decision

**Decided 2026-09-16.** This record closes the human decision gate created by
`MOV-158` and authorizes `MOV-166`.

No infrastructure, plan change, secret, or paid credit was created by this
decision itself. It authorizes `MOV-166` to create them under the boundary
below; nothing is enabled until that issue runs.

## Decision

**Approve a hosted signed-webhook receiver with outbound event delivery to the
Mac.** `MOV-166` is refined and authorized, not canceled.

The approved architecture, stated once so `MOV-166` has an unambiguous
boundary:

| Element | Decision |
|---|---|
| Receiver host | A serverless function on the project's **existing Vercel account**. No new vendor, no new bill, no new account to secure. |
| Inbound authentication | Linear `linear-signature` HMAC verified **before** a payload is parsed for meaning. Fail closed when no secret is configured. |
| Delivery to the Mac | The Mac opens an **outbound** authenticated stream (SSE) to the receiver and holds it. The Mac accepts no inbound connection and opens no port. |
| Authority | The receiver is **presentation and latency only**. Linear issue state plus GitHub PR/branch state remain the sole durable identity. |
| Retention | Events are held only until acknowledged, with a hard ceiling of **10 minutes**. No event archive, no log of issue content. |
| Deduplication | By Linear delivery id, with the existing idempotency behavior in `agent-signals.mjs`. |
| Fallback | 30-second polling remains permanently active, not a degraded mode. |
| Disablement | One capability flag. The dispatcher already latches capability detection per process. |

## Why this reverses the narrower reading

`MOV-141` (2026-09-10) recorded the workspace on **Basic**, which made Loops
unavailable and weakened the case for any hosted component. **That plan finding
is stale as of 2026-09-16:** the repo owner confirms Linear is paid for and
Loops are available. The entitlement table in
`docs/governance/mov-141-linear-capability-findings.md` is preserved as the
record of what was true on its validation date and annotated there rather than
rewritten.

Two things that did **not** change with the plan, and that matter more than the
plan did:

- **A plan upgrade does not enable Agent Sessions.** `MOV-141`'s blocker was
  app configuration, not entitlement: the OAuth app must subscribe to Agent
  Session events *and* supply a reachable HTTPS receiver. The receiver gate is
  identical before and after the upgrade.
- **`agentSessionCreateOnIssue` has still never succeeded.** The mutation
  shapes in `linear-client.mjs` remain unverified against a live session. This
  is the single largest residual risk and is bounded deliberately — see
  *Residual risk* below.

## Options considered

### 1. Polling-only (rejected)

Keep `MOV-158`'s comment/state lifecycle as the entire surface and cancel
`MOV-166`.

This is the correct answer under a minimal-surface preference, and it was the
initial recommendation. It is rejected here because the repo owner's stated
standard is the **most feature-rich solution that does not significantly
degrade performance**, and is explicitly willing to absorb up-front development
cost. Polling-only forfeits the one capability polling structurally cannot
provide, for a saving this project does not need.

What polling-only genuinely costs, stated honestly and narrowly:

| Agent Session capability | Real incremental value over `MOV-158` |
|---|---|
| Follow-up **prompts** mid-run | **Genuine.** Polling cannot receive a prompt at all. Today's substitute is stop → edit the issue → re-dispatch, which discards in-flight work. |
| **Stop** signal latency | Marginal. 30s → sub-second. Real but small at this scale. |
| Semantic **activities** | Cosmetic. Comments already carry the same lifecycle, serialized from the same source. |
| **PR external link** | Already covered. The PR is on the issue as an attachment and in a comment. |
| **Stale recovery** / new linked attempts | Self-referential. Only meaningful once sessions exist. |

One capability is genuinely new. Under a minimal-surface preference that does
not clear the bar; under the stated preference it does.

### 2. Narrowly scoped MCP enqueue/handoff (rejected as insufficient alone)

`MOV-141` could not evaluate this properly, because Loops were unavailable and
a Loop is the main thing that would call an MCP connector. With Loops now
live, the option is real and was re-examined.

It is rejected as a *replacement* for the receiver, on two grounds:

- **It does not carry the capability that justified the work.** An MCP enqueue
  hands work *to* the Mac. It does not deliver Agent Session `prompted` or
  `stop` events, because those are Linear-emitted session events, not
  connector calls. Choosing MCP alone keeps mid-run steering unavailable.
- **`MOV-165` already proved the handoff it would replace.** A Loop can leave
  an issue with `execution:mac` plus the `moviecal-dispatcher` delegate, and
  the existing outbound poller reads both fields correctly. The incremental
  gain over a proven, zero-surface path is latency on *dispatch*, which is the
  least latency-sensitive moment in the lifecycle.

This is a rejection of MCP as *this* decision's answer, not a rejection of MCP
permanently. Once a receiver exists, a Loop-facing MCP enqueue becomes a small
additive follow-up rather than an architecture, and should be filed as its own
issue if Loop-driven intake is later wanted.

### 3. Signed webhook relay with outbound delivery (**selected**)

The load-bearing design choice inside this option, and the reason it is
specified rather than left to `MOV-166`:

> **A queue-and-poll relay buys nothing.** If the receiver stores events and
> the Mac polls *the receiver*, the result is polling with an additional trust
> boundary, an additional secret, and an additional outage mode — for zero
> latency improvement over polling Linear directly. Only an outbound stream
> held open by the Mac converts the receiver into an actual capability.

The Mac initiating the connection is what keeps the "no public inbound
listener" constraint intact while still getting push latency. This is not a
compromise position; it is the only shape in which the receiver is worth
building.

## Security, cost, and operational implications

**Authentication.** Two independent boundaries. Linear → receiver is HMAC over
the raw body using the `linear-signature` header, verified before semantic
parsing, rejecting deliveries older than the existing `WEBHOOK_MAX_AGE_MS`
(60s) as replays. Receiver → Mac is a separate bearer credential on the
outbound stream; the Mac authenticates *to* the receiver, so a receiver
compromise cannot originate a connection to the Mac.

**Attack surface added.** One public HTTPS endpoint that accepts only
signature-valid Linear payloads and, on success, enqueues an opaque
already-normalized signal. It performs no repository access, holds no GitHub
credential, and cannot cause a mutation on its own — every consequential action
still runs on the Mac, behind `StopController`'s existing safe interruption
boundaries.

**Blast radius of full receiver compromise.** Bounded by design, and this is
the property `MOV-166` must preserve above all others: an attacker who fully
controls the receiver can deliver forged `prompted`/`stop` signals to the Mac.
`stop` is fail-safe. `prompted` is not, so prompt content must remain
**untrusted input** — it may steer a worker, it may never widen the worker's
authorization, bypass `security-policy.mjs`, or alter the dispatch boundary.
`agent-signals.mjs` already models prompt trust; `MOV-166` must not relax it.

**Secrets.** Two new dev-only values: the Linear webhook signing secret and the
Mac's stream credential. Both live beside the existing app credential at
`~/.config/moviecal/` (mode 600) and in Vercel's environment settings. Neither
is a production or personal credential. Rotation is independent for each.

**Retention and privacy.** Issue text transits the receiver. It is held only to
the acknowledgement or the 10-minute ceiling, whichever is first, and is never
written to durable storage or logs. The repo is public; issue content is not
especially sensitive; this is a bound, not a claim of confidentiality.

**Cost.** Effectively zero in dollars — the existing Vercel account, well
inside Hobby limits at this volume, with no AI-credit dependency (credits are a
Loops/Coding-Session concern, not an Agent Session one). The real cost is
maintenance: one more deployable component, two more secrets to rotate, one
more outage mode to recognize.

**Outage behavior.** Receiver down, stream dropped, Vercel deploy failed, or
Linear delivery lost all resolve identically: no signal arrives, and 30-second
polling continues to carry the complete lifecycle. The Mac reconnects with
backoff and does not block dispatch while disconnected. There is no state the
receiver holds that the Mac needs in order to make progress.

**Disablement and rollback.** Turning the capability flag off returns the
system to exactly today's behavior. Full rollback is deleting the Vercel
function and removing the Agent Session event subscription from the OAuth app;
no dispatcher code needs to be reverted, because sessions are already an
enrichment layer rather than a dependency.

## Residual risk

The Agent Session mutation shapes have never succeeded live. `MOV-166` is the
first thing that will exercise them for real, and it may find the documented
Developer Preview shapes wrong.

This is accepted because it is already contained: every session call in
`agent-session.mjs` is non-fatal, the PR link is published on two independent
paths so one wrong field name degrades rather than loses it, and the comment
surface is unconditionally complete. A failed live validation costs
`MOV-166`'s implementation time, not correctness — the system it falls back to
is the system running today.

Because it is Developer Preview, Agent Sessions must remain off the critical
path permanently, not merely until validated.

## Authorized boundary for MOV-166

`MOV-166` is authorized to proceed, limited to:

- Deploy the receiver described above to the existing Vercel account.
- Subscribe the `moviecal-dispatcher` OAuth app to Agent Session events.
- Create the two dev-only secrets named above.
- Implement the Mac's outbound stream client and connect it to
  `agent-signals.mjs`'s existing normalization — **not** a reimplementation of
  it.
- Run disposable live Agent Session validation, explicitly authorized here.

It is **not** authorized to: expose any inbound listener on the Mac, make the
receiver authoritative for any lifecycle state, weaken polling recovery, relax
prompt trust, purchase AI credits, or use production data or a long-lived
personal credential.

Cancel-and-stop condition: if live validation shows Agent Sessions cannot be
enabled for this app even with a conforming receiver, `MOV-166` stops, records
the finding, and the receiver is torn down rather than left running for a
capability that does not exist.
