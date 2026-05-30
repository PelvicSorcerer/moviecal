# Documentation audit

Date: 2026-05-30
Scope: README, Copilot instructions, product/design/technical/planning docs listed in the planning prompt.

## Strong docs (ready for implementation)

- `README.md`: clear project summary, status, stack, and public-repo security reminder.
- `.github/copilot-instructions.md`: strong agent constraints (security, stable calendar UIDs, RLS, no secrets, small PRs).
- Product docs (`docs/product/*`): consistent MVP narrative and user stories for sign-in, search, watchlist, and private calendar subscription.
- Core technical docs (`docs/technical/architecture.md`, `api-design.md`, `auth-and-security.md`, `tech-stack.md`): clear stack and security boundaries.

## Missing or unclear areas found

- Backlog format was too terse for autonomous agent work. Items needed explicit goal/requirements/out-of-scope/acceptance/verification sections.
- No single phase-by-phase implementation guide existed for future Copilot agents.
- Calendar UID strategy in `docs/technical/calendar-feed-design.md` used token-derived UID example, which could cause avoidable event churn after token rotation.
- Requirement that unknown release dates are explicitly skipped for MVP was implicit in several places but not called out as a dedicated MVP calendar rule.

## Contradictions found

- No major product contradictions.
- Minor design tension: token-rotatable feed URL vs token-based UID example. Resolved by documenting a stable UID strategy independent of token value.

## Key assumptions

- One calendar token maps to exactly one user and is treated as a secret bearer credential.
- Supabase is the source of truth for auth identity and RLS enforcement.
- Feed endpoint is public-by-token (no interactive auth), returning `404` for invalid tokens.
- MVP excludes movies without known release dates from calendar events.

## Risks for Copilot agents

- Accidentally exposing secrets in a public repo (`.env`, service role keys, TMDb key).
- Implementing feed auth incorrectly (session-based auth instead of token-based public endpoint).
- Returning non-deterministic or unstable UIDs causing duplicate events in calendar clients.
- Creating oversized PRs that combine multiple backlog items and become hard to review.

## Recommended improvements

1. Keep backlog tasks issue-sized and agent-ready with explicit acceptance criteria and verification commands.
2. Follow implementation by phase, with dependency ordering, to reduce rework.
3. Keep calendar UID generation stable per user+movie identity, not per token instance.
4. Preserve strict security posture in all future tasks (RLS, no secrets in repo, server-only privileged keys).
