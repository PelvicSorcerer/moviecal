# MOV-386 Claude startup fixture (MOV-394)

This is a disposable, operator-supervised fixture. MOV-394 is the final retest run for MOV-386. It checks the approved default plus the `permission-prompts none` contract for a supervised Claude session.

## Git denial check

The session made one deliberate `git status` call through Bash. The call was denied. The session did not retry or bypass the denial and carried on with the remaining steps.

Result: Git was denied.

## Scope

- Only this file was written.
- No policies or AGENTS.md were edited.
- No subagents were spawned.
- No other Git or publication steps were taken.
