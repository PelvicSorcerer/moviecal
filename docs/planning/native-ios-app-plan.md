# Native iOS app — Phase 0 plan and decisions

Status: forward-looking planning artifact. Establishes the strategy, locked
decisions, phase breakdown, backend API gap analysis, and governance proposal
for shipping a native iOS app to the App Store.

## How to use this document (important)

- This file is a strategy and decision artifact. It is **not** the active
  implementation queue and must not override live GitHub Project or issue state.
- Agents continue to start from the single open issue whose `moviecal Delivery`
  project item has `Agent Dispatch = Yes` and `Status = Ready` (dispatch-slot
  work) or from a direct assignment.
- When this plan conflicts with active queue scope, the GitHub Project and issue
  state win.
- Governance and testing policy for the iOS track is now ratified through issue
  #236 and the operator docs it updates. This plan should stay aligned with
  `docs/operators/multi-platform-dispatch-policy.md`,
  `docs/operators/branch-and-ci-conventions.md`, and
  `docs/planning/testing-lanes.md`.

## Goal

Ship a **true native iOS app** to the App Store whose implemented features behave
according to Apple's Human Interface Guidelines, comparable to first-party Apple
apps. Android is a desired future target but must not dilute iOS quality; it is
planned as a later, independent client, not a shared-codebase compromise.

## Why the current architecture already supports this

The backend refactor deliberately prepared for a native client. The app is a
client over an API that already exists — not a rewrite:

