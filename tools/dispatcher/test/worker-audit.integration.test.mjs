import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOnce } from "../src/run-loop.mjs";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { auditWorkerResult, writeWorkerAudit } from "../src/worker-guard.mjs";
import { pullRequestBody } from "../src/worker-publish.mjs";
import { evaluatePrAutonomy } from "../src/pr-autonomy.mjs";

// MOV-400: a real worker process, its real structured transcript, the real
// transcript and diff audit, and the real checksummed audit record. Only Git
// is simulated: the runner reports the fixture checkout's files as dirty, so
// this also runs inside a worker's own sandboxed `npm run verify`.

const ISSUE = {
  id: "id-400", identifier: "MOV-400", title: "Protected-path audit fixture", description: "Fixture only.",
  url: "https://linear.app/moviecal/issue/MOV-400", labels: ["execution:mac"],
  delegate: { id: "dispatcher", name: "moviecal-dispatcher", displayName: "moviecal-dispatcher" },
  blockedByIds: [],
};

// The fixture emits Claude stream-json for each Bash command it runs, runs
// it, and reports the result.
function writeFixture(file, commands) {
  fs.writeFileSync(file, `#!${process.execPath}\n` + String.raw`
const { execSync } = require("node:child_process");
const commands = ${JSON.stringify(commands)};
commands.forEach((command, index) => {
  const id = "tool-" + index;
  process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", id: "m" + index, content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } }) + "\n");
  const output = execSync(command, { cwd: process.cwd(), shell: "/bin/sh", encoding: "utf8" });
  process.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] } }) + "\n");
});
process.stdout.write(JSON.stringify({ type: "result", num_turns: commands.length, duration_ms: 10 }) + "\n");
`, { mode: 0o755 });
}

