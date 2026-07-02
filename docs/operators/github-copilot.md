# GitHub Copilot coding agent operator notes

## Scope

This doc covers what's specific to GitHub Copilot's coding agent when it develops this repo. Read `AGENTS.md` first for the generic contract, and `.github/copilot-instructions.md` too — Copilot's coding agent discovers that file automatically at that fixed path.

## What's verified vs assumed

Unlike `docs/operators/codex.md` and `docs/operators/cursor-cloud.md`, nothing below has been directly verified by actually running Copilot's coding agent against this repo in a tracked session. This is audit-derived from repo artifacts (the `copilot/**` CI trigger, the issue template's prior "for Copilot agents" wording, and `.github/copilot-instructions.md`), not a verified operator report. Treat these as best-known facts, not guarantees, until someone runs Copilot's coding agent here and updates this doc with real findings — the same way `cursor-cloud.md` was populated by actually running Cursor here.

## Bootstrap / environment config

- This repo has no Copilot-specific bootstrap file today. Copilot's coding agent supports a `copilot-setup-steps.yml` GitHub Actions workflow for custom environment setup (comparable in spirit to `.codex/environments/*.toml` or `.cursor/environment.json`); none exists here yet. If Copilot needs custom setup (a specific Node version, Playwright system dependencies, etc.), add that workflow file rather than repurposing `.codex/` or `.cursor/`, which are mechanically read only by their respective platforms.
- Absent that file, Copilot's coding agent runs whatever its own default environment provides, then reads `.github/copilot-instructions.md` and `AGENTS.md`.

## Branch convention

- `copilot/**`, assigned by GitHub's Copilot coding agent platform. Already wired into `.github/workflows/supabase-verify.yml`'s push trigger — see `docs/operators/branch-and-ci-conventions.md` for the full cross-platform table.

## Queue governance

- Copilot's coding agent runs one agent per assigned issue/PR, similar to Cursor Cloud Agents; it does not participate in Codex's orchestrator/worker worktree handshake described in `docs/operators/codex.md` and `docs/planning/agent-orchestration.md`.
- Whether Copilot may receive `Agent Dispatch = Yes` on a project item is the same open policy decision noted for Cursor (issue **#102**). Until decided, treat Copilot's coding agent as following this repo's general branch/PR/verification rules on whatever task it is assigned, without asserting queue rights.

## Known gaps / follow-ups

- No verified information yet about the Copilot coding agent VM's OS/arch, Docker availability, `gh` CLI auth state, or whether `npm run tool:install`/`npm run e2e` work unmodified there. Whoever first runs Copilot's coding agent against this repo for real should update this section with actual findings.
