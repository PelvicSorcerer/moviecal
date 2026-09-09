// Generates the worker brief handed to a spawned worker on stdin.
//
// Pure function: takes the Linear issue plus routing/worktree metadata and
// returns markdown text. See docs/operators/local-execution.md for the
// worker interface contract this brief exists to satisfy: "given a repo
// path, a branch, and a brief on stdin, produce commits on that branch and
// exit 0."

import { resolveWorkflowEditAuthorization } from "./preflight.mjs";

export function generateBrief(issue, { branch, worktreePath, worker, model, upgradeConditions = [] } = {}) {
  const lines = [];
  lines.push(`# ${issue.identifier}: ${issue.title}`);
  lines.push("");
  lines.push(`Linear issue: ${issue.url}`);
  lines.push(`Assigned branch: \`${branch}\` (already checked out at \`${worktreePath}\`)`);
  lines.push(`Worker: ${worker}${model ? ` (model tier: ${model})` : ""}`);
  if (upgradeConditions.length > 0) {
    lines.push(`Upgrade condition(s) cited: ${upgradeConditions.join(", ")}`);
  }
  lines.push("");
  lines.push("## Instructions");
  lines.push("");
  lines.push(
    "You are a dispatcher-provisioned worker. Read `AGENTS.md`, `docs/operators/local-execution.md`, and `docs/operators/worker-routing.md` first if you have not already loaded them this session.",
  );
  lines.push("");
  lines.push(
    "This Linear issue is your assignment. Implement it fully: read its description and acceptance criteria below, make the change, run the required verification lanes (see `docs/planning/testing-lanes.md`; at minimum `npm run verify`), commit your work on the branch above, push it, and open a **draft** pull request against `master` with `gh pr create --draft` that includes a filled-in **Test Impact** section and a `Linear: " + issue.identifier + "` reference (see `.github/pull_request_template.md`).",
  );
  lines.push("");
  lines.push(
    "**Run verification synchronously.** You are a one-shot invocation — there is no resume, no later turn in which to check on something you backgrounded. Wait for `npm run verify` and any build/test command (including `xcodebuild`, `xcrun simctl`, long-running `npm` scripts) to finish, and act on its actual result, before you exit. Never background a long-running build or test and exit expecting it to keep running or to be resumed — anything still running when you exit is forcibly killed the moment you exit, and any uncommitted work is treated as abandoned.",
  );
  lines.push("");
  lines.push(
    "If you hit a hard-deny action or a case that needs a human decision (see `docs/operators/local-execution.md` §Security model), stop and report the blocker instead of improvising around it — do not attempt to work around a refusal.",
  );
  lines.push("");

  const workflowAuth = resolveWorkflowEditAuthorization(issue);
  if (workflowAuth.authorized) {
    lines.push("## Workflow-edit authorization");
    lines.push("");
    lines.push(
      `A human has reviewed and authorized this issue to change **one specific file**: \`${workflowAuth.path}\`. You cannot edit that path directly — \`Edit(.github/workflows/**)\` is hard-denied for every issue, with no exceptions, and that does not change here.`,
    );
    lines.push("");
    lines.push(
      `Instead: write the **complete new content** of \`${workflowAuth.path}\` to \`tools/dispatcher/pending-workflow-edits/${workflowAuth.path.split("/").pop()}\` (an ordinary, unrestricted path). After you exit, the dispatcher's own trusted orchestration code — not you — copies that content into the real path, removes the staging file, and commits it onto your branch before opening the PR. The resulting PR will still visibly contain the workflow diff, and \`lane-review\` will flag it as requiring explicit human sign-off before merge, same as any other workflow change.`,
    );
    lines.push("");
    lines.push(
      "Do not stage a proposal for any file other than the one named above — the dispatcher will refuse to apply anything else.",
    );
    lines.push("");
  }
  lines.push("## Issue description");
  lines.push("");
  lines.push(issue.description || "_(no description provided)_");
  lines.push("");
  if (issue.labels?.length) {
    lines.push(`## Labels`);
    lines.push("");
    lines.push(issue.labels.map((l) => `\`${l}\``).join(", "));
    lines.push("");
  }
  return lines.join("\n");
}
