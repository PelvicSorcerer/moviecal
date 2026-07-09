# GitHub Copilot coding agent operator notes

## Scope

This doc covers what's specific to GitHub Copilot's coding agent when it develops this repo. Read `AGENTS.md` first for the generic contract, and `.github/copilot-instructions.md` too — Copilot's coding agent discovers that file automatically at that fixed path.

## What's verified vs assumed

Everything marked **verified** below was observed in an actual GitHub Copilot coding-agent session against this repo (issue #105, branch `copilot/remaining-issue-fix`, Ubuntu 24.04 / x86_64). Items still marked **assumed** have not been independently confirmed.

## Bootstrap / environment config

- **Verified:** `.github/workflows/copilot-setup-steps.yml` is now present in this repo. It installs Node 24 via `actions/setup-node@v4` and runs `npm ci` before Copilot starts work. This is required because the default Copilot coding-agent VM ships Node 22 (see Node version policy below).
- The `copilot-setup-steps.yml` job name is required by Copilot's platform — do not rename it. The workflow auto-triggers on changes to the file so setup can be validated without a full agent run.
- `.codex/` and `.cursor/` are platform-specific and are not read by Copilot's coding agent.

## Node version policy

- **Policy:** Node **24** (major), matching `.nvmrc`, `package.json` `engines.node` (`>=24`), and CI (`verify.yml`, `supabase-verify.yml`).
- **Verified:** The default Copilot coding-agent VM ships Node **v22.23.0** with npm 10.9.8. `npm install` completes with an `EBADENGINE` warning (`required: >=24, current: v22.23.0`). `npm run verify` (lint → typecheck → test → build) still passes under Node 22 despite the warning, but the repo policy is Node 24.
- **Fix:** `.github/workflows/copilot-setup-steps.yml` installs Node 24 via `actions/setup-node@v4` before Copilot starts work. Do not rely on `.nvmrc` alone — it is not automatically applied in the Copilot runner environment.

## Tool availability

- **Verified:** Docker **is available** on the Copilot coding-agent VM (`docker ps` succeeds, Docker v28.0.4). This differs from Cursor Cloud Agents where Docker is not accessible. Local Supabase stacks (`supabase start`) should be feasible, though not tested in this session.
- **Verified:** `gh` CLI v2.95.0 is available, but `gh auth status` reports "Failed to log in to github.com using token (GITHUB_TOKEN)" — the default `GITHUB_TOKEN` is not a valid `gh` auth credential. Basic push/clone still works through the Copilot platform's own credentials; richer GitHub API calls (`gh project`, `gh issue comment`) may not work without a separate PAT.
- **Verified:** `npm run tool:install` works: it detects `linux/amd64` and installs the workspace-local Supabase CLI (v2.105.0) and Vercel CLI successfully.
- **Verified:** `npm run lint`, `npm run lane:unit`, `npm run lane:integration`, `npm run build`, `npm run verify`, and `npm run check:branch-ci` all pass.
- **Verified:** `npm run lane:browser` (alias: `npm run e2e`) **fails** — port 3100 is already bound by Copilot's own agent tooling when the agent session is active. This is an intrinsic environment constraint, not a missing dependency. Use the `browser-verify` GitHub Actions workflow as the CI fallback for browser lane coverage, the same way Cursor Cloud Agents rely on CI for checks blocked by Docker unavailability.

## Branch convention

- `copilot/**`, assigned by GitHub's Copilot coding agent platform. Already wired into `.github/workflows/supabase-verify.yml`'s push trigger — see `docs/operators/branch-and-ci-conventions.md` for the full cross-platform table.

## Queue governance

- Copilot's coding agent runs one agent per assigned issue/PR, similar to Cursor Cloud Agents; it does not participate in Codex's orchestrator/worker worktree handshake described in `docs/operators/codex-orchestration.md`.
- **GitHub Copilot may not start from `Agent Dispatch = Yes` as a worker** (the formal Codex spawn_agent handshake is Codex-only). Dispatch-slot work on `Product` or `Future` tracks starts via the Codex handshake. See `docs/operators/multi-platform-dispatch-policy.md`.
- **GitHub Copilot may act as orchestrator**: it may promote issues, set `Agent Dispatch = Yes`, and run post-merge handoff using `gh` CLI with a PAT and the `/project-update` comment command. See the "Orchestrator role" section below.
- Copilot **may** implement platform-track issues (`Track = Platform`), governance/docs work (`docs/**`, `chore/**`), and other tasks when GitHub assigns an issue/PR to Copilot or a human delegates the work. Direct assignment is not dispatch-slot consumption.

## Orchestrator role

A GitHub Copilot coding-agent session may act as orchestrator: reading queue state, promoting issues, setting `Agent Dispatch = Yes`, and running post-merge handoff. This requires a PAT with `project` and `repo` scopes (see "Secrets" section below).

See `docs/operators/multi-platform-dispatch-policy.md` for the platform-neutral policy.

### Tool gaps and fallbacks

Copilot does not have a multi-agent orchestrator mechanism analogous to Codex's `spawn_agent`. The default `GITHUB_TOKEN` does not authenticate `gh` CLI for project/issue writes. A PAT configured via the `copilot` environment is required for GitHub API governance calls.

| Task | Copilot tool | Notes / fallback |
|---|---|---|
| Read queue state | `npm run agent:project-check` (requires `jq` and PAT) | `jq` is available; PAT must be configured in the `copilot` environment |
| Update project fields | `/project-update` comment via `GH_TOKEN=<PAT> gh issue comment` | Requires PAT; see Secrets section |
| Read issue / PR state | `GH_TOKEN=<PAT> gh issue view <N>` / `gh pr view <N>` | Standard `gh` CLI; PAT preferred |
| Check PR merge status | `GH_TOKEN=<PAT> gh pr view <N> --json merged` | Standard `gh` CLI |
| Dispatch a worker | Assign the issue to Copilot or post a direct-assignment comment | No `spawn_agent` equivalent |
| Browser lane | Use `browser-verify` CI workflow | Port 3100 conflict blocks `npm run lane:browser` in agent sessions |

**Human fallback:** If the PAT is not available, a Copilot orchestrator session cannot make GitHub project or issue writes. In that case, surface the intended `/project-update` commands to the human operator for manual execution before continuing.

### Queue intake

Before promoting the next issue:

1. Confirm the PAT is available: `echo "${GH_TOKEN:+set}"` (the `copilot` environment should inject it — see Secrets).
2. Run `npm run agent:project-check` to validate current dispatch invariants.
3. Check whether the current dispatched issue's PR has merged.
4. Confirm the completed GitHub issue is closed.
5. Confirm no stray open PR remains for the same issue.

### Dispatch promotion

After confirming the handoff state is clean:

1. Demote the merged issue:
   ```bash
   gh issue comment <issue-number> \
     --body "/project-update Status=Done AgentDispatch=No"
   ```

2. Identify the next open issue on `Product` or `Future` with `Status = Ready` and the lowest `Queue Order`. Use `npm run agent:project-check` or query via `gh api graphql`.

3. Validate the selected issue has current acceptance criteria and a Testing Expectations section.

4. Promote exactly one issue:
   ```bash
   gh issue comment <next-issue-number> \
     --body "/project-update Status=Ready AgentDispatch=Yes"
   ```

5. If no qualifying issue exists, post a blocker note on the issue or project item.

### Post-merge handoff checklist

1. Confirm `origin/master` contains the merged commit.
2. Confirm the completed issue is closed and no stray PR remains.
3. Demote the merged issue: post `/project-update Status=Done AgentDispatch=No`.
4. Select the next issue by `Queue Order` on dispatch-eligible tracks.
5. Promote exactly one issue: post `/project-update Status=Ready AgentDispatch=Yes`.
6. Assign the issue to the appropriate platform (GitHub Copilot, another platform, or human) for the next implementation session.

This mirrors the platform-neutral checklist in `multi-platform-dispatch-policy.md`, implemented with Copilot's available tools.

## Secrets

- The `GITHUB_TOKEN` injected by the Copilot platform is not a usable `gh` CLI credential for project/issue API calls. If a task requires `gh` API calls, use a PAT configured via the `copilot` environment in the repository's GitHub Actions secrets; see [GitHub docs on setting environment variables](https://docs.github.com/en/copilot/customizing-copilot/customizing-copilots-development-environment#setting-environment-variables-in-copilots-environment). This is the same pattern as `GITHUB_PAT_OPERATOR` in `docs/operators/cursor-cloud.md`, but it has not been tested in this repo yet.
- For orchestrator sessions: the PAT must have `project` and `repo` scopes to write project fields and issue comments via `gh api graphql`.

## Known gaps / follow-ups

- Local Supabase stack (`supabase start` via Docker) has not been tested in a Copilot coding-agent session. Docker is available but the full stack was not started during the #105 verification run. Use `supabase-verify` CI workflow as the authoritative check for schema/migration correctness.
- The `copilot` environment PAT mechanism for `gh` API calls has not been tested in this repo yet. The orchestrator role above is documented based on the tool availability known from the #105 session; validate PAT injection before relying on it in a live governance session.
