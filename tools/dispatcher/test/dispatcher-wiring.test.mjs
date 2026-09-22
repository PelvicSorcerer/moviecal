import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// bin/dispatcher.mjs calls main() at module load, so it can't be imported for
// unit testing. These are structural guards on the wiring that the promoter
// (MOV-129) depends on: a promote pass must run every cycle, before the
// dispatch scan reads "Ready for Agent", and it must not be able to abort
// dispatch.
const source = readFileSync(
  fileURLToPath(new URL("../bin/dispatcher.mjs", import.meta.url)),
  "utf8",
);

function bodyOf(fnName, text = source) {
  const start = text.indexOf(`async function ${fnName}(`);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  // crude brace match from the function body's "{", not any default-object "{"
  const sigClose = text.indexOf(")", start);
  const open = text.indexOf("{", sigClose);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error(`could not find end of ${fnName}`);
}

// buildRunContext, checkIosRunnerOnline, and the Agent Session entitlement
// latch moved out of bin/dispatcher.mjs into src/run-context.mjs (MOV-197) so
// they are importable for a dynamic test without triggering bin/dispatcher.mjs's
// module-load main() call. See run-loop-e2e.test.mjs.
const runContextSource = readFileSync(
  fileURLToPath(new URL("../src/run-context.mjs", import.meta.url)),
  "utf8",
);

