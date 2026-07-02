# Operator guides index

Read `AGENTS.md` first.

This directory holds one guide per agent platform that develops this repo (Codex, Cursor Cloud, GitHub Copilot, and any future platform). `AGENTS.md` at the repo root is the required starting point for every agent or human contributor; it routes you here for platform-specific detail so it can stay short enough to read in full every session.

## Queue authority

- The `moviecal Delivery` GitHub Project is authoritative for live queue state, workflow status, queue ordering, and dispatch selection.
- GitHub issues are authoritative for scoped execution contracts: background, acceptance criteria, verification steps, security notes, dependency notes, and out-of-scope boundaries.
- Dispatch authority lives in the GitHub Project `Agent Dispatch` and `Status` fields. Do not dispatch from issue labels alone.
- Multi-platform dispatch rights are documented in `multi-platform-dispatch-policy.md`.

## How do I know which platform I'm on?

- If your tooling reads `.codex/environments/*.toml`, or you were launched via Codex Desktop/CLI, read `codex.md`.
- If your tooling reads `.cursor/environment.json`, or you were launched as a Cursor Cloud Agent (`cursor.com/agents` or the Cloud tab in Cursor), read `cursor-cloud.md`.
- If you are GitHub Copilot's coding agent (assigned via a GitHub issue delegated to Copilot, or an `@copilot` mention), read `github-copilot.md`.
- If you are a human contributor, or a platform not listed here, follow the generic `AGENTS.md` contract directly. Nothing in this directory is required reading for you, though `branch-and-ci-conventions.md` is worth a skim before you add a new CI trigger.

## A note on scope: platforms vs procedure

This directory documents differences between **how each agent platform runs** (bootstrap, tool availability, branch naming, secrets). It intentionally does **not** absorb the full Codex orchestrator/worker procedure — that content still lives in `docs/planning/agent-orchestration.md` and `docs/planning/AGENT_GUIDANCE.md` until issue **#104** consolidates it here.

## Adding a new platform

When a new agent platform starts developing this repo, add `docs/operators/<platform>.md` following this template, and add its branch prefix to `docs/operators/branch-and-ci-conventions.md` (and `branch-prefixes.json`) in the same change:

1. **Scope** — one sentence on what this doc covers and when to read it.
2. **What's verified vs assumed** — be explicit about what has actually been run/tested on that platform in this repo, versus what's inferred from the platform's own documentation. Don't claim something is "verified" unless someone actually ran it here.
3. **Bootstrap / environment config** — where that platform's config file lives (if any) and what it does.
4. **Tool availability quirks** — Docker, `gh` CLI auth, OS/arch, and anything else that differs from what the generic `AGENTS.md` contract assumes.
5. **Branch convention** — the exact prefix, and whether the agent or the platform assigns it.
6. **Queue / dispatch interaction** — state explicitly whether that platform may receive `Agent Dispatch = Yes` on a project item (see `docs/operators/multi-platform-dispatch-policy.md`). Do not assert queue access on a platform's behalf.
7. **Known gaps / follow-ups** — anything not yet verified, so the next agent on that platform knows what to check.

Then update `AGENTS.md`'s router table and `docs/operators/branch-and-ci-conventions.md` (plus `branch-prefixes.json`) so the new platform doesn't drift out of sync with everything else. Run `npm run check:branch-ci` to confirm the branch/CI tables agree before committing.

## Files in this directory

- `codex.md` — Codex Desktop/CLI environment and tooling notes (orchestrator procedure pointers; not the full queue contract).
- `cursor-cloud.md` — Cursor Cloud Agent environment notes.
- `github-copilot.md` — GitHub Copilot coding agent notes.
- `multi-platform-dispatch-policy.md` — which platforms may receive `Agent Dispatch = Yes` after project cutover.
- `branch-and-ci-conventions.md` — single source of truth for branch-prefix-to-platform mapping and which CI workflows must reference each prefix.
- `branch-prefixes.json` — machine-readable version of the same table, read by `scripts/check-branch-ci-conventions.py`.
