# Local Mac execution

Read `AGENTS.md` first. This document covers the local-Mac execution path: how a Linear work item becomes a running agent in an isolated git worktree on this machine, and what every worker (human or agent) needs to know about that environment. It replaces the former per-platform operator guides (`claude-code.md`, `codex.md`) and the cloud-orchestrator model (`codex-orchestration.md`, `multi-platform-dispatch-policy.md`), which are retained under `docs/operators/archive/` as historical reference.

See `docs/governance/linear-information-architecture.md` for the Linear workspace design this path is driven by, and `docs/operators/worker-routing.md` for how a worker binary and model are selected per issue.

## What changed from the cloud-agent model

The previous system assumed agents ran in degraded cloud containers: no `gh` CLI, GitHub GraphQL blocked by a network proxy, no Docker, no persistent local state. None of that applies here. This Mac has a full `gh` install, direct GitHub API access, a real filesystem, and a real process supervisor. Do not carry forward workarounds written for that constrained environment — they produce strictly worse behavior locally (e.g. avoiding `gh` in favor of a comment-command workflow when `gh` is simply available).

## Architecture

```
  Linear issue (Ready for Agent, delegated)
        │
        ▼
  moviecal-dispatcher  (local Node process, launchd-managed)
        │  preflight gates (below)
        ├─ git worktree add ~/code/worktrees/moviecal/<LINEAR-ID>-<slug>
        │     branch: agent/<LINEAR-ID>-<slug>, from origin/master
        ├─ symlink .env.local → ~/.config/moviecal/env.local
        ├─ select worker + model (docs/operators/worker-routing.md)
        ├─ generate a brief from the Linear issue + AGENTS.md
        ├─ spawn the worker headlessly, capture stdout/stderr to a run log
        │
        │  worker: implement → npm run verify → (browser lane if applicable)
        │          → commit → push → gh pr create --draft
        │
        ├─ progress reported to Linear as comments + state transitions
        └─ worktree slot released
        │
        ▼
  GitHub PR ("Fixes MOV-123")  →  CI (verify, browser-verify, supabase-verify)
        │
        ▼
  Dispatcher observes CI → updates Linear (In Review / check results)
        │
        ▼
  GitHub auto-merge on green required checks → Linear moves to Done automatically
```

