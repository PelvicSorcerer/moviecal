# pending-workflow-edits/

Staging area for `.github/workflows/**` proposals from an authorized worker.
See `docs/operators/local-execution.md` §Security model ("Staged
workflow-edit proposals") and MOV-121.

`Edit(.github/workflows/**)` is hard-denied for every worker, unconditionally
— that never changes. When an issue is labeled `ci:workflow-edit-authorized`
and its description declares exactly one `Workflow-edit: <path>` marker, the
worker's brief instructs it to write the **full proposed content** of that
one file here instead, under its real filename (e.g.
`pending-workflow-edits/ios-verify.yml`). After the worker exits successfully,
`tools/dispatcher/src/workflow-edit-apply.mjs` — the dispatcher's own trusted
orchestration code, never the Claude-harness-gated worker — copies that
content into the real path, removes the staged file, and commits the result
onto the worker's branch before the PR is checked for. The resulting diff
still visibly touches `.github/workflows/**`, so `lane-review`'s existing
sensitive-path heuristic still flags it as requiring explicit human sign-off
before merge.

This directory should be empty between runs — a file left here after a run
means the apply step didn't fire (check the worker's exit code and the
dispatcher's run log first).
