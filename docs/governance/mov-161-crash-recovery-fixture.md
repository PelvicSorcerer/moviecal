# MOV-249: MOV-161 crash + restart recovery fixture

This file is a disposable acceptance artifact for
[MOV-161](https://linear.app/moviecal/issue/MOV-161/run-local-autonomous-workflow-acceptance-and-recovery-drills).
It exists solely to give the dispatcher a worker attempt to kill mid-task so
the startup-reconciliation sweep (`WorktreeManager.reconcileStartup()`) can be
exercised. It carries no product meaning and may be deleted once the
MOV-161 crash + restart recovery drill is recorded.
