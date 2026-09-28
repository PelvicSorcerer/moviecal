// Finds the PR created (or reused) by the trusted dispatcher publisher after
// an audited worker exits. Workers themselves have no GitHub authority.

import { execFileSync } from "node:child_process";

export function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

/**
 * @param {string} branch
 * @param {string} repo - "owner/name"
 * @param {(command: string, args: string[]) => string} runner - injectable for tests; defaults to `gh`
 * @returns {{ number: number, url: string, isDraft: boolean, headSha: string|null } | null}
 */
export function findPrForBranch(branch, repo, runner = defaultRunner, { state = "open" } = {}) {
  const out = runner("gh", [
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    branch,
    ...(state === "all" ? ["--state", "all"] : []),
    "--json",
    "number,url,isDraft,headRefOid",
    "--limit",
    "1",
  ]);
  const parsed = JSON.parse(out);
  if (!parsed || parsed.length === 0) return null;
  const [pr] = parsed;
  return { number: pr.number, url: pr.url, isDraft: pr.isDraft, headSha: pr.headRefOid || null };
}

export function findAnyPrForBranch(branch, repo, runner = defaultRunner) {
  return findPrForBranch(branch, repo, runner, { state: "all" });
}
