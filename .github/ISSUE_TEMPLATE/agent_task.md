Agent task template

Use this template when creating tasks for Copilot agents.

- Title: short task title
- Background: context and why this change is needed
- Goal / Acceptance criteria: explicit, testable criteria (pass/fail)
- Files to change: list of file paths to inspect or modify
- Tests to run: unit/integration/e2e commands and expected outcomes
- Constraints: (e.g., no secrets, TypeScript strict, keep changes small)
- Branch to start from: (e.g., master)
- Manual verification steps / notes for reviewer
