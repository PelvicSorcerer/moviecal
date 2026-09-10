import { describe, it, expect, afterEach } from "vitest";
import {
  parseRoutingLabels,
  resolveRouting,
  workerInvocation,
  modelIdForTier,
  codexReasoningEffortForTier,
  codexModelIdForTier,
} from "../src/worker-routing.mjs";

const CODEX_ENV_VARS = [
  "MOVIECAL_CODEX_EFFORT_CHEAP",
  "MOVIECAL_CODEX_EFFORT_DEFAULT",
  "MOVIECAL_CODEX_EFFORT_STRONG",
  "MOVIECAL_CODEX_MODEL_CHEAP",
  "MOVIECAL_CODEX_MODEL_DEFAULT",
  "MOVIECAL_CODEX_MODEL_STRONG",
];

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
    expect(invocation.args).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "-c",
      "model_reasoning_effort=medium",
    ]);
  });

  it("throws for an unknown worker", () => {
    expect(() => workerInvocation("gemini", "default")).toThrow(/unknown worker/);
  });

  describe("codex tier mapping", () => {
    afterEach(() => {
      for (const key of CODEX_ENV_VARS) delete process.env[key];
    });

    it("maps cheap/default/strong to low/medium/high reasoning effort by default", () => {
      expect(workerInvocation("codex", "cheap").args).toContain("model_reasoning_effort=low");
      expect(workerInvocation("codex", "default").args).toContain("model_reasoning_effort=medium");
      expect(workerInvocation("codex", "strong").args).toContain("model_reasoning_effort=high");
    });

    it("omits --model entirely when no override is configured", () => {
      const invocation = workerInvocation("codex", "strong");
      expect(invocation.args).not.toContain("--model");
    });

    it("honors MOVIECAL_CODEX_EFFORT_STRONG when set", () => {
      process.env.MOVIECAL_CODEX_EFFORT_STRONG = "custom-high";
      const invocation = workerInvocation("codex", "strong");
      expect(invocation.args).toContain("model_reasoning_effort=custom-high");
    });

    it("honors MOVIECAL_CODEX_MODEL_STRONG when set", () => {
      process.env.MOVIECAL_CODEX_MODEL_STRONG = "gpt-5.6-strong";
      const invocation = workerInvocation("codex", "strong");
      expect(invocation.args).toEqual([
        "exec",
        "--sandbox",
        "workspace-write",
        "-c",
        "model_reasoning_effort=high",
        "--model",
        "gpt-5.6-strong",
      ]);
    });

    it("does not apply the strong override to other tiers", () => {
      process.env.MOVIECAL_CODEX_EFFORT_STRONG = "custom-high";
      process.env.MOVIECAL_CODEX_MODEL_STRONG = "gpt-5.6-strong";
      const invocation = workerInvocation("codex", "default");
      expect(invocation.args).toEqual([
        "exec",
        "--sandbox",
        "workspace-write",
        "-c",
        "model_reasoning_effort=medium",
      ]);
    });
  });
});

describe("codexReasoningEffortForTier", () => {
  afterEach(() => {
    for (const key of CODEX_ENV_VARS) delete process.env[key];
  });

  it("defaults to low/medium/high", () => {
    expect(codexReasoningEffortForTier("cheap")).toBe("low");
    expect(codexReasoningEffortForTier("default")).toBe("medium");
    expect(codexReasoningEffortForTier("strong")).toBe("high");
  });

  it("throws for an unknown tier", () => {
    expect(() => codexReasoningEffortForTier("bogus")).toThrow(/unknown model tier/);
  });
});

describe("codexModelIdForTier", () => {
  afterEach(() => {
    for (const key of CODEX_ENV_VARS) delete process.env[key];
  });

  it("returns null with no override configured (falls through to ~/.codex/config.toml)", () => {
    expect(codexModelIdForTier("cheap")).toBeNull();
    expect(codexModelIdForTier("default")).toBeNull();
    expect(codexModelIdForTier("strong")).toBeNull();
  });

  it("returns the override when set", () => {
    process.env.MOVIECAL_CODEX_MODEL_CHEAP = "gpt-5.6-mini";
    expect(codexModelIdForTier("cheap")).toBe("gpt-5.6-mini");
  });

  it("throws for an unknown tier", () => {
    expect(() => codexModelIdForTier("bogus")).toThrow(/unknown model tier/);
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
