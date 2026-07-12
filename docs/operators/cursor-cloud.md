# Cursor Cloud Agent operator notes

## Scope

This doc covers what's specific to Cursor Cloud Agents when they develop this repo. Read `AGENTS.md` first for the generic contract that applies to every platform.

## What's verified vs assumed

Everything below marked "verified" was actually run against this repo on a real Cursor Cloud Agent VM (Ubuntu/x86_64) in a prior session, not just inferred from Cursor's documentation.

## Node version policy

- **Policy:** Node **24** (major), matching `.nvmrc`, `package.json` `engines.node` (`>=24`), and CI (`verify.yml`, `supabase-verify.yml`).
- **Cursor provisioning:** `.cursor/environment.json` builds from `.cursor/Dockerfile` (`node:24-bookworm` plus `git`, `jq`, and `sudo` for Cloud Agent clone/bootstrap). The install script fails fast if `node --version` is below 24.
- **Do not rely on nvm or `.nvmrc` alone on Cursor Cloud Agents.** The default interactive snapshot VM ships a fixed Node 22 binary at `/exec-daemon/node` that takes precedence over nvm; the Dockerfile path is the supported way to align with repo policy.
- **Verified (issue #103):** `node --version` reports v24.x and `npm run verify` passes on Node 24 (Ubuntu/x86_64).

## Bootstrap / environment config

- `.cursor/environment.json` defines the Cursor Cloud Agent environment for this repo. It builds a custom image from `.cursor/Dockerfile` and is independent of the `.codex/environments` profile, which targets Codex Desktop on macOS.
- Its install script copies `.env.example` to `.env.local` when missing, checks the Node major version, and runs `npm install`. It does not run `.codex/scripts/check-worker-environment.sh`; that script is part of the Codex worker/orchestrator worktree contract (`docs/operators/codex.md`), not the Cursor Cloud Agent contract.
- If a saved snapshot environment in the Cursor Cloud dashboard overrides the repo Dockerfile, delete it (or update the snapshot) so agents pick up `.cursor/environment.json` changes.

## Tool availability quirks

- **`jq` is required** for project queue validation and related governance scripts. The Cursor Cloud Agent image installs `jq` via `.cursor/Dockerfile`. Scripts that depend on it include `scripts/project-queue-check.sh`, `scripts/agent-check.sh`, `scripts/agent-handoff-check.sh`, `scripts/export-open-issue-order.sh`, `scripts/project-platform-track-sync.sh`, and `scripts/project-post-cutover-metadata-sync.sh` (all via `scripts/lib/project-queue-common.sh` or direct `command -v jq` checks). CI already expects `jq` (`.github/workflows/project-queue-check.yml`).
- `npm run tool:install` works on Cursor Cloud Agent VMs (verified on Ubuntu/x86_64): it detects OS/arch and downloads the matching Supabase CLI release.
- Docker is not available inside the running Cloud Agent workspace for local Supabase stacks, so `supabase db lint --local` and any workflow that needs a local Supabase/Postgres stack will not work here. Use the `supabase-verify` GitHub Actions workflow, or run `npm run db:lint` with a disposable `SUPABASE_DB_URL`.
- Unlike the Codex sandbox caveats in `docs/operators/codex.md`, `npm run lane:baseline`, `npm run lane:unit`, `npm run lane:integration`, `npm run build`, and `npm run lane:browser` (including its automatic `playwright install chromium` step) have been verified to run without elevated execution and without extra system packages on the default Cursor Cloud Agent VM. See `docs/planning/testing-lanes.md` for the full lane map.
- `gh` is available on Cursor Cloud Agent VMs, but default auth uses Cursor's GitHub integration token (`ghs_...`). That token supports clone/push but not richer GitHub API operations (for example `gh project`, `gh issue comment`) and may return `Resource not accessible by integration`.
- Optional operator PAT: add a classic GitHub PAT as `GITHUB_PAT_OPERATOR` (Runtime Secret) in Cursor Dashboard → Cloud Agents → Secrets. Required scopes: **`project`** and **`repo`**. Do not name this secret `GH_TOKEN` or `GITHUB_TOKEN` — Cursor may inject its integration token as `GH_TOKEN`, and `gh` gives those variables precedence over stored credentials. The `.cursor/environment.json` `start` hook exports `GH_TOKEN=$GITHUB_PAT_OPERATOR` when set.
- After adding or changing `GITHUB_PAT_OPERATOR`, **start a new agent run** (secrets inject at boot, not mid-session). Verify the PAT took effect before project or issue writes:
  - `echo "${GITHUB_PAT_OPERATOR:+set}"` should print `set`
  - `GH_TOKEN=$GITHUB_PAT_OPERATOR gh api user -q .login` should print your GitHub username
  - `GH_TOKEN=$GITHUB_PAT_OPERATOR gh api graphql -f query='{ viewer { projectsV2(first: 5) { nodes { title } } } }'` should list `moviecal Delivery`
  - `npm run agent:project-platform-sync` (idempotent Platform track backfill)
  - `npm run agent:project-check` (post-cutover dispatch invariant validation)

### Project queue validation on Cursor Cloud

With `GITHUB_PAT_OPERATOR` configured and `jq` available, platform/governance agents can validate live queue state against `PelvicSorcerer-Software/moviecal` and the organization project `PelvicSorcerer-Software/1` (`moviecal Delivery`):

```bash
npm run agent:project-check
```

`gh project item-list` may return `unknown owner type` on Cursor Cloud VMs even with a valid operator PAT. Queue scripts already fall back to `gh api graphql` for project item reads (`scripts/lib/project-queue-common.sh`), trying `organization(login:)` first and then `user(login:)`, so use `npm run agent:project-check` rather than ad hoc `gh project` subcommands when validating dispatch invariants.

## Branch convention

- `cursor/<slug>-<run-id>`, assigned by the Cursor platform, not chosen by the agent. See `docs/operators/branch-and-ci-conventions.md` for the full cross-platform table.

## Queue governance

- The Codex orchestrator/worker contract (`spawn_agent`, worktree provisioning, `BOOT_CHECKPOINT`/`STARTUP_CHECKPOINT` gates — see `docs/operators/codex-orchestration.md`) is specific to Codex's multi-agent tooling and does not apply to Cursor Cloud Agents, which run as a single agent per task/PR with no equivalent orchestrator step.
- **Cursor Cloud Agents may not start from `Agent Dispatch = Yes` as a worker** (the formal Codex spawn_agent handshake is Codex-only). Dispatch-slot work on `Product` or `Future` tracks starts via the Codex handshake. See `docs/operators/multi-platform-dispatch-policy.md`.
- **Cursor Cloud Agents may act as orchestrator**: they may promote issues, set `Agent Dispatch = Yes`, and run post-merge handoff using `gh` CLI with the operator PAT and the `/project-update` comment command. See the "Orchestrator role" section below.
- Cursor Cloud Agents **may** implement platform-track issues (`Track = Platform`), governance/docs work (`docs/**`, `chore/**`), and other tasks when a human assigns them directly (for example, a Cursor Cloud Agent task or an explicitly delegated issue). Direct assignment is not dispatch-slot consumption.

## Orchestrator role

A Cursor Cloud Agent session may act as orchestrator: reading queue state, promoting issues, setting `Agent Dispatch = Yes`, and running post-merge handoff. This requires `GITHUB_PAT_OPERATOR` to be configured (see "Tool availability quirks" above).

See `docs/operators/multi-platform-dispatch-policy.md` for the platform-neutral policy.

### Tool gaps and fallbacks

Cursor does not have a multi-agent orchestrator mechanism analogous to Codex's `spawn_agent`. Governance operations use `gh` CLI with the operator PAT and the `/project-update` comment command.

| Task | Cursor tool | Notes |
|---|---|---|
| Read queue state | `npm run agent:project-check` | Requires `jq` and `GITHUB_PAT_OPERATOR` |
| Update project fields | `/project-update` comment on the issue via `gh issue comment` | Requires `GITHUB_PAT_OPERATOR` |
| Read issue / PR state | `GH_TOKEN=$GITHUB_PAT_OPERATOR gh issue view <N>` | Standard `gh` CLI |
| Check PR merge status | `GH_TOKEN=$GITHUB_PAT_OPERATOR gh pr view <N>` | Standard `gh` CLI |
| Dispatch a worker | Post a direct-assignment comment on the issue | No `spawn_agent` equivalent; human or another platform runs the worker |

**Human fallback:** If `GITHUB_PAT_OPERATOR` is not available, a Cursor orchestrator session cannot make GitHub project or issue writes. In that case, post the intended `/project-update` commands to the human operator for manual execution before proceeding.

### Queue intake

Before promoting the next issue:

1. Confirm `GITHUB_PAT_OPERATOR` is set: `echo "${GITHUB_PAT_OPERATOR:+set}"`.
2. Run `npm run agent:project-check` to validate the current dispatch invariants.
3. Check whether the current dispatched issue's PR has merged: `GH_TOKEN=$GITHUB_PAT_OPERATOR gh pr list --state merged`.
4. Confirm the completed GitHub issue is closed.
5. Confirm no stray open PR remains for the same issue.

### Dispatch promotion

After confirming the handoff state is clean:

1. Demote the merged issue:
   ```bash
   GH_TOKEN=$GITHUB_PAT_OPERATOR gh issue comment <issue-number> \
     --body "/project-update Status=Done AgentDispatch=No"
   ```

2. Identify the next open issue on `Product` or `Future` with `Status = Ready` and the lowest `Queue Order`. Use `npm run agent:project-check` or query via `gh api graphql`.

3. Validate the selected issue has current acceptance criteria and a Testing Expectations section.

4. Promote exactly one issue:
   ```bash
   GH_TOKEN=$GITHUB_PAT_OPERATOR gh issue comment <next-issue-number> \
     --body "/project-update Status=Ready AgentDispatch=Yes"
   ```

5. If no qualifying issue exists, post a blocker note on the issue or project item.

### Post-merge handoff checklist

1. Confirm `origin/master` contains the merged commit (`git pull origin master`).
2. Confirm the completed issue is closed and no stray PR remains.
3. Demote the merged issue: post `/project-update Status=Done AgentDispatch=No`.
4. Select the next issue by `Queue Order` on dispatch-eligible tracks.
5. Promote exactly one issue: post `/project-update Status=Ready AgentDispatch=Yes`.
6. Post a direct-assignment comment or notify the human to assign a worker for the promoted issue.

This mirrors the platform-neutral checklist in `multi-platform-dispatch-policy.md`, implemented with Cursor's available tools.

## Secrets

For real (disposable/dev-only) Supabase, TMDb, and cron-secret values, prefer the Secrets tab in Cursor Dashboard → Cloud Agents over editing `.env.local` by hand. Secrets are injected as process environment variables, which Next.js reads at build and runtime even without a matching `.env.local` entry; use the exact variable names from `.env.example`.

## Known gaps / follow-ups

- Docker-based local Supabase stacks remain unavailable on Cursor Cloud Agent VMs (use `supabase-verify` CI or a disposable `SUPABASE_DB_URL` for `npm run db:lint`).