- **Versioned bearer-token API surface** (`docs/api/v1-contract.md`, issue #211):
  `Authorization: Bearer <JWT>` only, no cookies, RLS-aware, no service-role
  exposure. Auth plumbing already exists (`src/lib/auth/bearer.ts`,
  `src/lib/auth/identity.ts`).
- **Target-state mobile slice map** (`docs/planning/target-state-mobile-backend-slice-map.md`)
  already decomposed the backend for a mobile-first direction.
- **Auth and security model** (`docs/technical/auth-and-security.md`) already
  contemplates web + mobile clients sharing one identity boundary.
- **The product is a token-based `.ics` subscription feed**
  (`docs/technical/calendar-feed-design.md`), which iOS Calendar consumes
  natively. The core feature does not need to be reinvented in Swift.

**Reused:** Supabase schema + RLS, all domain logic in `src/lib/**`, the `/api/v1`
surface, calendar feed generation, release-refresh cron, the test/CI/governance
apparatus. **Replaced/new:** the presentation layer only (SwiftUI), plus a native
networking + auth client. The web front-end continues to exist; the standing cost
is a second (later third) presentation surface over one shared contract.

## Locked decisions

| ID | Decision | Choice | Rationale |
|----|----------|--------|-----------|
| D1 | Repo layout | **Monorepo** — `ios/` alongside `src/`, `android/` later | The `/api/v1` contract is the coupling point; co-location lets a contract change and its consumer land in one PR. Preserves the existing delivery-project governance. |
| D2 | Minimum iOS deployment target | **iOS 18 (current − 1 major)** | Newest SwiftUI / App Intents / widget APIs for first-party feel; still covers the large majority of active devices. Revisit at build time against current adoption. |
| D3 | Calendar integration | **Hybrid, sequenced: subscribed `.ics` feed in App Store v1; EventKit as a fast follow** | Subscribed feed is the most resilient path (survives app deletion, iOS-managed refresh, auto-reflects cron release-date changes, no event-writing code) and reuses 100% of existing feed work. EventKit adds features (per-event alerts, custom calendar, offline, immediate updates) but is less resilient on its own. Hybrid maximizes both; sequencing keeps the first submission small. |
| D4 | App authentication | **Email/password now (existing Supabase auth); Sign in with Apple before App Store launch** | Reuses existing Supabase email/password immediately. The client obtains the Supabase JWT via `supabase-swift` and passes it as the `v1` bearer token — no new backend auth endpoint. SIWA is added before launch to satisfy App Review expectations and first-party feel. |
| D5 | iOS build/test CI | **Self-hosted GitHub Actions runner on the user's Mac** for the iOS verification lane | Runs iOS build + XCTest + XCUITest as a native GitHub Actions workflow, so iOS results appear as normal PR status checks alongside the Linux lanes and are covered by the existing `check:branch-ci` drift mechanism — one unified CI and governance model, which resolves the "integrate GitHub Actions and Xcode Cloud" goal in Actions' favor. Trade-offs: the Mac must be online to service the queue, and self-hosted runners require hardening against untrusted fork-PR code (see security note). Release signing / TestFlight upload is a separate Phase 5 concern (fastlane or Xcode Cloud), independent of this CI choice. |
| D6 | First App Store version scope | **Personal-watchlist parity** (search, add/remove, calendar subscribe for the personal list) | Smallest `v1` gap, fastest to TestFlight. Shared watchlists are a fast follow, not part of v1. |

## Human-only prerequisites (start now — they have lead time)

These block only the final TestFlight/submission steps, but have external lead
time, so begin them in parallel with backend work:

1. **Apple Developer Program enrollment** ($99/yr) — enrollment + identity
   verification can take days.
2. **Reserve the bundle ID / App ID** and create the App Store Connect record
   once enrolled.
3. A **Mac with Xcode** is required for local builds and to host the self-hosted
   GitHub Actions CI runner (D5).

## Phase breakdown

| Phase | Name | Who | Governance |
|-------|------|-----|------------|
| 0 | Foundations | Human (Apple enrollment) + agent (this doc) | This planning PR + human account setup |
| 1 | Close the API gap | Agent-driven | **Existing dispatch-eligible domain-track governance, full `npm run verify` coverage** |
| 2 | iOS skeleton | Any agent platform or human; merge readiness Mac-gated | iOS track (main-queue eligible; self-hosted macOS runner gate) |
| 3 | Feature-parity MVP | Same as Phase 2 | Same |
| 4 | First-party polish (HIG) | Same as Phase 2 | Same |
| 5 | Release engineering | Human-led (TestFlight, App Review) + agent support | Same |

- **Phase 1** is the bridge: it is ordinary backend work your agents execute
  under existing governance while Apple enrollment processes.
- **Phase 3** ships the subscribed-feed calendar (D3); EventKit lands after v1.
- **Phase 4** is where "behaves like an Apple app" is earned: Dynamic Type, dark
  mode, VoiceOver/accessibility, Sign in with Apple (D4), App Intents/Shortcuts,
  widgets, haptics, and proper empty/error/loading states. Budget real time here.

## Phase 1 — backend API gap analysis (verified against current `v1`)

Capabilities the personal-parity iOS MVP (D6) needs from the backend, checked
against the code as of this document:

| Capability | Web today | `v1` today | Gap | Proposed |
|------------|-----------|-----------|-----|----------|
| Obtain auth token (JWT) | Supabase cookie session | n/a (bearer accepted) | **None** — client gets JWT from Supabase Auth via `supabase-swift`, passes as bearer | Confirm Supabase auth settings allow the native client |
| List personal watchlist | cookie route | `GET /api/v1/watchlist` | **None** | — |
| Add movie | cookie route | `POST /api/v1/watchlist` | **None** | — |
| Remove movie | cookie route | `DELETE /api/v1/watchlist` | **None** | — |
| Movie search | `GET /api/movies/search` (**unversioned, unauthenticated public GET**) | not present | **Yes** | Add `GET /api/v1/movies/search` (bearer-auth) for consistency, auth, and future rate-limiting; or formally bless the public route for the app |
| Movie details (detail screen) | fetched server-side inside add flow | not present | **Maybe** | Add `GET /api/v1/movies/{tmdbId}` only if the detail screen needs richer data than the search payload provides; otherwise defer |
| Get calendar subscription URL | cookie settings page only | not present | **Yes (required for D3)** | Add `GET /api/v1/calendar-token` returning the user's subscription URL (create-on-demand) |
| Rotate calendar token | cookie settings page only | not present | **Yes** | Add `POST /api/v1/calendar-token`; rotation invalidates the previous URL (breaks the old subscription — surface this in the app UX) |

**Phase 1 backend backlog (dispatch-eligible domain-track issues, agent-executable):**

1. `v1` movie search endpoint (or a documented decision to reuse the public route).
2. `v1` calendar-token retrieval endpoint. **Required for the calendar feature.**
3. `v1` calendar-token rotation endpoint.
4. *(Optional/deferrable)* `v1` movie-details endpoint.

Each must carry the standard issue contract: acceptance criteria, verification
steps, **Testing Expectations**, security notes (bearer-only, RLS boundary, no
service-role exposure, no token logging), and a **Test Impact** section on the PR.
All are additive under the `v1` stability boundary — breaking shape changes would
require a `v2` prefix.

## Governance and testing

The repo now treats iOS as a first-class delivery track with a dedicated
self-hosted macOS runner lane and a repo-wide dependency-field contract.

### New track: iOS (Mac-gated, main-queue eligible)

- **Phase 1 backend work stays on the existing dispatch-eligible domain tracks** — no change to the Codex handshake model there; fully
  dispatch-eligible and agent-verifiable.
- **Swift/iOS work (Phases 2–5) belongs on the `iOS` track and is main-queue
  eligible.**
- The binding constraint is the **verification environment**, not who writes
  Swift. Any agent platform or human may implement a promoted iOS issue.
- Merge readiness is gated by the self-hosted macOS runner lane.
- The orchestrator must check runner availability both when promoting an iOS
  issue and immediately before work starts.
- If the runner is unavailable at start-time, the orchestrator removes
  `Agent Dispatch = Yes`, keeps `Status = Ready`, and skips forward through the
  queue to the next eligible issue.

### CI and testing lanes

- **Path-filter the existing Linux lanes** so `ios/**`-only changes do not
  trigger Node lanes, and Node/`src/**` changes do not trigger the iOS lane.
- **Author an iOS testing-lane definition** — an analogue to
  `docs/planning/testing-lanes.md` covering XCTest (unit), XCUITest (UI), and
  snapshot tests, running on the Mac CI gate. The current lanes
  (vitest/playwright) cannot execute Swift; "full real testing coverage" for iOS
  means defining a parallel Mac lane, not extending the Node lanes.
- **Mac CI gate — chosen: self-hosted GitHub Actions runner on the user's Mac**
  (D5). It runs the iOS lane as a native GitHub Actions workflow (free compute on
  owned hardware, native PR checks) and unifies "GitHub Actions" and "Mac" in one
  system. Trade-off: the Mac must be online to service the queue. Alternatives if
  that proves limiting: **GitHub-hosted macOS runners** (managed, billed per
  minute) or **Xcode Cloud** (managed, tightest TestFlight integration but a
  separate external check provider). A locally-run Mac agent (Claude Code/Codex
  CLI on the Mac) complements the gate as the interactive dev/verify loop but is
  not a substitute for it.
- **The iOS lane runs inside GitHub Actions** (self-hosted macOS runner), so it
  integrates with the existing check infrastructure rather than sitting outside
  it: register the iOS workflow's branch triggers in the workflow's `branches:`
  filter and add the workflow to `docs/operators/branch-prefixes.json`'s
  `pathRestrictedPushWorkflows` array so `check:branch-ci` guards it like the
  other lanes. This closes the "integrate GitHub Actions and Xcode Cloud"
  question — there is no separate external check provider to reconcile.

## Open investigation items

1. **Self-hosted macOS runner setup and security (D5):** register the runner and
   scope it to this repo. **Critical security note:** self-hosted runners must
   not execute untrusted fork-PR code — a malicious fork PR could otherwise run
   arbitrary code on your Mac. If the repo is public, require manual approval for
   fork-PR workflow runs (GitHub's default for first-time contributors) and/or
   gate the iOS workflow so it runs only on trusted in-repo branches, not
   `pull_request` from forks. Confirm the iOS workflow is added to the
   `check:branch-ci` path-restricted-push list so the drift checker covers it.
2. **Calendar UX on token rotation:** rotating the calendar token breaks an
   existing iOS subscription; design the re-subscribe flow (D3).
3. **`supabase-swift` auth ↔ `v1` bearer:** confirm the token lifetime/refresh
   behavior end-to-end, given `v1` never silently refreshes (`docs/api/v1-contract.md`).
4. **Sign in with Apple provisioning:** Supabase Apple provider + entitlement
   setup, sequenced before launch (D4).
5. **Movie-details endpoint necessity:** decide whether the detail screen needs
   more than the search payload before building endpoint #4.

## Next actions

1. Keep the operator docs and queue tooling aligned with the ratified iOS policy.
2. Land the Phase 2 iOS issues in sequence: `#237`, `#238`, `#239`, `#240`.
3. Complete the queue-tooling follow-up in `#241` so the repo scripts enforce the new `Dependencies` and iOS-runner rules automatically.
