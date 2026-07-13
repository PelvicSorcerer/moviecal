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

- **Claude Code may not receive the dispatch slot** (`Agent Dispatch = Yes`) on `Product` or `Future`. The formal handshake model (dispatch slot + orchestrator-provisioned worktrees) is Codex-only there. The iOS track is the mixed-execution exception: a promoted iOS issue may be implemented from Claude Code, but merge readiness is still gated by the self-hosted macOS runner. See `docs/operators/multi-platform-dispatch-policy.md`.
- Claude Code **may** implement **any track** (Product, Future, Platform, or Migration) when a human assigns the issue or delegates it directly, without requiring `Agent Dispatch = Yes`. This is called **direct assignment** and is available to every agent platform. See the "Direct assignment path" section in `docs/operators/multi-platform-dispatch-policy.md`.
- Direct assignment means: a human explicitly assigns or delegates the issue (for example, "Claude Code, implement issue #174"), the issue stays at `Agent Dispatch = No`, and the worker uses the `claude/**` branch prefix. Direct assignment does not consume the dispatch slot.
- Treat the `moviecal Delivery` GitHub Project as the source of truth for queue state. To update project fields, use the `/project-update` comment command documented below.

### `/project-update` comment command

Any repository collaborator with **write** or **admin** access can update `moviecal Delivery` project fields by posting a comment on an issue. The comment must contain a line starting with `/project-update` followed by space-separated `Key=Value` pairs.

```
/project-update Key=Value [Key=Value ...]
```

**Supported fields:**

| Command key | Project field | Type |
|---|---|---|
| `Status` | Status | single-select |
| `AgentDispatch` | Agent Dispatch | single-select |
| `Track` | Track | single-select |
| `QueueOrder` | Queue Order | number |
| `Priority` | Priority | single-select |
| `Risk` | Risk | single-select |
| `ExecutionMode` | Execution Mode | single-select |
| `TargetPRSize` | Target PR Size | single-select |

Field names are case-sensitive (exactly as shown above). Option values are case-insensitive. The issue must already be linked to the `moviecal Delivery` project.

If any field name or option value is invalid, the workflow replies with an error and makes **no changes**. All validation happens before any mutation.

**Copy-paste examples for each governance step:**

```
# Triage: move a new issue into the backlog
/project-update Status=Backlog Track=Product Priority=P2 AgentDispatch=No

# Set queue position during triage
/project-update QueueOrder=42

# Promote to ready and open the dispatch slot (Codex orchestrator only)
/project-update Status=Ready AgentDispatch=Yes

# Mark in-progress when a worker starts (use underscore for spaces in option values)
/project-update Status=In_Progress AgentDispatch=No

# Move to review after PR is opened
/project-update Status=Review

# Post-merge: close out the dispatch slot
/project-update Status=Done AgentDispatch=No

# Demotion: block an issue that can't proceed
/project-update Status=Blocked AgentDispatch=No

# Reorder: shift a ready issue earlier in the queue
/project-update QueueOrder=15

# Full triage in one pass
/project-update Status=Backlog Track=Future QueueOrder=45 Priority=P1 Risk=High ExecutionMode=Agent AgentDispatch=No
```

The workflow posts a confirmation comment on success listing each field updated and its new value. The bot uses `GITHUB_TOKEN` (appears as `github-actions[bot]`). Project mutations use the `PROJECT_UPDATE_PAT` secret (classic PAT, `project` scope); this token is never echoed in logs or comments.

## Secrets

- Use disposable or dev-only credentials for Supabase, TMDb, and cron protection. Do not use production secrets, long-lived personal credentials, or private user data.
- `.env.example` is placeholder-only. `.env.local` may exist with placeholder values.
- The remote execution environment does not persist credentials across sessions; re-supply any needed secrets at session start.

## Model-aware dispatch

The **policy** for how a model is chosen for a given Claude task lives in `docs/operators/claude-model-selection-policy.md`. Read that document for the decision criteria (when to use `default` vs. a named model, subagent override rules, and issue-shaping guidance). This section covers the mechanical surfaces that implement whatever model choice that policy produces.

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

### CCR environment: model alias resolution and upgrade workaround

In the Claude Code remote execution (CCR) environment (Claude Platform on AWS), the
`Agent` tool's `model` parameter accepts only enum aliases, not full model IDs:

| Alias | Resolves to in CCR |
|---|---|
| `sonnet` | `claude-sonnet-4-6` |
| `opus` | `claude-opus-4-8` |
| `haiku` | `claude-haiku-4-5-20251001` (verify at dispatch time) |
| `fable` | `claude-fable-5` (verify at dispatch time) |

