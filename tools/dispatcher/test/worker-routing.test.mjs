import { describe, it, expect } from "vitest";
import {
  parseRoutingLabels,
  resolveRouting,
  workerInvocation,
  modelIdForTier,
} from "../src/worker-routing.mjs";

describe("parseRoutingLabels", () => {
  it("returns nulls when no routing labels are present", () => {
    expect(parseRoutingLabels(["area:calendar", "risk:low"])).toEqual({ worker: null, model: null });
  });

  it("parses worker and model overrides", () => {
    expect(parseRoutingLabels(["worker:codex", "model:strong"])).toEqual({
      worker: "codex",
      model: "strong",
    });
  });

  it("ignores malformed labels", () => {
    expect(parseRoutingLabels(["worker:gemini", "model:whatever"])).toEqual({
      worker: null,
      model: null,
    });
  });
});

describe("resolveRouting", () => {
  it("defaults to claude + default tier with no labels", () => {
    const result = resolveRouting({ labels: [] });
    expect(result).toMatchObject({ worker: "claude", model: "default", ok: true });
  });

  it("honors a worker:codex override", () => {
    const result = resolveRouting({ labels: ["worker:codex"] });
    expect(result.worker).toBe("codex");
  });

  it("treats worker:any as not pinning claude", () => {
    const result = resolveRouting({ labels: ["worker:any"] });
    expect(result.worker).toBe("claude"); // dispatcher's own quota-based pick, defaulting to claude here
  });

  it("rejects model:strong with no cited upgrade condition", () => {
    const result = resolveRouting({ labels: ["model:strong"] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/upgrade-condition/);
  });

  it("accepts model:strong with a cited upgrade condition", () => {
    const result = resolveRouting({ labels: ["model:strong", "upgrade:architecture"] });
    expect(result.ok).toBe(true);
    expect(result.upgradeConditions).toEqual(["architecture"]);
  });

  it("does not require an upgrade condition for model:cheap", () => {
    const result = resolveRouting({ labels: ["model:cheap"] });
    expect(result.ok).toBe(true);
  });
});

describe("workerInvocation", () => {
  it("builds a claude invocation with a resolved model id, no brief-path arg (stdin instead)", () => {
    const invocation = workerInvocation("claude", "default");
    expect(invocation.command).toBe("claude");
    expect(invocation.args).toEqual([
      "-p",
      "--model",
      modelIdForTier("claude", "default"),
      "--permission-mode",
      "dontAsk",
    ]);
  });

  it("scopes the claude invocation to a non-hanging, non-bypassing permission mode", () => {
    // dontAsk auto-denies anything not covered by .claude/settings.json
    // permissions.allow, instead of prompting -- which is what prevents a
    // headless run with no TTY from hanging on an unmatched permission
    // request. Verified against the installed CLI version (2.1.208): the
    // newer `acceptEdits` + `--permission-prompts none` combination is
    // rejected as an unknown option on this version.
    const invocation = workerInvocation("claude", "default");
    expect(invocation.args).toContain("--permission-mode");
    expect(invocation.args).toContain("dontAsk");
    expect(invocation.args).not.toContain("bypassPermissions");
    expect(invocation.args).not.toContain("--dangerously-skip-permissions");
    expect(invocation.args).not.toContain("--permission-prompts");
  });

  it("builds a codex invocation with the workspace-write sandbox, no brief-path arg (stdin instead)", () => {
    const invocation = workerInvocation("codex", "default");
    expect(invocation.command).toBe("codex");
    expect(invocation.args).toEqual(["exec", "--sandbox", "workspace-write"]);
  });

  it("throws for an unknown worker", () => {
    expect(() => workerInvocation("gemini", "default")).toThrow(/unknown worker/);
  });
});

describe("modelIdForTier", () => {
  it("returns null for a non-claude worker (codex resolves its own default)", () => {
    expect(modelIdForTier("codex", "default")).toBeNull();
  });

  it("throws for an unknown tier", () => {
    expect(() => modelIdForTier("claude", "bogus")).toThrow(/unknown model tier/);
  });
});
