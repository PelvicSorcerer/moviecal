import { describe, expect, it } from "vitest";
import { inspectOperatorResume, parseResumeArgs } from "../src/operator-resume.mjs";
import { generateBrief } from "../src/brief.mjs";
import { publishWorkerResult } from "../src/worker-publish.mjs";
import { runOperatorResume } from "../src/run-loop.mjs";

const id = "MOV-123";
const branch = "agent/MOV-123-example";
const worktreePath = "/tmp/resume-fixture/MOV-123-example";

function fixture(overrides = {}) {
  const issue = {
    id: "linear-uuid", identifier: id, title: "Example", url: "https://linear.app/moviecal/issue/MOV-123/example",
    description: "## Acceptance criteria\n- [ ] Finish\n\n## Testing Expectations\nUnit and integration required.",
    stateName: "Needs Human Decision", labels: ["execution:mac", "worker:codex", "model:strong", "upgrade:security-critical"],
    delegate: { name: "moviecal-dispatcher" }, blockedByIds: [], inverseRelations: [],
    recentComments: ["**Worker timed out after 2700000ms and was killed.**"],
    ...overrides.issue,
  };
  const entry = {
    id, name: "MOV-123-example", path: worktreePath, branch, status: "failed",
    linearIssueId: issue.id, linearUrl: issue.url, worker: "codex", model: "strong",
    provenance: { executor: "moviecal-dispatcher", repository: "PelvicSorcerer/moviecal" },
    ...overrides.entry,
  };
  const registry = { [id]: entry };
  const ctx = {
    worktreeRoot: "/tmp/resume-fixture", logRoot: "/tmp/resume-logs", ghRepo: "PelvicSorcerer/moviecal",
    dispatcherDelegate: { name: "moviecal-dispatcher" }, iosRunnerOnline: true,
    concurrencyLimit: 1, secretPresent: () => true, issueSpecMode: "off", steeringEnabled: false,
    worktreeManager: {
      loadState: () => registry, ownershipMarker: () => ({ id }),
      worktreeIntegrity: () => ({ intact: true, branch }), isIntactLinkedWorktree: () => true,
      worktreeBelongsToRepository: () => true,
      activeCount: () => 0,
    },
    workerCooldownStore: { state: () => ({ cooling: false, probeOwed: false }) },
    circuitBreaker: { status: (name) => ({ name, open: false }) },
    ...overrides.ctx,
  };
  const calls = [];
  const gitRunner = (_cmd, args) => {
    calls.push(args.join(" "));
    if (args.includes("status")) return " M src/example.ts\n?? src/new.ts\n";
    if (args.includes("rev-list")) return "1\n";
    if (args.includes("diff")) return " src/example.ts | 2 ++\n";
    throw new Error("unexpected Git read");
  };
  return { issue, entry, ctx, calls, inspect: () => inspectOperatorResume(issue, ctx,
    { gitRunner, findPrFn: () => null, processAliveFn: () => false, pathIsRealFn: () => true }) };
}

