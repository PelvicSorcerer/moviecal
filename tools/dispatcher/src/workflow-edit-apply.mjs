// Applies a worker's staged workflow-edit proposal into the real
// .github/workflows/ path, deterministically, via the dispatcher's own
// trusted orchestration code -- never the worker itself.
//
// See MOV-121 and docs/operators/local-execution.md §Security model. The
// worker's own Edit(.github/workflows/**) hard-deny is never lifted; it
// instead writes the full proposed file content to
// tools/dispatcher/pending-workflow-edits/<filename> (an ordinary,
// unrestricted path), and this module -- called by run-loop.mjs after the
// worker exits successfully, and only when resolveWorkflowEditAuthorization()
// has already confirmed exactly one authorized path -- moves that content
// into place and commits it onto the worker's own branch. The resulting PR
// still visibly contains the workflow diff; lane-review's existing
// sensitive-path heuristic still flags it as requiring human sign-off before
// merge, same as any other change touching .github/workflows/**.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

/**
 * @param {string} worktreePath
 * @param {string} authorizedPath - e.g. ".github/workflows/ios-verify.yml", from resolveWorkflowEditAuthorization()
 * @param {object} [deps]
 * @param {typeof fs} [deps.fsImpl] - injectable for tests
 * @param {(command: string, args: string[], opts?: object) => string} [deps.runner] - injectable for tests; defaults to real git
 * @returns {{ applied: boolean, path?: string, reason?: string }}
 */
export function applyStagedWorkflowEdit(worktreePath, authorizedPath, { fsImpl = fs, runner = defaultRunner } = {}) {
  const filename = authorizedPath.split("/").pop();
  const stagedRelPath = path.join("tools", "dispatcher", "pending-workflow-edits", filename);
  const stagedAbsPath = path.join(worktreePath, stagedRelPath);

  if (!fsImpl.existsSync(stagedAbsPath)) {
    return { applied: false, reason: "no staged proposal found" };
  }

  const content = fsImpl.readFileSync(stagedAbsPath, "utf8");
  const targetAbsPath = path.join(worktreePath, authorizedPath);
  fsImpl.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
  fsImpl.writeFileSync(targetAbsPath, content);

  runner("git", ["rm", "--quiet", stagedRelPath], { cwd: worktreePath });
  runner("git", ["add", authorizedPath], { cwd: worktreePath });
  runner(
    "git",
    [
      "commit",
      "-m",
      `chore: apply staged workflow-edit proposal for ${authorizedPath}\n\nApplied deterministically by the dispatcher, not the worker -- see docs/operators/local-execution.md §Security model, MOV-121.`,
    ],
    { cwd: worktreePath },
  );
  runner("git", ["push"], { cwd: worktreePath });

  return { applied: true, path: authorizedPath };
}