async function runFixture(commands, { initialFiles = {}, issue = ISSUE } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov400-integration-"));
  const checkout = path.join(root, "checkout");
  const logRoot = path.join(root, "logs");
  fs.mkdirSync(path.join(checkout, "docs", "product"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "AGENTS.md"), "# Agent Workflow Contract\n");
  fs.writeFileSync(path.join(checkout, "docs", "product", "product-brief.md"), "Members can rename a shared list.\n");
  for (const [file, content] of Object.entries(initialFiles)) {
    fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    fs.writeFileSync(path.join(checkout, file), content);
  }
  const baseline = new Set(["AGENTS.md", "docs/product/product-brief.md", ...Object.keys(initialFiles)].map((file) => `${file}:${fs.readFileSync(path.join(checkout, file), "utf8")}`));
  const fixture = path.join(root, "claude");
  writeFixture(fixture, commands);

  let entry;
  const worktreeManager = {
    activeCount: () => 0,
    isPathFreeForIssue: () => true,
    create: vi.fn((args) => {
      entry = { ...args, path: checkout, status: "active", provenance: { executor: "moviecal-dispatcher", repository: "owner/repo" } };
      return entry;
    }),
    markStatus: vi.fn((_id, status) => { entry.status = status; }),
    loadState: () => ({ [issue.identifier]: entry }),
    isDispatcherOwnedWorktree: () => true,
    worktreeIntegrity: () => ({ intact: true, branch: entry.branch }),
    prepareWorkerSpawn: () => {}, setWorkerPid: () => {},
  };
  // Stand-in for `git status`: every file the worker added or changed.
  const changedFiles = () => {
    const files = [];
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else files.push(path.relative(checkout, full));
      }
    };
    walk(checkout);
    return files.filter((file) => !baseline.has(`${file}:${fs.readFileSync(path.join(checkout, file), "utf8")}`));
  };
  const runner = (_command, args) => {
    if (args[0] === "branch") return `${entry.branch}\n`;
    if (args[0] === "diff") return "";
    if (args[0] === "status") return changedFiles().map((file) => `?? ${file}`).join("\n");
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const auditRecords = [];
  const addComment = vi.fn(async () => {});
  let prBody;
  const publishWorkerResultFn = vi.fn(({ issue: publishedIssue, verificationEvidence, humanReviewPaths }) => {
    prBody = pullRequestBody(publishedIssue, verificationEvidence, humanReviewPaths);
    return { number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true };
  });
  try {
    const [result] = await runOnce([issue], {
      linearClient: { moveToState: vi.fn(async () => {}), addComment },
      worktreeManager, publishWorkerResultFn,
      spawnWorkerFn: ({ securityContext: _securityContext, ...args }) => spawnWorker({ ...args, invocation: { command: fixture, args: [] }, spawnImpl: (...values) => spawn(...values), killGraceMs: 10 }),
      stateIds: { agentWorking: "working", needsHumanDecision: "human", inReview: "review" },
      concurrencyLimit: 1, iosRunnerOnline: true, secretPresent: () => true,
      worktreeRoot: root, ghRepo: "owner/repo", logRoot, workerTimeoutMs: 10000,
      dispatcherDelegate: { id: "dispatcher", name: "moviecal-dispatcher" },
      refreshIssueFn: async () => issue,
      repositoryContextFn: () => ({ changedPaths: [] }),
      diffSummaryFn: () => "fixture diff",
      uncommittedChangesFn: () => changedFiles(),
      auditWorkerResultFn: (args) => auditWorkerResult({ ...args, runner }),
      writeWorkerAuditFn: (logDir, report) => {
        const record = writeWorkerAudit(logDir, report);
        auditRecords.push(JSON.parse(fs.readFileSync(record.path, "utf8")));
        return record;
      },
      captureVerificationEvidenceFn: () => ({ status: "passed" }),
      captureWorkerUsageFn: () => null,
    });
    return { result, auditRecords, comments: addComment.mock.calls.map(([, body]) => body), publishWorkerResultFn, prBody };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("worker audit for protected paths (MOV-400)", () => {
  it("publishes, with a recorded and listed warning, when a protected path is named but unchanged", async () => {
    const { result, auditRecords, comments, publishWorkerResultFn } = await runFixture([
      "wc -l AGENTS.md docs/product/product-brief.md",
      'for f in AGENTS.md docs/product/product-brief.md; do grep -n -i "rename" "$f" || true; done',
      "mkdir -p src && echo 'export const x = 1;' > src/feature.ts",
    ]);

    expect(result.outcome).toBe("in-review");
    expect(publishWorkerResultFn).toHaveBeenCalledTimes(1);
    const [record] = auditRecords;
    expect(record).toMatchObject({ ok: true, violations: [], dirty: ["src/feature.ts"] });
    expect(record.warnings).toEqual([
      expect.objectContaining({ action: "wc -l AGENTS.md docs/product/product-brief.md", reason: "names protected path AGENTS.md without writing it", verdict: "warn", outcome: "executed" }),
      expect.objectContaining({ reason: "names protected path AGENTS.md without writing it", verdict: "warn", outcome: "executed" }),
    ]);
    const warning = comments.find((body) => body.includes("Worker audit warning; no protected path changed"));
    expect(warning).toContain("names protected path AGENTS.md without writing it: `wc -l AGENTS.md docs/product/product-brief.md`");
  }, 15000);

  it("blocks publication when a protected path changed, even through a write the command audit cannot see", async () => {
    const { result, auditRecords, comments, publishWorkerResultFn } = await runFixture([
      "wc -l AGENTS.md",
      `node -e 'require("fs").appendFileSync("AGENTS.md", "rewritten\\n")'`,
    ]);

    expect(result.outcome).toBe("security-blocked");
    expect(publishWorkerResultFn).not.toHaveBeenCalled();
    const [record] = auditRecords;
    expect(record.ok).toBe(false);
    // The command audit saw only a mention and an inline script; the diff is
    // what blocks.
    expect(record.warnings).toEqual([expect.objectContaining({ action: "wc -l AGENTS.md", verdict: "warn" })]);
    expect(record.violations).toEqual([{ action: "AGENTS.md", reason: "protected implementation path changed" }]);
    expect(comments.some((body) => body.includes("Worker safety boundary blocked publication") && body.includes("protected implementation path changed: `AGENTS.md`"))).toBe(true);
  }, 15000);
});

describe("worker diff review handoff (MOV-399)", () => {
  const issue = {
    ...ISSUE, id: "id-399", identifier: "MOV-399", title: "Migration/auth review fixture",
    labels: ["agent-ready", "risk:low", "execution:mac"],
    description: "## Manual Verification\nHuman testing: not-required\nRationale: deterministic fixture.\nAutonomy: eligible",
  };

  it.each([
    "supabase/migrations/fixture.sql",
    "src/app/auth/sign-in/route.ts",
    "src/lib/auth/session.ts",
    "src/app/settings/calendar/actions.ts",
    "src/app/api/calendar/[token]/route.ts",
    "src/app/api/v1/calendar-token/route.ts",
    "src/lib/supabase/calendar-tokens.ts",
  ])("publishes the actual %s diff with review required and autonomy disabled", async (file) => {
    const { result, auditRecords, comments, publishWorkerResultFn, prBody } = await runFixture([
      `cat '${file}'`,
      `cat > '${file}' <<'EOF'\nupdated fixture\nEOF`,
    ], { initialFiles: { [file]: "initial fixture\n" }, issue });

    expect(result.outcome).toBe("in-review");
    expect(auditRecords[0]).toMatchObject({ ok: true, violations: [], warnings: [], humanReviewPaths: [file] });
    expect(publishWorkerResultFn).toHaveBeenCalledWith(expect.objectContaining({ humanReviewPaths: [file] }));
    expect(prBody).toContain(`Migration or auth/calendar-token change requires human review: \`${file}\``);
    expect(prBody).toContain("Autonomy: disabled");
    expect(prBody).toContain("sensitive-path-ack");
    expect(comments.some((body) => body.includes(file) && body.includes("not eligible for PR autonomy"))).toBe(true);
    expect(evaluatePrAutonomy({ issue, observation: {
      state: "OPEN", isDraft: true, headSha: "fixture-sha", headBranch: `agent/${issue.identifier}-fixture`,
      headRepository: "owner/repo", body: prBody, changedFiles: [file],
    }, repo: "owner/repo", enabled: true })).toMatchObject({ eligible: false });
  }, 15000);

  it("allows migration/auth reads without requiring review of an unrelated diff", async () => {
    const { result, auditRecords, comments, prBody } = await runFixture([
      "cat supabase/migrations/fixture.sql src/lib/auth/session.ts",
      "mkdir -p src && echo 'export const x = 1;' > src/feature.ts",
    ], { initialFiles: { "supabase/migrations/fixture.sql": "select 1;\n", "src/lib/auth/session.ts": "export {};\n" }, issue });

    expect(result.outcome).toBe("in-review");
    expect(auditRecords[0]).toMatchObject({ ok: true, violations: [], warnings: [], humanReviewPaths: [] });
    expect(prBody).toContain("Autonomy: eligible");
    expect(prBody).not.toContain("## Human Review Required");
    expect(comments.some((body) => body.includes("needs human review"))).toBe(false);
  }, 15000);
});