Full model IDs (e.g. `claude-sonnet-5`) are **not accepted** by the `model` parameter
in CCR — the Agent tool will error if one is passed.

**Upgrade workaround:** When an issue requests `claude-sonnet-5` (for a
security-critical or architecture-heavy task), dispatch with `model: "opus"`
(`claude-opus-4-8`) instead. This satisfies the upgrade intent (more capable than
the default `sonnet` alias in CCR) and avoids the enum constraint.

**Worker behavior:** A worker whose `effective_model` is `claude-opus-4-8` and whose
`requested_model` is `claude-sonnet-5` should record `model_match: ccr-substitution`
in its checkpoint and proceed. This is not a mismatch to block on — it is a known
platform constraint. See the model-match rule in
`docs/operators/claude-worker-dispatch-prompt.md`.

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

## Project-scoped subagents

Two repo-tracked subagents live in `.claude/agents/`. Both were added to cover
patterns that recur across sessions, not speculative future use.

| Agent | File | Purpose |
|---|---|---|
| `Explore` | `.claude/agents/explore.md` | Read-only codebase search — finds files, symbols, and references without modifying state. Used in almost every implementation session. |
| `code-reviewer` | `.claude/agents/code-reviewer.md` | Reviews diffs/files for correctness bugs, security issues, and simplification. Knows the repo's testing lanes and PR template requirements. |

### Model behavior

Both agents **inherit the parent session's effective model by default**. Neither
definition pins an explicit model in its frontmatter. This is intentional: the
repo's model-selection policy (`docs/operators/claude-model-selection-policy.md`)
assigns models at the worker-session level; subagents should not override that
choice unless the worker brief explicitly says so.

Do not add a `model:` field to these agent definitions without a corresponding
update to the model-selection policy doc and a rationale comment in the issue
that drives the change.

### Tool restrictions

- `Explore` is limited to read-only tools (`Glob`, `Grep`, `Read`, `Bash`,
  `WebFetch`, `WebSearch`). It must not be granted write tools.
- `code-reviewer` is limited to read-only tools (`Glob`, `Grep`, `Read`,
  `Bash`). It must not be granted write tools or network tools.

Do not expand the tool lists without a concrete justification and a review of
the security implications.

### Worktree isolation

Neither subagent requires worktree isolation (`isolation: worktree` frontmatter)
because both are read-only. If a future subagent needs to run potentially
destructive Bash commands in isolation, add `isolation: worktree` to its
frontmatter and document the reason here.

### Adding or removing subagents

Before adding a new `.claude/agents/` definition:

1. Confirm the workflow recurs across multiple sessions (not speculative).
2. Keep the tool list minimal — only what the agent actually needs.
3. Document the agent in the table above and update this section.
4. If the agent pins a model, update `docs/operators/claude-model-selection-policy.md`.

Before removing a definition, confirm it is no longer referenced in any worker
brief or issue template.

## Orchestrator role

A Claude Code session may act as orchestrator: reading queue state, promoting issues, setting `Agent Dispatch = Yes`, and running post-merge handoff. This section documents the full governance cycle a Claude Code session can run using its native tools.

See `docs/operators/multi-platform-dispatch-policy.md` for the platform-neutral policy, and `docs/operators/codex-orchestration.md` for the Codex-specific orchestrator contract (unchanged).

### Native tools for queue governance

| Task | Preferred tool |
|---|---|
| Read project queue state | `mcp__github__*` tools (e.g. `mcp__github__issue_read`, `mcp__github__list_issues`) |
| Update project fields | `/project-update` comment command (see "Queue / dispatch interaction" above) |
| Read and write issue comments | `mcp__github__add_issue_comment`, `mcp__github__issue_read` |
| Read PRs and check merge status | `mcp__github__pull_request_read`, `mcp__github__list_pull_requests` |
| List branches | `mcp__github__list_branches` |
| Dispatch a Claude worker subagent | `Agent` tool (pass `model: "sonnet"` unless the issue brief specifies otherwise) |

### Queue intake

Before promoting the next issue, run this preflight from a session that has pulled `origin/master`:

1. Confirm the current dispatched issue's PR has merged (`mcp__github__pull_request_read` or `mcp__github__list_pull_requests`).
2. Confirm the completed GitHub issue is closed (`mcp__github__issue_read`).
3. Confirm no stray open PR remains for the same issue.
4. Run `bash scripts/agent-handoff-check.sh` (if `jq` is available in the environment) or verify the queue invariants manually via the GitHub MCP tools.

