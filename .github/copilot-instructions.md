Copilot instructions for moviecal

- Public repository: do not commit secrets, credentials, private URLs, API keys, tokens, personal data, or real user data.
- Project summary: moviecal is a movie watchlist web app with a private iOS Calendar-compatible iCalendar feed that stays updated as movie release dates change.
- Keep changes small and focused; prefer simple, boring, conventional architecture.
- Use TypeScript strictly (enable `strict`). Favor clear types and runtime checks for critical paths.
- Write tests for meaningful behaviour; provide reproducible steps for failing tests.
- Calendar feed URLs must use unguessable tokens. Do not expose tokens in logs or public UIs.
- Calendar events must use stable, deterministic UIDs so an event persists across updates.
- Never expose one user's watchlist or calendar feed to another user.
- Do not hardcode TMDb keys, Supabase keys, auth secrets, calendar secrets, or any credentials.
- Before finishing future coding tasks: run lint, typecheck, tests, and build (when available).
- When changing behaviour, update the relevant docs in /docs.

Agent-specific guidance

- For agent tasks include: branch to start from, files to change, exact acceptance criteria, tests to run, and any constraints.
- Keep PRs small and focused. Provide unit/integration tests for behaviour changes.
- If a task touches authentication, data access, or calendar feeds, add a security note in the PR and ensure secrets are not committed.
- Read `AGENTS.md` for this repo's full agent workflow contract, including which platform-specific operator guide under `docs/operators/` to read next (for example `docs/operators/github-copilot.md` if you are GitHub Copilot's coding agent).