describe("dispatcher run-loop wiring (MOV-129/MOV-366)", () => {
  it("cmdRunOnce awaits reconcile -> propagate -> promote before reading Ready for Agent", () => {
    const body = bodyOf("cmdRunOnce");
    const ghAuthAt = body.indexOf("checkGithubCliAuth()");
    const reconcileAt = body.indexOf("await reconcileWorktrees(");
    const propagateAt = body.indexOf("await propagatePass(");
    const promoteAt = body.indexOf("await promotePass(");
    const dispatchReadAt = body.indexOf("issuesInState(");
    expect(ghAuthAt, "GitHub CLI auth gate missing from cmdRunOnce").toBeGreaterThan(-1);
    expect(reconcileAt, "reconcileWorktrees() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(propagateAt, "propagatePass() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(promoteAt, "promotePass() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(dispatchReadAt, "issuesInState() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(ghAuthAt).toBeLessThan(reconcileAt);
    expect(reconcileAt).toBeLessThan(propagateAt);
    expect(propagateAt).toBeLessThan(promoteAt);
    expect(promoteAt).toBeLessThan(dispatchReadAt);
    expect(body).toMatch(/await\s+reconcileWorktrees\(/);
    expect(body).toMatch(/await\s+propagatePass\(\)/);
    expect(body).toMatch(/await\s+promotePass\(\)/);
  });

  it("runs the bounded repair pass before returning for an empty dispatch queue (MOV-190)", () => {
    const body = bodyOf("cmdRunOnce");
    const repairAt = body.indexOf("await runRepairPass(ctx)");
    const emptyQueueAt = body.indexOf("if (issues.length === 0)");
    const dispatchAt = body.indexOf("await runOnce(issues, ctx)");
    expect(repairAt, "runRepairPass() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(emptyQueueAt, "empty queue return not found").toBeGreaterThan(-1);
    expect(dispatchAt, "runOnce() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(repairAt).toBeLessThan(emptyQueueAt);
    expect(emptyQueueAt).toBeLessThan(dispatchAt);
  });

  it("keeps review CI observation polling while an implementation worker is awaited (MOV-298)", () => {
    const run = bodyOf("cmdRun");
    expect(run).toMatch(/const reviewCiMonitor = setInterval/);
    expect(run).toMatch(/await reportReviewCi\(built\.client, built\.teamKey\)/);
    expect(run).toMatch(/observation-only/);
  });

  it("passes the held dispatcher lock into the live repair pass (MOV-191)", () => {
    const once = bodyOf("cmdRunOnce");
    const run = bodyOf("cmdRun");
    expect(once).toMatch(/buildRunContext\(linearClient, teamKey, issues, \{ repairLockHeld \}\)/);
    expect(run).toMatch(/cmdRunOnce\(\{ repairLockHeld: lock\.owned \}\)/);
  });

  it("exposes a read-only repair preview but no standalone live repair command (MOV-191)", () => {
    const repair = bodyOf("cmdRepair");
    expect(repair).toMatch(/if \(!dryRun\)/);
    expect(repair).toMatch(/previewRepairPass/);
    expect(repair).not.toMatch(/runRepairPass/);
  });

  it("promotePass swallows errors so a promote failure cannot abort dispatch", () => {
    const body = bodyOf("promotePass");
    expect(body).toMatch(/try\s*\{/);
    expect(body).toMatch(/catch/);
    expect(body).toMatch(/cmdPromoteOnce/);
  });

  it("propagatePass swallows errors so a propagation failure cannot abort dispatch", () => {
    const body = bodyOf("propagatePass");
    expect(body).toMatch(/try\s*\{/);
    expect(body).toMatch(/catch/);
    expect(body).toMatch(/cmdPrioritiesOnce/);
  });

  it("standalone priorities command acquires the dispatcher lock for mutating runs", () => {
    const body = bodyOf("cmdPriorities");
    expect(body).toMatch(/if\s*\(dryRun\)\s*return\s+cmdPrioritiesOnce/);
    expect(body).toMatch(/new DispatcherLock\(dispatcherLockPath\(\)\)/);
    expect(body).toMatch(/lock\.acquire\(\)/);
    expect(body).toMatch(/cmdPrioritiesOnce\(\{\s*dryRun:\s*false\s*\}\)/);
    expect(body).toMatch(/finally\s*\{\s*lock\.release\(\)/);
  });

  // Every other guard in this file is a regex over source text, which a
  // syntax error sails straight past -- and bin/dispatcher.mjs is the one
  // dispatcher file nothing can import (it calls main() at module load), so
  // nothing else would catch one either until the daemon next restarted.
  it("bin/dispatcher.mjs actually parses", () => {
    const entry = fileURLToPath(new URL("../bin/dispatcher.mjs", import.meta.url));
    expect(() => execFileSync(process.execPath, ["--check", entry], { encoding: "utf8" })).not.toThrow();
  });

  it("logs a real path/branch for a reconcileStartup() orphan-sweep change, not a bare c.id (MOV-199)", () => {
    // reconcileStartup() returns two change shapes: a state-entry recovery
    // ({id, from, to, reason}) and an orphan-sweep outcome ({path, branch,
    // from, to, reason}) -- the latter has no `id` at all. Logging `${c.id}`
    // unconditionally silently printed "undefined" for every orphan-sweep
    // event ever logged. This guards the fallback that fixed it.
    const body = bodyOf("reconcileWorktrees");
    expect(body).not.toMatch(/console\.log\(`\$\{c\.id\}: startup recovery/);
    expect(body).toMatch(/c\.id\s*\?\?\s*`\$\{c\.path\}/);
  });
});

// MOV-158's hardest boundary is a negative one: the Agent Session integration
// must not have quietly acquired an inbound listener or a new secret. That is
// exactly the kind of constraint that erodes through later well-meaning edits,
// so it is asserted structurally rather than left to review.
describe("no inbound listener or new secret (MOV-158 / MOV-141 / MOV-159)", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const dispatcherSources = [
    ...readdirSync(srcDir)
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => [path.join("src", f), readFileSync(path.join(srcDir, f), "utf8")]),
    ["bin/dispatcher.mjs", source],
  ];

  it("opens no server, socket, or port anywhere in the dispatcher", () => {
    // The local Mac must not expose an inbound endpoint. Enabling Agent
    // Sessions needs a reachable HTTPS receiver; MOV-159 is the decision gate
    // for whether a signed relay is worth its attack surface, and MOV-158
    // deliberately does not build one.
    const listenerPatterns = [
      /createServer\s*\(/,
      /\.listen\s*\(/,
      /require\(["']express["']\)/,
      /from\s+["']express["']/,
      /from\s+["']node:(http|https|net|tls|dgram)["']/,
      /from\s+["']ws["']/,
    ];
    for (const [name, text] of dispatcherSources) {
      for (const pattern of listenerPatterns) {
        expect(pattern.test(text), `${name} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("reads no new credential: the only config files are the ones that already existed", () => {
    // MOV-158 must not add a secret. `verifyWebhookSignature` takes a secret as
    // an argument and fails closed without one; nothing resolves one from disk
    // or the environment.
    const configText = readFileSync(fileURLToPath(new URL("../src/config.mjs", import.meta.url)), "utf8");
    const secretPathHelpers = [...configText.matchAll(/^export function (\w*(?:EnvPath|Path))\(/gm)].map((m) => m[1]);
    expect(secretPathHelpers.sort()).toEqual([
      // MOV-166: the Mac's own outbound-stream credential to the Agent
      // Session receiver -- authorized by MOV-159/MOV-166, unlike the
      // webhook signing secret, which is receiver-side only and never named
      // in dispatcher source (see the assertion below).
      "agentSessionEnvPath",
      "circuitBreakerStatePath",
      "dispatcherLaunchHealthStatePath",
      "dispatcherLockPath",
      "envLocalPath",
      "linearAppEnvPath",
      "linearEnvPath",
      "prAutonomyLedgerStatePath",
      "priorityPropagationStatePath",
      // MOV-189: dispatcher state, not a credential — it preserves the
      // automatic-repair budget across a restart.
      "repairLedgerStatePath",
      "usageLimitStatePath",
      "worktreesStatePath",
    ]);
    for (const [name, text] of dispatcherSources) {
      // MOV-166: the receiver's webhook signing secret is verified on Vercel,
      // never here -- it must never be named or parsed by dispatcher source,
      // even though the Mac's own stream credential now legitimately is.
      expect(/WEBHOOK_SECRET|AGENT_SESSION_SECRET|SIGNING_SECRET/.test(text), name).toBe(false);
    }
  });

  it("keeps the Agent Session layer off unless explicitly switched on", () => {
    const configText = readFileSync(fileURLToPath(new URL("../src/config.mjs", import.meta.url)), "utf8");
    expect(configText).toMatch(/MOVIECAL_AGENT_SESSIONS/);
    // An unset variable must read as off, never as on.
    expect(runContextSource).toMatch(/enabled:\s*agentSessionsEnabled\(\)/);
  });

  it("keeps live worker steering off unless explicitly switched on, independently of the Agent Session layer (MOV-214/215)", () => {
    const configText = readFileSync(fileURLToPath(new URL("../src/config.mjs", import.meta.url)), "utf8");
    expect(configText).toMatch(/MOVIECAL_AGENT_SESSION_STEERING/);
    // A separate flag from MOVIECAL_AGENT_SESSIONS -- steering changes the
    // worker invocation mode, so it does not ride along with the receiver's.
    expect(configText.match(/MOVIECAL_AGENT_SESSION_STEERING/g).length).toBeGreaterThan(0);
    expect(runContextSource).toMatch(/steeringEnabled:\s*agentSessionSteeringEnabled\(\)/);
  });

  it("shares one entitlement latch across the process, so a rejection is not retried per issue", () => {
    expect(runContextSource).toMatch(/const agentSessionCapability = createAgentSessionCapability\(\)/);
    expect(bodyOf("buildRunContext", runContextSource)).toMatch(/capability:\s*agentSessionCapability/);
  });

  it("wires the durable provider-usage-limit store into every real run context", () => {
    const body = bodyOf("buildRunContext", runContextSource);
    expect(runContextSource).toMatch(/import \{ UsageLimitStore \} from "\.\/usage-limit\.mjs"/);
    expect(runContextSource).toMatch(/usageLimitStatePath/);
    expect(body).toMatch(/usageLimitStore:\s*new UsageLimitStore\(usageLimitStatePath\(\)\)/);
  });

  // MOV-205 gave dry-run a `usage limit:` line so a resume-pending issue is
  // diagnosable rather than looking like an ordinary worktree collision. That
  // is a *read*; the command's "no worktree, branch, or Linear state was
  // changed" promise means it must never touch the reclaiming or resuming
  // paths, both of which mutate the filesystem and the durable record.
  it("dry-run reports usage-limit state without reclaiming, resuming, or spending anything", () => {
    const body = bodyOf("cmdDryRun");
    expect(body).toMatch(/new UsageLimitStore\(usageLimitStatePath\(\)\)/);
    expect(body).toMatch(/usageLimits\.deferral\(/);
    expect(body).toMatch(/usageLimits\.resumption\(/);
    expect(body).toMatch(/worktreePathFree:\s*\(p\)\s*=>\s*manager\.isPathFree\(p\)/);
    // Call-shaped, not bare names: the body's own comment explains *why* it
    // uses plain isPathFree "and not isPathFreeForIssue", and a prose mention
    // is the opposite of the thing being guarded against.
    for (const mutating of [
      /manager\.isPathFreeForIssue\s*\(/,
      /\.resumeEntry\s*\(/,
      /\.consumeResume\s*\(/,
      /\.markStatus\s*\(/,
      /usageLimits\.record\s*\(/,
    ]) {
      expect(mutating.test(body), `cmdDryRun calls ${mutating}`).toBe(false);
    }
  });

  it("registers agent-signal as a read-only command that mutates nothing", () => {
    expect(source).toMatch(/case "agent-signal":/);
    expect(source).toMatch(/dispatcher <doctor\|health\|dry-run\|shadow\|agent-signal\|gc\|promote\|priorities\|reconcile-parents\|repair\|run>/);
    const body = source.slice(source.indexOf("function cmdAgentSignal("));
    const end = body.indexOf("\n}\n");
    const fn = body.slice(0, end);
    // It reads a file and prints. It must not reach Linear, git, gh, or a worker.
    for (const forbidden of ["buildLinearClient", "WorktreeManager", "spawnWorker", "execFileSync"]) {
      expect(fn.includes(forbidden), `cmdAgentSignal references ${forbidden}`).toBe(false);
    }
    expect(fn).toMatch(/wouldMutateLinear: false/);
  });

  it("records first-poll health and exposes a read-only health command (MOV-287)", () => {
    const run = bodyOf("cmdRun");
    expect(source).toMatch(/case "health":/);
    expect(source).toMatch(/function cmdHealth\(\)/);
    expect(run).toMatch(/new DispatcherLaunchHealthStore\(dispatcherLaunchHealthStatePath\(\)\)/);
    expect(run).toMatch(/launchHealth\.beginFirstPoll\(\)/);
    expect(run).toMatch(/launchHealth\.completeFirstPoll\(\)/);
    expect(run).toMatch(/launchHealth\.failFirstPoll\(/);
  });
});

describe("the checked-in agent-signal fixture (MOV-158)", () => {
  // The fixture is the only way the inbound path gets exercised by hand, so it
  // has to stay a payload the real normalizer accepts. Left unchecked it would
  // rot silently the first time the payload shape is tightened.
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/agent-session-stop.example.json", import.meta.url)), "utf8"),
  );

  it("normalizes to a stop and drives the controller, exactly as the CLI does", async () => {
    const { SignalLedger, StopController, handleAgentSignal } = await import("../src/agent-signals.mjs");
    const controller = new StopController();
    const ledger = new SignalLedger();

    const first = handleAgentSignal(fixture, { controller, ledger });
    const replay = handleAgentSignal(fixture, { controller, ledger });

    expect(first).toMatchObject({ handled: true, kind: "stop", stopped: true });
    expect(replay).toMatchObject({ handled: false, replay: true, stopped: true });
  });

  it("carries no credential-shaped material", () => {
    const text = JSON.stringify(fixture);
    expect(/lin_api_|Bearer |secret|token|password/i.test(text)).toBe(false);
  });
});
