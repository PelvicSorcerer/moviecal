# moviecal-dispatcher

The local process that turns a Linear issue into a running agent against an isolated git worktree on this Mac. See `docs/operators/local-execution.md` for the full architecture, preflight gates, worker interface, and security model this implements.

## Status

Stage 8 of the Linear/GitHub/local-Mac dev-governance migration is functionally complete: `doctor`, `dry-run`, `gc`, and `run` are all implemented and unit-tested. **`dispatcher run` has real side effects** — it creates worktrees, spawns a real `claude`/`codex` process, and expects that worker to push a branch and open a PR. It has been unit-tested against every outcome (preflight block, routing block, worker success, worker failure, worker exits 0 with no PR, spawn error) with fakes, but has **not yet been run against the live Linear workspace** — that first real run is migration Stage 10 (end-to-end verification) and should be a deliberate, supervised action, not something triggered incidentally.

A Claude worker is invoked as `claude -p --model <id> --permission-mode dontAsk`, scoped by `.claude/settings.json` at the repo root (allow/deny rules matching the hard-deny list in `docs/operators/local-execution.md` §Security model). Getting a headless `claude -p` session to run at all — without hanging, and with its permission rules actually applied — needed two things verified directly against the installed CLI (v2.1.208), not assumed from docs: `--permission-mode dontAsk` (the newer `acceptEdits` + `--permission-prompts none` combination needs a version this Mac doesn't have), and pre-trusting the repo's main checkout path in `~/.claude.json` (`claude-trust.mjs`, wired into `WorktreeManager.create()`) — workspace trust for `.claude/settings.json` is anchored to that one path across every worktree, not to each worktree's own path.

## Commands

```
node tools/dispatcher/bin/dispatcher.mjs doctor
node tools/dispatcher/bin/dispatcher.mjs dry-run [--fixture path/to/issues.json]
node tools/dispatcher/bin/dispatcher.mjs gc
node tools/dispatcher/bin/dispatcher.mjs run --once            # one pass over eligible issues, then exit
node tools/dispatcher/bin/dispatcher.mjs run [--interval ms]   # poll loop (default 30000ms)
```

Also available as npm scripts: `npm run dispatcher:doctor`, `npm run dispatcher:dry-run`, `npm run dispatcher:gc`.

- **`doctor`** is read-only. It checks: Linear API auth, `gh` auth, worktree root writable, `.env.local` present and mode 600, `claude`/`codex` on `PATH`, `origin/master` fetchable, and the self-hosted iOS runner's online status. Run it after any environment change.
- **`dry-run`** fetches issues in the `Ready for Agent` Linear state (or reads a fixture JSON file with `--fixture`, for testing without a live Linear connection) and prints the worktree path, branch name, worker/model routing decision, and preflight verdict for each — without creating anything.
- **`gc`** prunes merged worktrees immediately and failed/abandoned worktrees older than the retention window, plus run logs older than 90 days.
- **`run`** is the real loop: for each issue in `Ready for Agent`, runs preflight (§ below), provisions a worktree, spawns the routed worker with the issue as its brief (piped via stdin), waits for it to exit, checks for a resulting PR, and reports every transition back to Linear as a state change + comment. See `docs/operators/local-execution.md` for the full state-transition table.

## Layout

```
tools/dispatcher/
  bin/dispatcher.mjs         CLI entrypoint
  scripts/
    provision-linear-workspace.mjs   one-shot idempotent Linear workspace setup
  src/
    config.mjs               paths, env-file parsing, secret-file mode checks
    linear-client.mjs        minimal Linear GraphQL client (fetch-based)
    preflight.mjs            preflight gate logic (pure) + branch/worktree naming
    worker-routing.mjs       worker + model routing rubric (pure)
    security-policy.mjs      hard-deny / needs-human command classification (pure)
    worktree-manager.mjs     git worktree lifecycle + JSON state bookkeeping
    claude-trust.mjs         pre-trusts a worktree in Claude Code's global config (~/.claude.json)
    brief.mjs                worker brief generation (pure)
    worker-spawn.mjs         spawns a worker process, captures logs to a manifest
    pr-check.mjs             checks whether a worker opened a PR for its branch
    run-loop.mjs             ties all of the above together for `dispatcher run`
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
