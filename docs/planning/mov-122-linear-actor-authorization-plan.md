# MOV-122 — Linear Actor Authorization: planning artifact

Status: forward-looking planning artifact for [`MOV-122`](https://linear.app/moviecal/issue/MOV-122)
("Linear Actor Authorization: give the dispatcher its own identity so notifications
actually fire"). Establishes the research findings, the auth-mechanism decision, and
the sub-issue / milestone breakdown the repo owner asked for before implementation
starts.

## How to use this document

- This file is a research + decision artifact. It is **not** the active work queue.
  Linear is authoritative for work-item state; the sub-issues below are the unit of
  execution, sequenced under a Linear project milestone.
- `MOV-122` itself stays `human-only` and is the tracking/umbrella issue. It is
  closed only when the live verification step (last sub-issue) passes.
- The one-time OAuth app registration and workspace install are **human-only** and
  **add a new secret** — both hard "requires a human" gates in
  `docs/operators/local-execution.md` §Security model. No worker can do them.

## Problem recap

Every dispatcher and assistant-session mutation against Linear currently authenticates
with the repo owner's **personal API key** (`~/.config/moviecal/linear.env`). Linear
suppresses notifications for your own activity and cannot tell "the human typed this"
from "an agent used the human's key." Result: the repo owner receives **zero**
notifications for issue/comment/state-change activity that an agent drives — mobile
push and Slack settings are irrelevant because the underlying event never fires.

The fix the repo owner chose: give the dispatcher its **own distinct workspace
identity** via Linear's Actor Authorization (`actor=app`), so its mutations register
as "someone else" and the repo owner's existing "notify me about this issue"
preferences fire normally.

This is the same shape as the GitHub self-review problem `MOV-116` originally set out
to solve: an actor operating under your own identity is invisible to any system built
around "don't notify you about yourself."

## Research findings (Linear Actor Authorization)

Sources: `linear.app/developers/agents`, `linear.app/developers/oauth-2-0-authentication`
(fetched 2026-09-08).

### `actor=app` OAuth

- The dispatcher's integration is registered as a standard **OAuth application** in
  Linear (Settings → API → Applications). Adding `actor=app` to the OAuth flow makes
  resources it creates owned by **the application**, not the installing user. This
  parameter supersedes the older `actor=application` and covers all agent / app /
  service-account use-cases.
- Installing at **workspace scope requires workspace-admin approval** to complete.
- The app gets a **unique identity ID per workspace installation** — fetch it via
  GraphQL once and store it alongside the token, so the dispatcher can positively
  identify "its own" activity later.
- Scope string (confirmed live 2026-09-08): **`read,write,app:assignable,app:mentionable`**.
  `read` + `write` are the actual data-access scopes and are required — an app-actor
  token with only `app:assignable`/`app:mentionable` is rejected with
  `Invalid scope: 'read' required` on the first query. `app:assignable` (can be
  assigned issues / added to projects) and `app:mentionable` (can be @-mentioned) are
  agent-capability flags, not data permissions. **`admin` cannot be combined with
  `actor=app`** and the dispatcher does not need it — it only comments and moves
  issues between states. Changing the scope set revokes and replaces any existing
  app tokens.
- **Billing:** "Agents installed in your workspace do not count as billable users."
  So this does not consume a seat against the Linear Free plan's limits.

### Two ways to obtain the token

Both paths end with the dispatcher holding a token that acts as the **app's own
identity** (`actor=app`). They differ only in *how the token is obtained*:

| | **Authorization-code flow** (`actor=app`) | **Client Credentials grant** (`actor=app`) |
|---|---|---|
| Browser / consent step | Yes — a workspace admin visits an authorization URL, approves a consent screen, Linear redirects back with a `code` | **None** — the dispatcher POSTs client ID + secret straight to the token endpoint |
| Redirect URI / callback server | Required (or manual copy-paste of the `code`) | Not required |
| Token returned | Access token **+ refresh token**, long-lived via refresh | Access token only, **valid 30 days, no refresh** |
| Renewal model | Store refresh token, rotate it, handle refresh failures | Re-request a fresh token on `401` (or at the start of each run) — Linear's explicit guidance for CI/automation |
| Parallel tokens | n/a | Up to 1000 concurrent, provided scopes match |
| Secret rotation | Refresh tokens survive until revoked | Rotating the client secret invalidates all client-credentials tokens immediately |
| Best fit | A product where a specific user consents once and you want durable delegated access | **A headless daemon with no interactive user** |

Either way the OAuth **app must be created once by a workspace admin** — that step is
`human-only` and produces the client secret. Confirmed 2026-09-08: with Client
Credentials there is **no additional browser-based install/authorize step** — the app
authenticates directly in the workspace that owns it. Client Credentials is about how
the *running* dispatcher authenticates day to day, not a way to skip the one-time
human app creation.

## Decision: use the Client Credentials grant

**Chosen: Client Credentials grant with `actor=app`.**

Rationale:

- The dispatcher is a **headless `launchd` daemon** with no user in the loop. The
  authorization-code flow's browser consent step is pure friction for a process that
  never has a browser.
- **No refresh-token machinery.** A 30-day token that you re-fetch on `401` is fewer
  moving parts than storing, rotating, and error-handling a refresh token. Self-heals
  on secret rotation and on expiry with the same code path.
- It is the mainstream **machine-to-machine / service-account** pattern (OAuth 2.0
  client credentials), and it is the exact shape Linear documents for
  CI/automation: "request a new client credentials token at the start of each run."
- Interactive assistant sessions keep using the personal API key — see
  "Scope: dispatcher only" below.

## Scope: dispatcher only, not interactive assistant sessions

Interactive Claude Code / Codex sessions also mutate Linear under the personal key
today, so the repo owner gets no notification for their activity either. This is
**deliberately left as-is**, not folded into `MOV-122`:

- Those sessions are **attended** — the human is present as the change is made. A
  push notification for something you are actively doing at your desk is noise,
  which is exactly what self-notification suppression exists to prevent.
- The dispatcher is the real case: unattended, so "someone else did this while you
  weren't looking" is genuinely true and the notification is genuinely useful.
- Attributing a real-time, human-directed session's mutations to a bot identity
  muddies the workspace activity feed ("did I do this, or an agent on my behalf?").
- There is no shared long-lived Linear client for ad-hoc sessions — each would need
  its own token acquisition, more plumbing for little gain.

Revisit only if attended-session blindness turns out to matter in practice (e.g. the
repo owner routinely starts a session and walks away) — then as its own small issue,
reusing the credential this milestone provisions.

## Relationship to the `launchd` service (MOV-120)

Question raised by the repo owner: *does the `launchd` service represent the
dispatcher/operational loop, and should this all just be part of it?*

**Yes, the `launchd` service is the operational loop.** MOV-120's plist
(`~/Library/LaunchAgents/com.moviecal.dispatcher.plist`) runs `dispatcher run` — the
continuous poll loop — as a persistent daemon out of the dedicated
`~/code/worktrees/moviecal/dispatcher-daemon` worktree.

**The actor-auth token handling belongs *inside the dispatcher process*, not as a
separate service or scheduled job:**

- Token acquisition is **lazy**: on process start the Linear client fetches a
  client-credentials token; it holds it in memory for the life of the process and
  **re-fetches on any `401`**. A long-running daemon simply refreshes in place when
  its token ages out — no pre-emptive timer needed.
- **Do not** add a second `launchd` job or a cron entry to "refresh the token every
  N days." That reintroduces stateful coordination between two processes sharing a
  token file — the exact anti-pattern modern M2M auth avoids. Lazy fetch + `401`
  retry is simpler and self-healing.
- The only persistent state is the **client ID + client secret**, read from a
  `600`-mode env file at process start — structurally identical to how
  `linear.env` is consumed today.

So: nothing new runs alongside the daemon. The daemon *is* the loop, and the Linear
client it already constructs gains a token-acquire/refresh-on-401 wrapper. This
matches how the rest of the industry is handling headless service auth right now
(client-credentials M2M, fetch-on-demand, retry-on-401 — no ambient refresh
scheduler).

## Sub-issue breakdown

Sequenced under the Linear **project milestone** `Linear actor authorization` in the
**Developer Governance & Agent Infrastructure** project (project milestones are
"used only where real sequencing exists" per
`docs/governance/linear-information-architecture.md` — this chain qualifies).

Each sub-issue is `blocked by` the one before it, and all are `related to` `MOV-122`.
Created 2026-09-08 as [`MOV-123`](https://linear.app/moviecal/issue/MOV-123) →
[`MOV-127`](https://linear.app/moviecal/issue/MOV-127), all in `Backlog`.

### 1. `MOV-123` — Register the Linear OAuth app (`human-only`) — **DONE 2026-09-08**

- Create an OAuth application in the `moviecal` workspace (Settings → API →
  Applications), name `moviecal-dispatcher`. Only toggle turned **on** is
  **Client credentials**; **Webhooks off** (the dispatcher polls, has no public URL,
  and the repo-owner notifications this milestone targets are Linear-side actor
  behaviour, not webhook-driven). Public **off**. Redirect URI `http://localhost`
  (unused by `client_credentials` but the form wants one). GitHub username left
  blank.
- No separate browser "install" step: `client_credentials` works directly in the
  workspace that owns the app.
- Mint a token with `grant_type=client_credentials`, `actor=app`,
  `scope=read,write,app:assignable,app:mentionable` (see scope note above — `read`
  and `write` are mandatory).
- Recorded and handed to `MOV-124`: **client ID**, **client secret**, **app actor
  identity ID** (from a `viewer` query with the app token).
- Verified: `viewer` returns `moviecal-dispatcher`, not a person; app is not a
  billable member.

### 2. `MOV-124` — Provision the dispatcher credential

- New file `~/.config/moviecal/linear-app.env` (mode `600`), holding
  `LINEAR_APP_CLIENT_ID`, `LINEAR_APP_CLIENT_SECRET`, `LINEAR_APP_ACTOR_ID` (the
  identity ID from sub-issue 1), and `LINEAR_APP_SCOPES`
  (`read,write,app:assignable,app:mentionable`). Keep it alongside, not replacing,
  `linear.env` during the transition.
- Add the new credential to `docs/operators/local-execution.md` §Security model
  credentials table.
- Add `dispatcher doctor` assertions: `linear-app.env` exists, is mode `600`, and a
  client-credentials token can be minted from it.
- Acceptance: `dispatcher doctor` passes with the new checks; no secret value is
  printed to logs.

### 3. `MOV-125` — Add client-credentials auth to `linear-client.mjs`

- New small module (e.g. `linear-app-auth.mjs`): `getAppToken({ clientId,
  clientSecret, scopes })` → POSTs to `https://api.linear.app/oauth/token` with
  `grant_type=client_credentials` + `actor=app`, returns `{ token, expiresAt }`. No
  refresh token stored. Default `scopes` = `read,write,app:assignable,app:mentionable`.
- `LinearClient` gains an auth mode: given app credentials, it acquires a token
  lazily on first `request()`, caches it, and **on any `401` re-acquires once and
  retries** the request. Given only a personal `apiKey` (current behaviour) it works
  exactly as today — this is an additive branch, gated by which credential is
  present, so the transition is reversible via env toggle.
- `bin/dispatcher.mjs` / `src/config.mjs` prefer `linear-app.env` when present, fall
  back to `linear.env`.
- Testing Expectations: **unit** — token acquired on first request, cached on
  subsequent requests, re-acquired exactly once on a `401` then request retried,
  personal-key path unchanged (mock `fetchImpl`, no network). No integration/browser
  layer (the dispatcher has no HTTP surface and no browser).
- Acceptance: `npm run lane:unit` green; `dispatcher run --once` against the live
  workspace with zero eligible issues completes the safe no-op path authenticating
  as the app.

### 4. `MOV-126` — Cut dispatcher mutations over to the app identity

- With sub-issue 3 in place, point the dispatcher's real run path at
  `linear-app.env`. Confirm `commentCreate` and `issueUpdate` (state moves) succeed
  as the app actor.
- Keep the personal-key fallback documented for one release as a rollback path;
  remove it in a follow-up once the app path has real mileage.
- Acceptance: a dispatcher-driven comment and a state change on a scratch issue both
  show the **app** as the actor in Linear's activity feed, not the repo owner.

### 5. `MOV-127` — Live verification, the actual acceptance test for MOV-122 (`human-only`)

- Repo owner ensures they have a "notify me" subscription on a scratch issue.
- Trigger a dispatcher-driven comment + state change on that issue.
- Confirm the repo owner **receives a Linear notification** (in-app, and whichever of
  mobile push / Slack they have enabled).
- On success: close `MOV-122`; update `docs/planning/decision-log.md` (remove the
  "new open item" note, record the outcome) and
  `docs/operators/local-execution.md` §Security model.

## Resolved decisions (repo owner, 2026-09-08)

1. **Agent workspace display name: `moviecal-dispatcher`.**
2. **Scope stays dispatcher-only** — interactive assistant sessions keep the personal
   API key (rationale under "Scope: dispatcher only" above).
3. **Milestone name: `Linear actor authorization`** under Developer Governance &
   Agent Infrastructure — kept as created.

## References

- `docs/operators/local-execution.md` §Security model, §Persistent service (launchd)
- `docs/governance/linear-information-architecture.md` §Project milestones,
  §Workflow states
- `docs/planning/decision-log.md` — "New open item, found 2026-09-08"
- `linear.app/developers/agents`, `linear.app/developers/oauth-2-0-authentication`
