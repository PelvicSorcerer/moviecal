## Summary

<!-- What changed and why. Link the originating issue when one exists (for example Closes #NNN). -->

**Linear:** <!-- Required closing reference, e.g. "Fixes MOV-NNN" (Closes/Resolves also work). Use an actual Linear-recognized closing keyword, not a bare "MOV-NNN" -- a bare identifier does not trigger Linear's GitHub-integration sync, so the issue would never auto-close on merge. Leave as "N/A" only for a GitHub-originated external bug/feature-request PR with no corresponding Linear issue yet. -->

## Test Impact

<!-- Required for every PR. State what automated tests changed, or explain why no test changes were needed. -->

- [ ] Added or updated unit tests
- [ ] Added or updated integration tests
- [ ] Added or updated browser E2E tests
- [ ] No test changes needed because: <!-- brief reason, e.g. docs-only, refactor with existing coverage -->

**Deferred coverage:** <!-- If any planned automated coverage is not in this PR, link the concrete follow-up issue (for example #NNN). Remove this line if nothing is deferred. -->

## Verification

<!-- Commands run and their results. At minimum: `npm run verify` for code changes. -->

- [ ] `npm run verify`
- [ ] If `ios/**` changed: `xcodebuild test` passed locally; new or changed snapshot references were reviewed and committed
- [ ] Other: <!-- e.g. manual checklist, db:lint, e2e -->

## Readiness Evidence

Human testing: <!-- required | not-required; must match the Linear issue -->

Autonomy: <!-- eligible | disabled (leave disabled unless the Linear issue is explicitly low-risk, execution:mac, agent-ready, and risk:low) -->

- Local-agent evidence: <!-- exact command/procedure, result, and artifact path/link; or "none" -->
- Human tester and date: <!-- required when human testing is required; otherwise "N/A" -->
- Checklist result: <!-- pass/fail plus notes; or "N/A — not-required" -->
- No-human-testing rationale: <!-- required when not-required; confirm all acceptance criteria are covered and no mandatory human gate applies -->
- Ready promoted by: <!-- authorized human reviewer and date; workers/dispatcher must leave this blank while the PR is draft -->

## Security notes

<!-- Required for auth, database, calendar feeds, cron, tokens, or secrets work. Remove if not applicable. -->
