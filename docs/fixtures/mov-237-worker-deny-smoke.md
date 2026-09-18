# MOV-237 Worker-Only Permission Denies

This fixture documents [MOV-237](https://linear.app/moviecal/issue/MOV-237/scope-worker-only-permission-denies-out-of-tracked-claudesettingsjson) — verification that Claude's permission denies are supplied by the dispatcher invocation rather than the repository-wide tracked project settings.

The worker transcript records two intentionally prohibited, non-destructive attempts that were successfully denied:

1. `git status` via Bash — denied by worker permission settings
2. `.env.local` Read — denied by worker permission settings

This file is disposable evidence for MOV-237 worker-permission verification and may be removed once MOV-237's acceptance criteria are confirmed.
