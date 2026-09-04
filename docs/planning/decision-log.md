# Decision log

- Use Vercel Hobby for initial hosting.
- Use Supabase Free for initial auth and database.
- Use TMDb for movie metadata.
- Use iCalendar feed subscription rather than native calendar API integration.
- Use public GitHub repo, so secrets must never be committed.
- Keep architecture portable enough to self-host later if needed.
- Replace the GitHub-Project-centric, multi-cloud-agent dev-governance model with a Linear-based control plane and a local-Mac dispatcher. See `docs/governance/linear-information-architecture.md` and `docs/operators/local-execution.md`. Migration status below.

## Dev-governance migration status

Staged migration from a GitHub-Project (`moviecal Delivery`) + multi-cloud-agent-platform workflow to Linear (control plane) + local Mac (execution). Superseded docs (`docs/operators/claude-code.md`, `codex.md`, `cursor-cloud.md`, `github-copilot.md`, `codex-orchestration.md`, `multi-platform-dispatch-policy.md`) and the `/project-update` automation remain in place until Stage 11 archives/removes them — do not follow them for current work; `AGENTS.md` and the docs it points to are authoritative regardless.

| Stage | Deliverable | Status |
|---|---|---|
| 1 | Linear workspace created (Free plan) | **Done** |
| 2 | Linear API key issued and stored at `~/.config/moviecal/linear.env` | **Done** |
| 3 | Linear IA built (team, initiatives, projects, states, labels) | **Done** — team settings, 2 initiatives, 5 projects (linked to their initiatives), 14 workflow states, 33 labels, 3 milestones, all provisioned via `tools/dispatcher/scripts/provision-linear-workspace.mjs`. Initiatives were initially skipped as Business-plan-gated; the repo owner then enabled the feature directly in Linear and initiatives were added. Custom views still deferred to manual UI setup (saved-view filter format isn't public API). |
| 4 | GitHub issue history imported into Linear | **Done** — 110 issues (7 open, 103 closed) imported via Linear's GitHub Issues import assistant after the repo owner completed the GitHub OAuth connection; landed exactly as expected (103 `Done`, 7 `Backlog`). The 7 live issues were further enriched with Project/Priority/Risk/Area/Dependencies from the old GitHub Project's custom fields, which the issue importer can't read. Two (`MOV-113`, `MOV-114`) were flagged to `Needs Human Decision` rather than silently carried forward — both concern governance mechanisms this migration retires. |
| 5 | Linear ↔ GitHub connected (PR linking + Issues Sync) | **Partially done** — GitHub connection is live, and issues sync **one-way (GitHub → Linear only)**, confirmed by direct test (a Linear-side comment never reached GitHub). Two-way sync (Linear → GitHub, needed for "GitHub kept in sync for visibility") is not yet achieved. Tracked as `MOV-115` in Linear — do not consider Stage 5 complete until that resolves. |
| 6 | Governance docs PR (additive) | **Done** |
| 7 | Branch prefix consolidation (`agent/**`, `docs/**`, `chore/**`) | **Done** |
| 8 | Dispatcher scaffold (`tools/dispatcher/`: doctor, dry-run, gc) | **Done** — `run` (live poll loop) deferred pending Stage 1–2 |
| 9 | Ruleset hardening (require PR review + `lane-browser` on `master-protection`) | Not started — deliberately deferred until Stage 1–8 are live, so autonomy isn't enabled before the loop it governs exists |
| 10 | End-to-end verification with a real Linear issue | Not started — depends on 1–9 |
| 11 | Decommission old governance (archive/remove superseded docs, scripts, workflows) | Not started — gated on Stage 10 passing |
| 12 | External decommission (revoke `PROJECT_UPDATE_PAT`, archive GitHub Project) | Not started — gated on Stage 11 |

See `docs/governance/linear-information-architecture.md`, `docs/operators/local-execution.md`, and `docs/operators/worker-routing.md` for the target-state design these stages implement.
