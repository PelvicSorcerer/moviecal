# Cursor Cloud Agent operator notes

## Scope

This doc covers what's specific to Cursor Cloud Agents when they develop this repo. Read `AGENTS.md` first for the generic contract that applies to every platform.

## What's verified vs assumed

Everything below marked "verified" was actually run against this repo on a real Cursor Cloud Agent VM (Ubuntu/x86_64) in a prior session, not just inferred from Cursor's documentation.

## Node version policy

- **Policy:** Node **24** (major), matching `.nvmrc`, `package.json` `engines.node` (`>=24`), and CI (`verify.yml`, `supabase-verify.yml`).
- **Cursor provisioning:** `.cursor/environment.json` builds from `.cursor/Dockerfile` (`node:24-bookworm` plus `git` and `sudo` for Cloud Agent clone/bootstrap). The install script fails fast if `node --version` is below 24.
- **Do not rely on nvm or `.nvmrc` alone on Cursor Cloud Agents.** The default interactive snapshot VM ships a fixed Node 22 binary at `/exec-daemon/node` that takes precedence over nvm; the Dockerfile path is the supported way to align with repo policy.
- **Verified (issue #103):** `node --version` reports v24.x and `npm run verify` passes on Node 24 (Ubuntu/x86_64).

## Bootstrap / environment config

- `.cursor/environment.json` defines the Cursor Cloud Agent environment for this repo. It builds a custom image from `.cursor/Dockerfile` and is independent of the `.codex/environments` profile, which targets Codex Desktop on macOS.
- Its install script copies `.env.example` to `.env.local` when missing, checks the Node major version, and runs `npm install`. It does not run `.codex/scripts/check-worker-environment.sh`; that script is part of the Codex worker/orchestrator worktree contract (`docs/operators/codex.md`), not the Cursor Cloud Agent contract.
- If a saved snapshot environment in the Cursor Cloud dashboard overrides the repo Dockerfile, delete it (or update the snapshot) so agents pick up `.cursor/environment.json` changes.

## Tool availability quirks

- `npm run tool:install` works on Cursor Cloud Agent VMs (verified on Ubuntu/x86_64): it detects OS/arch and downloads the matching Supabase CLI release.
- Docker is not available inside the running Cloud Agent workspace for local Supabase stacks, so `supabase db lint --local` and any workflow that needs a local Supabase/Postgres stack will not work here. Use the `supabase-verify` GitHub Actions workflow, or run `npm run db:lint` with a disposable `SUPABASE_DB_URL`.
- Unlike the Codex sandbox caveats in `docs/operators/codex.md`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, and `npm run e2e` (including its automatic `playwright install chromium` step) have been verified to run without elevated execution and without extra system packages on the default Cursor Cloud Agent VM.
- `gh` is available on Cursor Cloud Agent VMs, but default auth uses Cursor's GitHub integration token (`ghs_...`). That token supports clone/push but not richer GitHub API operations (for example `gh project`, `gh issue comment`) and may return `Resource not accessible by integration`.
- Optional operator PAT: add a classic GitHub PAT as `GITHUB_PAT_OPERATOR` (Runtime Secret) in Cursor Dashboard → Cloud Agents → Secrets. Required scopes: **`project`** and **`repo`**. Do not name this secret `GH_TOKEN` or `GITHUB_TOKEN` — Cursor may inject its integration token as `GH_TOKEN`, and `gh` gives those variables precedence over stored credentials. The `.cursor/environment.json` `start` hook exports `GH_TOKEN=$GITHUB_PAT_OPERATOR` when set.
- After adding or changing `GITHUB_PAT_OPERATOR`, **start a new agent run** (secrets inject at boot, not mid-session). Verify the PAT took effect before project or issue writes:
  - `echo "${GITHUB_PAT_OPERATOR:+set}"` should print `set`
  - `GH_TOKEN=$GITHUB_PAT_OPERATOR gh api user -q .login` should print your GitHub username
  - `GH_TOKEN=$GITHUB_PAT_OPERATOR gh api graphql -f query='{ viewer { projectsV2(first: 5) { nodes { title } } } }'` should list `moviecal Delivery`
  - `npm run agent:project-platform-sync` (idempotent Platform track backfill)
## Branch convention

- `cursor/<slug>-<run-id>`, assigned by the Cursor platform, not chosen by the agent. See `docs/operators/branch-and-ci-conventions.md` for the full cross-platform table.

## Queue governance

- The Codex orchestrator/worker contract (`spawn_agent`, worktree provisioning, `BOOT_CHECKPOINT`/`STARTUP_CHECKPOINT` gates — see `docs/operators/codex.md` and `docs/planning/agent-orchestration.md`) is specific to Codex's multi-agent tooling and does not apply to Cursor Cloud Agents, which run as a single agent per task/PR with no equivalent orchestrator step.
- **Cursor Cloud Agents may not receive `Agent Dispatch = Yes` on any project item.** Product-track feature delivery is owned by Codex workers via the single dispatch slot. See `docs/operators/multi-platform-dispatch-policy.md`.
- Cursor Cloud Agents **may** implement platform-track issues (`Track = Platform`), governance/docs work (`docs/**`, `chore/**`), and other tasks when a human assigns them directly (for example, a Cursor Cloud Agent task or an explicitly delegated issue). Direct assignment is not dispatch-slot consumption — do not set or assume `Agent Dispatch = Yes`.

## Secrets

For real (disposable/dev-only) Supabase, TMDb, and cron-secret values, prefer the Secrets tab in Cursor Dashboard → Cloud Agents over editing `.env.local` by hand. Secrets are injected as process environment variables, which Next.js reads at build and runtime even without a matching `.env.local` entry; use the exact variable names from `.env.example`.

## Known gaps / follow-ups

- None currently tracked for Cursor Cloud Agent environment compatibility.
