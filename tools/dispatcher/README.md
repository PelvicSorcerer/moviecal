# moviecal-dispatcher

The local process that turns a Linear issue into a running agent against an isolated git worktree on this Mac. See `docs/operators/local-execution.md` for the full architecture, preflight gates, worker interface, and security model this implements.

## Status

`doctor`, `dry-run`, `shadow`, `promote`, `priorities`, `gc`, and `run` are implemented and unit-tested. **`dispatcher run` and non-dry-run `dispatcher priorities` have real side effects** — they can mutate Linear state and local dispatcher state; `dispatcher run` also creates worktrees and spawns a real `claude`/`codex` process. The worker itself has no Git or GitHub mutation authority. The worker produces verified filesystem changes; the dispatcher audits its sandboxed structured transcript and diff, then creates the commit and performs the exact non-force branch push and draft-PR creation. The first live run after a dispatcher/security upgrade remains a deliberate, supervised operator action.

A Claude worker is invoked in structured-output `dontAsk` mode and Codex in structured-output `workspace-write --ask-for-approval never` mode. Both are wrapped in the same inherited macOS sandbox; vendor-specific controls are defense in depth. Getting a headless Claude session to run without hanging still requires pre-trusting the repo's main checkout path in `~/.claude.json` (`claude-trust.mjs`, wired into `WorktreeManager.create()`).

The safety boundary intentionally has no permissive fallback. Claude's project policy sets `sandbox.failIfUnavailable: true` and forbids unsandboxed commands, while the shared guard requires the outer macOS Seatbelt profile. If either layer is unavailable or cannot be applied, the worker must not start; the dispatcher integration fails closed to `Needs Human Decision` and preserves the failure in its checksummed audit record and Linear evidence comment. Operators must repair the host or configuration rather than disable a layer to keep unattended work running.

## Commands

```
node tools/dispatcher/bin/dispatcher.mjs doctor
node tools/dispatcher/bin/dispatcher.mjs dry-run [--fixture path/to/issues.json]
node tools/dispatcher/bin/dispatcher.mjs shadow --pr <number> [--fixture path/to/observation.json]
node tools/dispatcher/bin/dispatcher.mjs promote [--dry-run]
node tools/dispatcher/bin/dispatcher.mjs priorities [--dry-run]
node tools/dispatcher/bin/dispatcher.mjs gc
node tools/dispatcher/bin/dispatcher.mjs run --once            # one pass over eligible issues, then exit
node tools/dispatcher/bin/dispatcher.mjs run [--interval ms]   # poll loop (default 30000ms)
```

Also available as npm scripts: `npm run dispatcher:doctor`, `npm run dispatcher:dry-run`, `npm run dispatcher:gc`.

`shadow --pr` reads the PR and required checks, classifies the current head,
deduplicates observations, and prints the proposed decision as JSON. It never
starts a worker, reruns CI, or writes Linear state. `--fixture` accepts a saved
`checkPrObservation`-shaped JSON payload for repeatable classifier validation.
During a normal run, review PR observations are published to the matching
Linear issue as concise status records keyed by PR and SHA; those records are
not machine-control messages.

- **`doctor`** is read-only. It checks: Linear API auth, `gh` auth, worktree root writable, `.env.local` present and mode 600, `claude`/`codex` on `PATH`, the macOS worker sandbox can actually be applied, `origin/master` fetchable, and the self-hosted iOS runner's online status. Run it after any environment change.
- **`dry-run`** fetches issues in the `Ready for Agent` Linear state (or reads a fixture JSON file with `--fixture`, for testing without a live Linear connection) and prints the worktree path, branch name, worker/model routing decision, and preflight verdict for each — without creating anything.
- **`promote`** runs the automated Backlog/Blocked promotion rules; `--dry-run` reports what would move to `Ready for Agent`.
- **`priorities`** runs dependency-aware priority propagation; `--dry-run` reports raise/relax/skip outcomes and writes nothing.
- **`gc`** prunes merged worktrees immediately and failed/abandoned worktrees older than the retention window, plus run logs older than 90 days.
- **`run`** is the real loop: for each issue in `Ready for Agent`, runs preflight (§ below), provisions a worktree, spawns the guarded worker with the issue as its brief (piped via stdin), waits for it to exit, audits the transcript/diff, commits and publishes the accepted result through dispatcher-owned credentials, and reports every transition back to Linear. See `docs/operators/local-execution.md` for the full state-transition table.

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
    worker-guard.mjs         shared sandbox, credential stripping, transcript/diff audit, repair admission
    worker-publish.mjs       trusted non-force push and draft-PR creation after a clean audit
    worktree-manager.mjs     git worktree lifecycle + JSON state bookkeeping
    claude-trust.mjs         pre-trusts a worktree in Claude Code's global config (~/.claude.json)
    brief.mjs                worker brief generation (pure)
    worker-spawn.mjs         spawns a worker process, captures logs to a manifest
    pr-check.mjs             finds the PR attached to an audited branch
    pr-reconcile.mjs         observes PR head/check/review state and reconciles merged/closed worktrees
    workflow-edit-apply.mjs  applies a staged .github/workflows/ proposal (MOV-121; see local-execution.md)
    run-loop.mjs             ties all of the above together for `dispatcher run`
  test/                      Vitest unit tests for everything above
  launchd/
    com.moviecal.dispatcher.plist   launchd job template
  pending-workflow-edits/    staging area for authorized .github/workflows/ proposals (MOV-121)
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
| `~/.config/moviecal/worktrees.json` | dispatcher's own bookkeeping of active/merged/failed worktrees (atomic writes with `.bak` recovery) |
| `~/.config/moviecal/dispatcher.lock` | singleton lock; a second mutating dispatcher exits read-only |

Override the worktree root or log directory for local testing with `MOVIECAL_WORKTREE_ROOT` / `MOVIECAL_LOG_ROOT`.