Dispatcher code lives in `tools/dispatcher/` in this repository (TypeScript, using the repo's existing Node 24 + Vitest toolchain). Runtime config lives outside the repo at `~/.config/moviecal/` (mode 700) — API keys and `.env.local` must never be committed. Run logs live at `~/Library/Logs/moviecal-dispatcher/`, retained 90 days.

## Dispatch trigger

The dispatcher polls Linear for issues in workflow state `Ready for Agent` that are delegated to it. (A future phase may register a Linear Agent App for webhook-driven dispatch instead of polling; both share the same downstream pipeline.)

## Preflight gates

Before starting work on an issue, all of the following must pass, or the issue moves to `Blocked` with a comment naming the failed gate:

1. No unresolved `blocked by` relations.
2. Not labeled `human-only`.
3. Not labeled `needs-secrets` unless the named local secret is actually present.
4. If the issue is in the **iOS Companion App** project: the self-hosted macOS runner (`moviecal-ios-runner`, labels `self-hosted, macOS, ios`) is online.
5. A concurrency slot is free (default: 2 simultaneous worktrees).
6. `origin/master` is fetched and the target worktree path is unused.

## Worktree lifecycle

- **Path:** `~/code/worktrees/moviecal/<LINEAR-ID>-<slug>`
- **Branch:** `agent/<LINEAR-ID>-<slug>`, branched from `origin/master`
- The Linear issue identifier appears in both the path and the branch name, so ownership is always unambiguous from either side.
- Ownership is recorded in `~/.config/moviecal/worktrees.json`: identifier, branch, PID, worker, model, start time, Linear issue URL.
- `.env.local` is a **symlink** to `~/.config/moviecal/env.local`, never a copy — one file to rotate, and no credential material ever lands inside a git-tracked tree.
- **Cleanup:** on merge, the worktree is removed and the remote branch deleted. On failure, the worktree is retained for 7 days for inspection, then pruned. `dispatcher gc` (also runnable manually) prunes stale entries and orphaned worktrees.
- Agents must not commit directly to `master`, and never operate outside their assigned worktree.

## Worker interface

A worker is any binary satisfying: *given a repo path, a branch, and a brief on stdin, produce commits on that branch and exit 0.* Concretely, `claude -p --model <id>` or `codex exec --sandbox workspace-write`. Adding a third worker means writing one adapter, not a new operator guide, a new branch prefix, and edits to every CI workflow's `branches:` filter.

## Branch and CI conventions

Branch prefixes are the machine-readable registry in `docs/operators/branch-prefixes.json`, enforced against CI workflow `branches:` filters by `npm run check:branch-ci`. Current prefixes:

- `agent/**` — all agent-authored implementation work (any worker binary)
- `docs/**` — documentation/governance-only changes
- `chore/**` — maintenance changes not tied to a specific Linear issue

Run `npm run check:branch-ci` after any change to `branch-prefixes.json` or a workflow's `branches:` filter — it is also enforced in `verify.yml`.

## Reporting back to Linear

At each transition the dispatcher writes to the Linear issue:

| Transition | Linear update |
|---|---|
| Delegated, dispatcher picks it up | State → `Agent Working`; comment with worktree path, branch, worker, model |
| Worker has a question it cannot resolve | State → `Needs Input`; comment with the question |
| Verification runs | Comment with lane results (`npm run verify`, browser lane if applicable) |
| PR opened | State → `In Review`; comment with PR link |
| CI completes | Comment with check conclusions |
| PR merges | State → `Done` (automatic, via the GitHub magic word, e.g. `Fixes MOV-123`) |
| Worker fails or hits a hard-deny action | State → `Blocked` or `Needs Human Decision`; comment with the last ~50 log lines and the run-log path |

No agent conversation is a source of truth. Anything that matters must be written to Linear or to the repository before the session ends.

## Security model

Full agent autonomy through merge is bounded by GitHub branch rulesets, not by agent good behavior — the ruleset is the actual enforcement boundary, not documentation.

**`master-protection` ruleset** (see `docs/technical/`) blocks deletion and non-fast-forward pushes, requires a `pull_request` review before merge, and requires `lane-baseline`, `lane-unit`, `lane-integration`, and `lane-browser` to pass. An agent never runs `gh pr merge --admin`; it enables GitHub auto-merge and lets the ruleset gate the actual merge.

**Credentials** — none live in the repository:

| Credential | Location | Scope |
|---|---|---|
| GitHub | `gh` keyring auth on this Mac | already scoped |
| Linear API key | `~/.config/moviecal/linear.env` (mode 600) | scoped to team `MOV` |
| Test `.env.local` | `~/.config/moviecal/env.local` (mode 600) | disposable/dev Supabase + TMDb credentials only |
| `SUPABASE_DB_URL_PROD` | GitHub Actions secret | never available to a local worker |

**Hard deny — the dispatcher refuses and escalates to `Needs Human Decision`:**

- Force-push anything; push to `master`; delete a branch other than its own
- Modify `.github/workflows/**`, GitHub rulesets, or branch protection
- `gh secret set`; echo any env var matching `*KEY*|*TOKEN*|*SECRET*|*PASSWORD*`
- Any command referencing `SUPABASE_DB_URL_PROD`; `supabase db reset`
- `vercel --prod`; `gh release create`; `npm publish`
- Edit `AGENTS.md`, `.github/copilot-instructions.md`, or `docs/product/**`

**Always requires a human (`Needs Human Decision`):**

- Database migrations touching existing tables
- Auth or calendar-token logic changes
- Anything adding a new secret
- Any production deploy or release
- Any change to this governance system itself

## Run-log locations

Dispatcher and worker run logs are written to `~/Library/Logs/moviecal-dispatcher/<LINEAR-ID>-<slug>/`, one directory per worktree, containing the full worker stdout/stderr and a `manifest.json` (worker, model, start/end time, exit code, PR URL if opened). Logs are retained for 90 days and then pruned by `dispatcher gc`. Given a Linear issue, the corresponding run log directory can always be found from the worktree/branch name recorded in the dispatcher's `Agent Working` comment on that issue (`<LINEAR-ID>-<slug>`).

## Standing health check

`dispatcher doctor` is a read-only command that asserts: Linear auth works, `gh` auth works, the worktree root is writable, `~/.config/moviecal/env.local` exists and is mode 600, `claude` and `codex` are on `PATH`, `origin/master` is fetchable, and the iOS self-hosted runner is reachable. Run it after any environment change and before relying on the dispatcher for real work.

## Known gaps / follow-ups

- Dispatch is currently poll-based (~30s latency). A Linear Agent App (webhook-driven) is a planned follow-up, not yet implemented.
- Docker is not installed on this Mac, so `npm run lane:real-stack` / `lane:full-stack` stay CI-only locally; use the `supabase-verify` GitHub Actions workflow as the authoritative DB gate.
