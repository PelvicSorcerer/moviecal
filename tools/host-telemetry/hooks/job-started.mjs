#!/usr/bin/env node
// GitHub runner ACTIONS_RUNNER_HOOK_JOB_STARTED hook. Always exits 0: a
// telemetry problem must never fail the CI job. MOV-495.
import { runHook } from "../src/runner-hook.mjs";

await runHook("job-started");
process.exitCode = 0;
