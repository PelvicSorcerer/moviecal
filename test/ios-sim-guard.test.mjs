import { describe, expect, it } from "vitest";

import {
  blockReason,
  classifyBashCommand,
  classifyMcpTool,
  classifyToolCall,
  currentLeaseState,
  evaluateGuard,
  formatHookOutput,
  runGuard,
} from "../scripts/ios-sim-guard.mjs";

function bashPayload(command) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}

function mcpPayload(toolName) {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {} };
}

describe("ios-sim-guard command classification", () => {
  it.each([
    ["xcrun simctl boot ABCD-1234", "mutating"],
    ["xcrun simctl install ABCD-1234 /path/App.app", "mutating"],
    ["xcrun simctl launch ABCD-1234 com.moviecal.ios", "mutating"],
    ["xcrun simctl shutdown ABCD-1234", "mutating"],
    ["xcrun simctl erase ABCD-1234", "mutating"],
    ["xcodebuild -project ios/Moviecal.xcodeproj -scheme Moviecal build", "mutating"],
    ["open -a Simulator.app", "mutating"],
    ["xcrun simctl list; xcrun simctl boot ABCD-1234", "mutating"],
    ["xcodebuild --dry-run; xcrun simctl boot ABCD-1234", "mutating"],
  ])("classifies %s as mutating", (command) => {
    expect(classifyBashCommand(command)).toBe("mutating");
  });

  it.each([
    ["xcrun simctl list devices booted -j", "read-only"],
    ["npm run ios:sim:status", "read-only"],
    ["node scripts/ios-sim-lease.mjs status --json", "read-only"],
    ["npm run ios:manual-test -- --device booted --dry-run", "read-only"],
    ["npm run ios:sim:acquire -- --dry-run", "read-only"],
  ])("classifies %s as read-only", (command) => {
    expect(classifyBashCommand(command)).toBe("read-only");
  });

  it("classifies an unrelated command as not-simulator", () => {
    expect(classifyBashCommand("npm run verify")).toBe("not-simulator");
    expect(classifyBashCommand("npm run ios:sim:run -- xcodebuild test")).toBe("not-simulator");
  });

  it.each([
    ["mcp__ios-simulator__boot_simulator", "mutating"],
    ["mcp__ios-simulator__install_app", "mutating"],
    ["mcp__ios-simulator__launch_app", "mutating"],
    ["mcp__ios-simulator__ui_tap", "mutating"],
    ["mcp__ios-simulator__terminate_app", "mutating"],
  ])("classifies MCP action %s as mutating", (toolName) => {
    expect(classifyMcpTool(toolName)).toBe("mutating");
  });

  it.each([
    ["mcp__ios-simulator__list_simulators", "read-only"],
    ["mcp__ios-simulator__get_booted_sim_id", "read-only"],
    ["mcp__ios-simulator__screenshot", "read-only"],
  ])("classifies MCP action %s as read-only", (toolName) => {
    expect(classifyMcpTool(toolName)).toBe("read-only");
  });

  it("classifies an unrelated MCP tool as not-simulator", () => {
    expect(classifyMcpTool("mcp__playwright__click")).toBe("not-simulator");
  });

  it("classifies generic simulator control by its action argument", () => {
    const control = "mcp__Claude_Code_iOS_Simulator__control";
    expect(classifyMcpTool(control, { action: "launch" })).toBe("mutating");
    expect(classifyMcpTool(control, { action: "list" })).toBe("read-only");
    expect(classifyMcpTool(control, { action: "get_booted_sim_id" })).toBe("read-only");
    expect(classifyToolCall({ tool_name: control, tool_input: { action: "launch" } })).toBe("mutating");
  });

  it("classifyToolCall dispatches Bash and MCP tool names, and passes through anything else", () => {
    expect(classifyToolCall(bashPayload("xcrun simctl boot ABCD"))).toBe("mutating");
    expect(classifyToolCall(mcpPayload("mcp__ios-simulator__boot_simulator"))).toBe("mutating");
    expect(classifyToolCall({ tool_name: "Read", tool_input: { file_path: "a.ts" } })).toBe("not-simulator");
  });
});

describe("ios-sim-guard block reason", () => {
  it("always includes the acquire instruction", () => {
    expect(blockReason("worker")).toMatch(/npm run ios:sim:acquire/);
    expect(blockReason("manual")).toMatch(/npm run ios:sim:acquire/);
  });

  it("repeats the release-when-finished instruction only in the manual lane", () => {
    expect(blockReason("manual")).toMatch(/npm run ios:sim:release/);
    expect(blockReason("worker")).not.toMatch(/npm run ios:sim:release/);
    expect(blockReason("ci")).not.toMatch(/npm run ios:sim:release/);
  });
});

