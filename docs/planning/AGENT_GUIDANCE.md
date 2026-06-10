# Agent Guidance

This repository requires automated agents and human maintainers to follow strict preflight checks before agents start work. This document codifies those checks and branch/PR conventions. See PR #25 (Reconciled backlog) for related changes.

Mandatory preflight checks
- Issue labeled `agent-ready` and open on GitHub.
- Issue MUST contain an "Acceptance criteria:" section and a "Verification" section (commands or steps to validate the work).
- No secrets in the issue; sensitive setup must be documented separately.
- Assign a milestone and a reviewer for agent-produced PRs.

Branch & PR conventions
- Branch name: `agent/<issue-number>-<short-description>` (e.g., `agent/123-add-feed`).
- Branch must be created from the repository default branch: `master`.
- For docs-only cleanup work that is not tied to a single implementation issue, a focused `docs/<short-description>` branch is acceptable.
- PR title should use scopes like `docs:`, `feat:`, or `fix:` and include a short description.
- PR body must reference the originating issue (e.g., "Fixes #<number>") and include the Acceptance criteria and Verification steps verbatim.

Agent operator checklist
1. Confirm issue labeled `agent-ready`.
2. Confirm Acceptance criteria & Verification present; comment and do not start if missing.
3. Create branch from `master` following naming rules.
4. Open PR, add labels (`docs`, `needs-review`), request review.

Reference: PR #25
