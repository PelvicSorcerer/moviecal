# Claude Code operator notes

Read `AGENTS.md` first.

## Scope

This doc covers what's specific to Claude Code (CLI, web, IDE extensions, or remote execution environment) when it develops this repo: environment bootstrap, tool availability, branch convention, and queue-interaction notes. The generic contract in `AGENTS.md` applies to every platform; this doc only lists what differs.

## What's verified vs assumed

Items marked **verified** were observed in an actual Claude Code session against this repo. Items marked **assumed** have not been independently confirmed in this repo yet.

- **Verified (issue #163):** `CLAUDE.md` at repo root loads via the `@AGENTS.md` import directive, so a fresh Claude Code session reads repo instructions through this file.
- **Assumed:** Tool availability and environment details below are based on Claude Code's published documentation and the managed remote execution environment, not a full local-validation pass.

## Bootstrap / environment config

- Claude Code reads `CLAUDE.md` at the repo root on session start. `CLAUDE.md` imports `AGENTS.md` via `@AGENTS.md`, so the full generic contract loads automatically.
- No additional platform-specific config file (analogous to `.codex/environments/*.toml` or `.cursor/environment.json`) is required for basic Claude Code operation. The remote execution environment clones the repo fresh and runs in an isolated container.
- Copy `.env.example` to `.env.local` if missing and fill in disposable/dev-only credentials before running any command that touches Supabase, TMDb, or cron endpoints.
- Node version policy: **Node 24** (major), matching `.nvmrc`, `package.json` `engines.node` (`>=24`), and CI. Verify with `node --version` before running `npm install`.

## Tool availability quirks

- **`gh` CLI:** Available in the managed remote execution environment. The environment's GitHub App token supports clone/push but richer API calls (`gh project`, `gh issue comment`) require the GitHub MCP server tools instead (prefixed `mcp__github__`); do not use `gh` for project or issue API calls.
- **Docker:** Not available in the default managed remote execution environment. `supabase db lint --local` is therefore unavailable. Use the `supabase-verify` GitHub Actions workflow as the authoritative DB gate, or point `SUPABASE_DB_URL` at a disposable database.
- **Browser/Playwright:** Chromium is pre-installed (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). `npm run lane:browser` (alias: `npm run e2e`) should work without a separate `playwright install` step. Do not run `playwright install`.
- **`jq`:** Assumed available; required for `scripts/lib/project-queue-common.sh` and related governance scripts.
- **`npm run verify`** (`lane:baseline`, `lane:unit`, `lane:integration`): assumed to run without elevated execution in the remote container.
- **`npm run lane:real-stack`** (alias: `npm run db:lint`): blocked without Docker or a reachable Supabase Postgres port. Use CI or `SUPABASE_DB_URL`.

## Branch convention

- `claude/<issue-number>-<short-slug>` for Claude Code issue branches. Example: `claude/work-issue-163-eyf8vy`.
- The branch prefix `claude/**` is wired into the path-restricted push trigger in `.github/workflows/supabase-verify.yml` and documented in `docs/operators/branch-and-ci-conventions.md` and `docs/operators/branch-prefixes.json`.
- Branch from `master`; do not branch from a detached `HEAD`.

## Queue / dispatch interaction

- **Claude Code may not receive `Agent Dispatch = Yes` on any project item.** Dispatch-slot work on `Product` or `Future` tracks is owned by Codex workers. See `docs/operators/multi-platform-dispatch-policy.md`.
- Claude Code **may** implement platform-track issues (`Track = Platform`), governance/docs work (`docs/**`, `chore/**`), and other tasks when a human assigns the issue or delegates it directly. Direct assignment is not dispatch-slot consumption — do not set or assume `Agent Dispatch = Yes`.
- Treat the `moviecal Delivery` GitHub Project as the source of truth for queue state, even though Claude Code cannot update project fields natively. If a project update is needed, note it in the PR description and ask the human to update the project field.

## Secrets

- Use disposable or dev-only credentials for Supabase, TMDb, and cron protection. Do not use production secrets, long-lived personal credentials, or private user data.
- `.env.example` is placeholder-only. `.env.local` may exist with placeholder values.
- The remote execution environment does not persist credentials across sessions; re-supply any needed secrets at session start.

## Model-aware dispatch

Claude Code sessions can be started with an explicitly requested model. The dispatch contract distinguishes the *requested* model (what the orchestrator asked for) from the *effective* model (what the session actually runs on), because the two may differ.

### Selecting a model when launching a Claude worker

Three surfaces accept a model value, in precedence order (highest first):

| Surface | How to set it | Scope |
|---|---|---|
| CLI flag | `claude --model <model-id>` | One session |
| Environment variable | `ANTHROPIC_MODEL=<model-id>` | Process and its children |
| Settings file | `"model": "<model-id>"` in `.claude/settings.json` | All sessions that load that settings file |

When the orchestrator dispatches a Claude worker for a specific model requirement, prefer the CLI `--model` flag so the choice is visible at dispatch time and does not silently persist across sessions.

Valid model IDs use the form `claude-<family>-<version>` (for example `claude-sonnet-5` or `claude-haiku-4-5-20251001`). See `docs/operators/claude-api-reference.md` or the Claude API skill for the current model catalog.

### Requested model vs. effective model

- **`requested_model`**: the model ID the orchestrator supplied at dispatch time (via CLI flag, env var, or settings). If no model was specified, record `requested_model: default`.
- **`effective_model`**: the model ID the session is actually running on, as reported by the session itself (for example via `claude --version` output or the model string surfaced in the session context). The worker must record and report `effective_model` in every checkpoint.

The orchestrator should verify that `effective_model` matches `requested_model` before allowing substantive work to begin.

### Fallback and failure behavior

- If the requested model is **unavailable** (unknown model ID, no API access for the tier, or a retired identifier), Claude Code will surface an error at session start rather than silently downgrading. The worker must stop and report a blocker immediately instead of continuing on a different model.
- If `requested_model` is `default` and the account's default model changes over time, the worker must still record whichever `effective_model` it actually started on.
- The orchestrator must not treat a mismatch between `requested_model` and `effective_model` as a warning to dismiss. A mismatch is a blocker that requires explicit orchestrator acknowledgment before any implementation work begins.

### Worker-to-subagent model-handoff rule

When a Claude worker spawns a subagent via the `Agent` tool:

- If the parent worker brief specifies a model, the worker should pass that same model to the subagent's `model` parameter unless the brief explicitly allows the subagent to use a different one.
- If no model is specified in the brief, omit the `model` parameter on the `Agent` call; subagents inherit the parent session's model by default.
- The worker must record the intended subagent model (or `inherited`) in the checkpoint where it reports subagent use, so the orchestrator can audit the model chain without reading subagent threads directly.
- This rule does not force any specific model on all tasks. It only ensures the choice is visible and traceable when one is made.

### Checkpoint fields for model reporting

Add these fields to every `STARTUP_CHECKPOINT`, `REVIEW_CHECKPOINT`, and `PUBLISH_CHECKPOINT`:

```
requested_model: <model-id or "default">
effective_model: <model-id actually running>
model_match: <yes | no | not-checked>
subagent_model: <model-id | "inherited" | "none" (if no subagents used)>
```

Do not include API keys, tokens, or other secrets in checkpoint output.

### Worker brief field

The orchestrator must include a `Requested Claude model` field in every Claude worker brief. Use `default` when no specific model is required. Example:

```
Requested Claude model: claude-sonnet-5
```

See `docs/operators/claude-worker-dispatch-prompt.md` for the full Claude worker brief template.

## Known gaps / follow-ups

- A full verification pass of `npm run verify`, `npm run lane:browser`, and `npm run tool:install` inside the managed remote execution environment has not been recorded yet. The platform-specific notes above should be updated once that pass is complete.
- Local Supabase stack (`supabase start` via Docker) has not been tested in a Claude Code session. Use `supabase-verify` CI workflow as the authoritative check for schema/migration correctness.
- The model catalog (valid model IDs) is not pinned here because it changes over time. Use the `claude-api` skill or Anthropic's published model page for the current list. When this doc is used to verify model IDs, check the live catalog rather than relying on examples in this file.