describe("evaluateGuard (pure decision)", () => {
  it("allows a mutating command when a live lease covers the caller's lane", () => {
    const result = evaluateGuard(bashPayload("xcrun simctl boot ABCD"), { lane: "manual", hasLiveLease: true });
    expect(result).toEqual({ decision: "allow", reason: null });
  });

  it("blocks a mutating command with no live lease, naming the acquire instruction", () => {
    const result = evaluateGuard(bashPayload("xcrun simctl boot ABCD"), { lane: "manual", hasLiveLease: false });
    expect(result.decision).toBe("block");
    expect(result.reason).toMatch(/npm run ios:sim:acquire/);
  });

  it("always allows a read-only command, lease or no lease", () => {
    expect(evaluateGuard(bashPayload("xcrun simctl list devices"), { lane: "manual", hasLiveLease: false })).toEqual({
      decision: "allow",
      reason: null,
    });
  });

  it("always allows a tool call unrelated to the simulator", () => {
    expect(evaluateGuard({ tool_name: "Edit", tool_input: { file_path: "a.ts" } }, { lane: "manual", hasLiveLease: false })).toEqual({
      decision: "allow",
      reason: null,
    });
  });

  it("blocks a mutating MCP action with no live lease", () => {
    const result = evaluateGuard(mcpPayload("mcp__ios-simulator__boot_simulator"), { lane: "worker", hasLiveLease: false });
    expect(result.decision).toBe("block");
  });

  it("allows a read-only MCP action with no live lease", () => {
    const result = evaluateGuard(mcpPayload("mcp__ios-simulator__list_simulators"), { lane: "worker", hasLiveLease: false });
    expect(result).toEqual({ decision: "allow", reason: null });
  });
});

describe("currentLeaseState (I/O)", () => {
  function fakeEnvironment({ lane, lease }) {
    const env = lane === "worker" ? { MOVIECAL_WORKER_SANDBOX: "1" } : lane === "ci" ? { GITHUB_ACTIONS: "true" } : {};
    return {
      env,
      now: () => Date.parse("2026-09-23T10:05:00.000Z"),
      isProcessAlive: () => true,
      store: { load: () => ({ version: 1, lease, waiters: [] }) },
    };
  }

  it("reports no live lease when none is held", () => {
    expect(currentLeaseState(fakeEnvironment({ lane: "manual", lease: null }))).toEqual({ lane: "manual", hasLiveLease: false });
  });

  it("reports a live lease only when it belongs to the caller's own lane", () => {
    const manualLease = { lane: "manual", expiresAt: "2026-09-23T10:20:00.000Z" };
    expect(currentLeaseState(fakeEnvironment({ lane: "manual", lease: manualLease }))).toEqual({ lane: "manual", hasLiveLease: true });
    expect(currentLeaseState(fakeEnvironment({ lane: "worker", lease: manualLease }))).toEqual({ lane: "worker", hasLiveLease: false });
  });

  it("treats an expired lease as not live", () => {
    const expired = { lane: "manual", expiresAt: "2026-09-23T09:00:00.000Z" };
    expect(currentLeaseState(fakeEnvironment({ lane: "manual", lease: expired }))).toEqual({ lane: "manual", hasLiveLease: false });
  });
});

describe("runGuard end-to-end", () => {
  function fakeEnvironment(lease) {
    return {
      env: { MOVIECAL_WORKER_SANDBOX: "1" },
      now: () => Date.parse("2026-09-23T10:05:00.000Z"),
      isProcessAlive: () => true,
      store: { load: () => ({ version: 1, lease, waiters: [] }) },
    };
  }

  it("blocks a mutating command with no lease held", () => {
    const result = runGuard(JSON.stringify(bashPayload("xcrun simctl boot ABCD")), fakeEnvironment(null));
    expect(result.decision).toBe("block");
    expect(result.reason).toMatch(/npm run ios:sim:acquire/);
  });

  it("allows a mutating command once the worker lane holds a live lease", () => {
    const lease = { lane: "worker", acquiredAt: "2026-09-23T10:04:00.000Z", holder: { pid: 1 } };
    const result = runGuard(JSON.stringify(bashPayload("xcrun simctl boot ABCD")), fakeEnvironment(lease));
    expect(result).toEqual({ decision: "allow", reason: null });
  });

  it("fails open (allow) on malformed hook input", () => {
    expect(runGuard("not json", fakeEnvironment(null))).toEqual({ decision: "allow", reason: null });
  });
});

describe("formatHookOutput", () => {
  it("formats a block as a PreToolUse deny with the reason", () => {
    expect(formatHookOutput({ decision: "block", reason: "run acquire first" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "run acquire first",
      },
    });
  });

  it("leaves normal permissions in place for an allowed command", () => {
    expect(formatHookOutput({ decision: "allow", reason: null })).toEqual({});
  });
});