### Dispatch promotion

After confirming the handoff state is clean:

1. Demote the merged issue by posting a comment on it:
   ```
   /project-update Status=Done AgentDispatch=No
   ```

2. Query open queue-eligible issues with `Status = Ready`. Use `mcp__github__list_issues` or `mcp__github__search_issues` to enumerate candidates, then identify the one with the lowest `Queue Order` project field value that also passes the dependency and live-gate rules from `docs/operators/codex-orchestration.md`.

3. Verify the selected issue has current acceptance criteria, verification steps, and a **Testing Expectations** section. If the issue has been open through later merged work, spot-check the repo state against the acceptance criteria before promoting.

4. Promote exactly one issue:
   ```
   /project-update Status=Ready AgentDispatch=Yes
   ```
   Post this comment on the selected issue.

5. If no qualifying issue exists, post a blocker note on the project or a relevant issue instead of promoting speculatively.

### Worker dispatch

A Claude Code orchestrator may dispatch a Claude Code worker for the promoted issue using the `Agent` tool:

- Pass `model: "sonnet"` unless the issue explicitly requires a different model (see `docs/operators/claude-model-selection-policy.md`). In CCR, `"sonnet"` resolves to `claude-sonnet-4-6`; pass `model: "opus"` (`claude-opus-4-8`) when the issue requests `claude-sonnet-5`.
- Use `docs/operators/claude-worker-dispatch-prompt.md` as the worker brief template. Fill in: issue number and title, assigned branch, docs to read first, exact verification commands, Testing Expectations, manual testing checklist, and known constraints.
- Record `subagent_model` in the orchestrator checkpoint.

Workers for other platforms (Codex, Cursor, Copilot) are dispatched by those platforms' own mechanisms; a Claude Code orchestrator session may instead post a direct-assignment comment on the issue.

### Post-merge handoff checklist

Run this after the worker PR lands on `master`:

1. Pull or confirm `origin/master` contains the merged commit.
2. Confirm the completed issue is closed.
3. Confirm no stray open PR remains for the same issue.
4. Demote the merged issue: `/project-update Status=Done AgentDispatch=No`.
5. Re-evaluate the next dependency-correct issue by `Queue Order`.
6. Promote exactly one issue to `Agent Dispatch = Yes`, or document the blocker.
7. Update planning or guidance docs if the merge changed queue assumptions.

This is the same checklist as the platform-neutral one in `multi-platform-dispatch-policy.md`, implemented here using `/project-update` and the GitHub MCP server tools.

### Full governance cycle (self-contained reference)

A fresh Claude Code orchestrator session can run the full lifecycle without reading the Codex guide:

1. **Pull state:** confirm `origin/master` is current; read open issues and PRs with `mcp__github__*` tools.
2. **Queue intake:** confirm the last dispatched issue's PR merged and the issue is closed.
3. **Demote:** post `/project-update Status=Done AgentDispatch=No` on the completed issue.
4. **Select next:** find the open `Ready` issue with the lowest `Queue Order` that also passes the dependency and live-gate rules from `docs/operators/codex-orchestration.md`.
5. **Validate:** confirm the selected issue has current acceptance criteria, verification steps, and a Testing Expectations section.
6. **Promote:** post `/project-update Status=Ready AgentDispatch=Yes` on the selected issue.
7. **Dispatch or assign:** use the `Agent` tool to launch a Claude worker, or post a direct-assignment comment for another platform.
8. **Supervise (if Claude worker):** collect `BOOT_CHECKPOINT`, then `REVIEW_CHECKPOINT`, then `PUBLISH_CHECKPOINT` from the worker session. Merge an acceptable PR.
9. **Repeat from step 1.**

If the queue is blocked at any step, record the blocker on the issue or project item and stop rather than promoting speculatively.

## Known gaps / follow-ups

- A full verification pass of `npm run verify`, `npm run lane:browser`, and `npm run tool:install` inside the managed remote execution environment has not been recorded yet. The platform-specific notes above should be updated once that pass is complete.
- Local Supabase stack (`supabase start` via Docker) has not been tested in a Claude Code session. Use `supabase-verify` CI workflow as the authoritative check for schema/migration correctness.
- The model catalog (valid model IDs) is not pinned here because it changes over time. Use the `claude-api` skill or Anthropic's published model page for the current list. When this doc is used to verify model IDs, check the live catalog rather than relying on examples in this file.