describe("operator resume parsing and admission", () => {
  it("requires one explicit issue and only the preview flag", () => {
    expect(parseResumeArgs([id, "--dry-run"])).toEqual({ issueId: id, dryRun: true });
    expect(parseResumeArgs([id])).toEqual({ issueId: id, dryRun: false });
    for (const args of [[], ["MOV-0"], ["123"], [id, "--force"], [id, "--dry-run", "extra"]]) {
      expect(() => parseResumeArgs(args)).toThrow();
    }
  });

  it("previews retained edits and commits without changing the registry", () => {
    const fixtureData = fixture();
    const before = JSON.stringify(fixtureData.ctx.worktreeManager.loadState());
    const result = fixtureData.inspect();
    expect(result.admitted).toBe(true);
    expect(result.retained).toMatchObject({ branch, path: worktreePath, worker: "codex" });
    expect(result.changedPaths).toEqual(["src/example.ts", "src/new.ts"]);
    expect(result.unpublishedCommits).toBe(1);
    expect(fixtureData.calls).toContain("--no-optional-locks status --porcelain=v1 -uall");
    expect(JSON.stringify(fixtureData.ctx.worktreeManager.loadState())).toBe(before);
  });

  it("reads unpublished work when a failed entry retains its exited worker PID", () => {
    const data = fixture({ entry: { workerPid: 2222 } });
    const result = data.inspect();
    expect(result.admitted).toBe(true);
    expect(result.changedPaths).toEqual(["src/example.ts", "src/new.ts"]);
    expect(result.unpublishedCommits).toBe(1);
    // Historical process provenance remains intact during preview.
    expect(data.entry.workerPid).toBe(2222);
  });

  it.each([
    [{ issue: { stateName: "In Review" } }, "issue state"],
    [{ issue: { labels: ["execution:mac", "human-only", "worker:codex"] } }, "human-only"],
    [{ issue: { delegate: { name: "someone-else" } } }, "delegated"],
    [{ issue: { blockedByIds: ["blocker"] } }, "blocked by unresolved"],
    [{ issue: { recentComments: ["RLS policy requires a product decision"] } }, "substantive human decision"],
    [{ entry: { linearIssueId: "foreign" } }, "provenance"],
    [{ entry: { branch: "agent/MOV-999-example" } }, "namespace"],
    [{ entry: { name: "MOV-123-example/../../foreign", path: "/tmp/foreign" } }, "exact dispatcher-owned"],
    [{ entry: { workerSpawnPending: true } }, "spawn is pending"],
    [{ entry: { operatorResume: { attemptId: "spent" } } }, "already claimed"],
    [{ ctx: { worktreeManager: { loadState: () => ({ [id]: fixture().entry }), ownershipMarker: () => null,
      worktreeIntegrity: () => ({ intact: true, branch }), isIntactLinkedWorktree: () => true,
      worktreeBelongsToRepository: () => true, activeCount: () => 0 } } }, "dispatcher-owned"],
  ])("refuses unsafe target %j", (overrides, reason) => {
    const result = fixture(overrides).inspect();
    expect(result.admitted).toBe(false);
    expect(result.reasons.join(" ")).toMatch(new RegExp(reason, "i"));
  });

  it("refuses a conflicting explicit worker pin and an existing PR", () => {
    const conflict = fixture({ issue: { labels: ["execution:mac", "worker:claude"] } }).inspect();
    expect(conflict.reasons.join(" ")).toMatch(/conflicts with recorded codex binding/);
    const data = fixture();
    const result = inspectOperatorResume(data.issue, data.ctx, {
      gitRunner: (_cmd, args) => args.includes("rev-list") ? "1" : args.includes("status") ? " M x\n" : " x | 1 +",
      findPrFn: () => ({ number: 1 }), processAliveFn: () => false,
      pathIsRealFn: () => true,
    });
    expect(result.reasons.join(" ")).toMatch(/already has a PR/);
  });

  it("refuses a detached checkout, live worker, and changed repository identity", () => {
    const detached = fixture();
    detached.ctx.worktreeManager.worktreeIntegrity = () => ({ intact: false, branch: null, reason: "detached HEAD" });
    expect(detached.inspect().reasons.join(" ")).toMatch(/detached HEAD/);
    const foreign = fixture();
    foreign.ctx.worktreeManager.worktreeBelongsToRepository = () => false;
    expect(foreign.inspect().reasons.join(" ")).toMatch(/Git common directory/);
    const active = fixture({ entry: { workerPid: 2222 } });
    const result = inspectOperatorResume(active.issue, active.ctx, {
      gitRunner: (_cmd, args) => args.includes("rev-list") ? "1" : args.includes("status") ? " M x\n" : " x | 1 +",
      findPrFn: () => null, pathIsRealFn: () => true, processAliveFn: () => true,
    });
    expect(result.reasons.join(" ")).toMatch(/live or orphan worker PID/);
  });

  it("keeps a substantive RLS hold even when a technical failure is mentioned", () => {
    const result = fixture({ issue: { recentComments: ["Worker timed out, but the RLS policy decision requires human approval."] } }).inspect();
    expect(result.admitted).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/substantive human decision/);
  });

  it("retains quota, breaker, and model-tier gates", () => {
    const model = fixture({ issue: { labels: ["execution:mac", "worker:codex", "model:default"] } }).inspect();
    expect(model.reasons.join(" ")).toMatch(/model tier/);
    const cooldown = fixture({ ctx: { workerCooldownStore: { state: () => ({ cooling: true, resetAt: "2026-10-01T00:00:00Z" }) } } }).inspect();
    expect(cooldown.reasons.join(" ")).toMatch(/provider cooldown/);
    const breaker = fixture({ ctx: { circuitBreaker: { status: (name) => ({ name, open: true }) } } }).inspect();
    expect(breaker.reasons.join(" ")).toMatch(/dispatch breaker/);
  });

  it("brief tells the worker to continue and reverify the current issue", () => {
    const result = fixture().inspect();
    const brief = generateBrief(fixture().issue, {
      branch, worktreePath, worker: "codex", model: "strong",
      operatorResume: { attemptId: "one", prior: result.prior, changedPaths: result.changedPaths, unpublishedCommits: 1 },
    });
    expect(brief).toContain("Review the existing staged, unstaged, untracked, and committed changes");
    expect(brief).toContain("## Testing Expectations");
    expect(brief).toContain("literal `npm run verify`");
    expect(brief).toContain("Prior diff summary");
  });

  it("publishes a clean retained unpublished commit without creating an empty commit", () => {
    let created = false;
    const commands = [];
    const runner = (command, args) => {
      commands.push([command, ...args].join(" "));
      if (command === "gh") {
        if (args[1] === "list") return created
          ? JSON.stringify([{ number: 3, url: "https://github.example/pr/3", isDraft: true }]) : "[]";
        if (args[1] === "create") { created = true; return ""; }
      }
      if (args[0] === "branch") return branch;
      if (args[0] === "status") return "";
      if (args[0] === "rev-list") return "1";
      if (args[0] === "push") return "";
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const pr = publishWorkerResult({ worktreePath, branch, repo: "PelvicSorcerer/moviecal",
      issue: fixture().issue, allowExistingCommits: true, requireNewPr: true, runner });
    expect(pr.number).toBe(3);
    expect(commands.some((command) => command.startsWith("git commit"))).toBe(false);
    expect(commands.some((command) => command.includes("--state all"))).toBe(true);
  });

  it("spends one authorization before spawn and refuses a duplicate after failure", async () => {
    const data = fixture();
    const inspection = data.inspect();
    let entry = { ...data.entry };
    const writes = [];
    data.ctx.worktreeManager = {
      loadState: () => ({ [id]: entry }),
      updateEntry: (_id, extra) => { entry = { ...entry, ...extra }; return entry; },
      resumeEntry: () => { entry = { ...entry, status: "active" }; return entry; },
      markStatus: (_id, status) => { entry = { ...entry, status }; return entry; },
      markStatusIf: (_id, expected, status) => {
        if (entry.status === expected) entry = { ...entry, status };
        return entry;
      },
      prepareWorkerSpawn: () => { writes.push("spawn-pending"); },
    };
    Object.assign(data.ctx, {
      lockHeldFn: () => true,
      linearClient: { moveToState: async (_id, state) => { writes.push(state); },
        addComment: async () => { writes.push("comment"); } },
      stateIds: { agentWorking: "working", needsHumanDecision: "decision" },
      repositoryContextFn: () => null, refreshIssueFn: async () => data.issue,
      spawnWorkerFn: () => { expect(entry.operatorResume.status).toBe("claimed"); throw new Error("fixture spawn refusal"); },
      writeWorkerAuditFn: () => ({ path: "fixture-audit" }),
      workerTimeoutMs: 1000, stopPollIntervalMs: 0,
    });
    const result = await runOperatorResume(data.issue, inspection, data.ctx);
    expect(result.outcome).toBe("spawn-error");
    expect(entry.status).toBe("failed");
    expect(entry.operatorResume).toMatchObject({ status: "finished", outcome: "spawn-error" });
    expect(entry.operatorResumeHistory).toHaveLength(1);
    expect(writes).toContain("decision");
    await expect(runOperatorResume(data.issue, inspection, data.ctx)).rejects.toThrow(/target changed/);
    data.ctx.lockHeldFn = () => false;
    await expect(runOperatorResume(data.issue, inspection, data.ctx)).rejects.toThrow(/singleton lock/);
  });
});
