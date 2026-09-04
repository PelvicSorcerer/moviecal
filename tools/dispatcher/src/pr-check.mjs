// Checks whether a worker successfully opened a PR for its branch.
//
// The worker is contractually responsible for opening its own PR (see
// docs/operators/local-execution.md's worker interface). This is the
// dispatcher's safety-net check after the worker exits 0, not a substitute
// for the worker doing it.

import { execFileSync } from "node:child_process";

export function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

/**
 * @param {string} branch
 * @param {string} repo - "owner/name"
 * @param {(command: string, args: string[]) => string} runner - injectable for tests; defaults to `gh`
 * @returns {{ number: number, url: string, isDraft: boolean } | null}
 */
export function findPrForBranch(branch, repo, runner) {
  const out = runner("gh", [
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    branch,
    "--json",
    "number,url,isDraft",
    "--limit",
    "1",
  ]);
  const parsed = JSON.parse(out);
  if (!parsed || parsed.length === 0) return null;
  const [pr] = parsed;
  return { number: pr.number, url: pr.url, isDraft: pr.isDraft };
}
