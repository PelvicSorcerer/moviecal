import { describe, it, expect } from "vitest";
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

function bodyOf(fnName) {
  const start = source.indexOf(`async function ${fnName}(`);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  // crude brace match from the function body's "{", not any default-object "{"
  const sigClose = source.indexOf(")", start);
  const open = source.indexOf("{", sigClose);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`could not find end of ${fnName}`);
}

describe("dispatcher run-loop wiring (MOV-129/MOV-366)", () => {
  it("cmdRunOnce awaits reconcile -> propagate -> promote before reading Ready for Agent", () => {
    const body = bodyOf("cmdRunOnce");
    const reconcileAt = body.indexOf("await reconcileWorktrees(");
    const propagateAt = body.indexOf("await propagatePass(");
    const promoteAt = body.indexOf("await promotePass(");
    const dispatchReadAt = body.indexOf("issuesInState(");
    expect(reconcileAt, "reconcileWorktrees() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(propagateAt, "propagatePass() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(promoteAt, "promotePass() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(dispatchReadAt, "issuesInState() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(reconcileAt).toBeLessThan(propagateAt);
    expect(propagateAt).toBeLessThan(promoteAt);
    expect(promoteAt).toBeLessThan(dispatchReadAt);
    expect(body).toMatch(/await\s+reconcileWorktrees\(/);
    expect(body).toMatch(/await\s+propagatePass\(\)/);
    expect(body).toMatch(/await\s+promotePass\(\)/);
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
      "dispatcherLockPath",
      "envLocalPath",
      "linearAppEnvPath",
      "linearEnvPath",
      "worktreesStatePath",
    ]);
    for (const [name, text] of dispatcherSources) {
      expect(/WEBHOOK_SECRET|AGENT_SESSION_SECRET|SIGNING_SECRET/.test(text), name).toBe(false);
    }
  });

  it("keeps the Agent Session layer off unless explicitly switched on", () => {
    const configText = readFileSync(fileURLToPath(new URL("../src/config.mjs", import.meta.url)), "utf8");
    expect(configText).toMatch(/MOVIECAL_AGENT_SESSIONS/);
    // An unset variable must read as off, never as on.
    expect(source).toMatch(/enabled:\s*agentSessionsEnabled\(\)/);
  });

  it("shares one entitlement latch across the process, so a rejection is not retried per issue", () => {
    expect(source).toMatch(/const agentSessionCapability = createAgentSessionCapability\(\)/);
    expect(bodyOf("buildRunContext")).toMatch(/capability:\s*agentSessionCapability/);
  });

  it("registers agent-signal as a read-only command that mutates nothing", () => {
    expect(source).toMatch(/case "agent-signal":/);
    expect(source).toMatch(/dispatcher <doctor\|dry-run\|shadow\|agent-signal\|gc\|promote\|run>/);
    const body = source.slice(source.indexOf("function cmdAgentSignal("));
    const end = body.indexOf("\n}\n");
    const fn = body.slice(0, end);
    // It reads a file and prints. It must not reach Linear, git, gh, or a worker.
    for (const forbidden of ["buildLinearClient", "WorktreeManager", "spawnWorker", "execFileSync"]) {
      expect(fn.includes(forbidden), `cmdAgentSignal references ${forbidden}`).toBe(false);
    }
    expect(fn).toMatch(/wouldMutateLinear: false/);
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
