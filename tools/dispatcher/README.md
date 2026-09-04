# moviecal-dispatcher

The local process that turns a Linear issue into a running agent against an isolated git worktree on this Mac. See `docs/operators/local-execution.md` for the full architecture, preflight gates, worker interface, and security model this implements.

## Status

This is the Stage 8 scaffold of the Linear/GitHub/local-Mac dev-governance migration: `doctor`, `dry-run`, and `gc` are implemented and tested. `run` (the live poll loop) is intentionally not wired up yet — it depends on a live Linear workspace and API key, which don't exist yet (Stages 1–2 of the migration require a human to create the Linear account and issue the key). The building blocks `run` will use (routing, preflight, worktree lifecycle, Linear client) are implemented and unit-tested here so wiring the poll loop is the only remaining piece once Linear access exists.

## Commands

```
node tools/dispatcher/bin/dispatcher.mjs doctor
node tools/dispatcher/bin/dispatcher.mjs dry-run [--fixture path/to/issues.json]
node tools/dispatcher/bin/dispatcher.mjs gc
node tools/dispatcher/bin/dispatcher.mjs run       # not yet implemented
```

Also available as npm scripts: `npm run dispatcher:doctor`, `npm run dispatcher:dry-run`, `npm run dispatcher:gc`.

- **`doctor`** is read-only. It checks: Linear API auth, `gh` auth, worktree root writable, `.env.local` present and mode 600, `claude`/`codex` on `PATH`, `origin/master` fetchable, and the self-hosted iOS runner's online status. Run it after any environment change.
- **`dry-run`** fetches issues in the `Ready for Agent` Linear state (or reads a fixture JSON file with `--fixture`, for testing without a live Linear connection) and prints the worktree path, branch name, worker/model routing decision, and preflight verdict for each — without creating anything.
- **`gc`** prunes merged worktrees immediately and failed/abandoned worktrees older than the retention window, plus run logs older than 90 days.

## Layout

```
tools/dispatcher/
  bin/dispatcher.mjs         CLI entrypoint
  src/
    config.mjs               paths, env-file parsing, secret-file mode checks
    linear-client.mjs        minimal Linear GraphQL client (fetch-based)
    preflight.mjs            preflight gate logic (pure) + branch/worktree naming
    worker-routing.mjs       worker + model routing rubric (pure)
    security-policy.mjs      hard-deny / needs-human command classification (pure)
    worktree-manager.mjs     git worktree lifecycle + JSON state bookkeeping
  test/                      Vitest unit tests for everything above
  launchd/
    com.moviecal.dispatcher.plist   launchd job template
```

## Design notes

- Written as plain Node ESM (`.mjs`), not TypeScript, following the existing convention in this repo for standalone Node tooling (see `scripts/ci-full-stack-runtime.mjs`) rather than introducing a separate build step for a small tool package.
- All I/O (git shell-out, filesystem, network) is isolated behind small modules with injectable dependencies (a `runner` function, a `fetchImpl`), so the decision logic — preflight gates, routing, security classification — is unit-tested without touching a real git repo, the filesystem, or the network.
- Tests run via the repo's existing `npm run lane:unit` (wired into `vitest.unit.config.ts`'s `include` glob) — no separate test command or CI job needed.

## Configuration

All runtime configuration lives outside the repository under `~/.config/moviecal/` (see `docs/operators/local-execution.md` §Security model):

| File | Purpose |
|---|---|
| `~/.config/moviecal/linear.env` | `LINEAR_API_KEY=...` (and optionally `LINEAR_TEAM_KEY=...`, default `MOV`) |
| `~/.config/moviecal/env.local` | disposable/dev Supabase + TMDb credentials, symlinked into every worker worktree as `.env.local` |
| `~/.config/moviecal/worktrees.json` | dispatcher's own bookkeeping of active/merged/failed worktrees |

Override the worktree root or log directory for local testing with `MOVIECAL_WORKTREE_ROOT` / `MOVIECAL_LOG_ROOT`.
