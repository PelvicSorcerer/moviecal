import { describe, it, expect, afterEach } from "vitest";
import {
  parseRoutingLabels,
  resolveRouting,
  resolveDispatchWorker,
  workerInvocation,
  CLAUDE_WORKER_PERMISSION_DENIES,
  CLAUDE_WORKER_SETTINGS,
  CLAUDE_WORKER_TOOLS,
  CLAUDE_WORKER_PERMISSION_MODE,
  modelIdForTier,
  codexReasoningEffortForTier,
  codexModelIdForTier,
  claudeEffortForTier,
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
    expect(result.worker).toBe("claude"); // fresh worker:any defaults to Claude
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

describe("resolveDispatchWorker (MOV-360)", () => {
  const ALWAYS_OPEN = () => true;
  const CLAUDE_COOLING = (w) => w !== "claude";
  const BOTH_COOLING = () => false;

  it("never consults cooldown for a claude-pinned issue", () => {
    const result = resolveDispatchWorker({ labels: ["worker:claude"] }, { cooldownOpen: BOTH_COOLING });
    expect(result).toMatchObject({ worker: "claude", isAny: false, available: true, bound: false, ok: true });
  });

  it("never consults cooldown for a codex-pinned issue", () => {
    const result = resolveDispatchWorker({ labels: ["worker:codex"] }, { cooldownOpen: BOTH_COOLING });
    expect(result).toMatchObject({ worker: "codex", isAny: false, available: true, bound: false, ok: true });
  });

  it("treats the no-label rubric default as pinned to claude, unaffected by cooldown", () => {
    const result = resolveDispatchWorker({ labels: [] }, { cooldownOpen: BOTH_COOLING });
    expect(result).toMatchObject({ worker: "claude", isAny: false, available: true });
  });

  it("picks claude for a fresh worker:any issue when claude is open", () => {
    const result = resolveDispatchWorker({ labels: ["worker:any"] }, { cooldownOpen: ALWAYS_OPEN });
    expect(result).toMatchObject({ worker: "claude", isAny: true, available: true, bound: false });
  });

  it("keeps fresh worker:any on claude when claude is cooling", () => {
    const result = resolveDispatchWorker({ labels: ["worker:any"] }, { cooldownOpen: CLAUDE_COOLING });
    expect(result).toMatchObject({ worker: "claude", isAny: true, available: true, bound: false });
  });

  it("keeps fresh worker:any on claude even when both pools are cooling", () => {
    const result = resolveDispatchWorker({ labels: ["worker:any"] }, { cooldownOpen: BOTH_COOLING });
    expect(result).toMatchObject({ worker: "claude", isAny: true, available: true });
  });

  it("keeps a worker:any issue bound to its prior attempt's worker, even when the other is open", () => {
    // Cooldowns do not alter a provider binding.
    const result = resolveDispatchWorker(
      { labels: ["worker:any"] },
      { boundWorker: "claude", cooldownOpen: CLAUDE_COOLING },
    );
    expect(result).toMatchObject({ worker: "claude", isAny: true, available: true, bound: true });
  });

  it("keeps a worker:any issue bound to codex the same way", () => {
    const result = resolveDispatchWorker(
      { labels: ["worker:any"] },
      { boundWorker: "codex", cooldownOpen: ALWAYS_OPEN },
    );
    expect(result).toMatchObject({ worker: "codex", isAny: true, available: true, bound: true });
  });

  it("ignores a malformed bound-worker value and falls back to a fresh pick", () => {
    const result = resolveDispatchWorker(
      { labels: ["worker:any"] },
      { boundWorker: "gemini", cooldownOpen: ALWAYS_OPEN },
    );
    expect(result).toMatchObject({ worker: "claude", bound: false });
  });

  it("still rejects model:strong with no upgrade condition, independent of worker selection", () => {
    const result = resolveDispatchWorker({ labels: ["worker:any", "model:strong"] }, { cooldownOpen: ALWAYS_OPEN });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/upgrade-condition/);
  });

  it("defaults cooldownOpen to always-open when the caller supplies none", () => {
    expect(resolveDispatchWorker({ labels: ["worker:any"] })).toMatchObject({ worker: "claude", available: true });
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
      "--effort",
      "medium",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Edit,Write,Glob,Grep,Bash,NotebookEdit,Task",
      "--allowedTools",
      "Read,Edit,Write,Glob,Grep,Bash,NotebookEdit,Task",
      "--setting-sources",
      "project",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-chrome",
      "--disable-slash-commands",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--settings",
      JSON.stringify(CLAUDE_WORKER_SETTINGS),
    ]);
  });

  describe("explicit Claude worker tool set (MOV-386)", () => {
    const EXCLUDED = [
      "Workflow", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger", "SendMessage",
      "PushNotification", "WebFetch", "WebSearch", "EnterWorktree", "ExitWorktree", "DesignSync", "Monitor",
    ];

    it("pins the exact tool constant and the permission mode", () => {
      expect(CLAUDE_WORKER_TOOLS).toEqual(["Read", "Edit", "Write", "Glob", "Grep", "Bash", "NotebookEdit", "Task"]);
      expect(Object.isFrozen(CLAUDE_WORKER_TOOLS)).toBe(true);
      expect(CLAUDE_WORKER_PERMISSION_MODE).toBe("dontAsk");
      for (const tool of EXCLUDED) expect(CLAUDE_WORKER_TOOLS).not.toContain(tool);
    });

    it.each(["cheap", "default", "strong"])("passes the tool set as both --tools and --allowedTools for the %s tier, with and without steering", (tier) => {
      for (const steering of [false, true]) {
        const args = workerInvocation("claude", tier, { steering }).args;
        const valueAfter = (flag) => args[args.indexOf(flag) + 1];
        expect(valueAfter("--tools")).toBe(CLAUDE_WORKER_TOOLS.join(","));
        expect(valueAfter("--allowedTools")).toBe(CLAUDE_WORKER_TOOLS.join(","));
        expect(valueAfter("--permission-mode")).toBe(CLAUDE_WORKER_PERMISSION_MODE);
        expect(args.filter((arg) => arg === "--tools")).toHaveLength(1);
        expect(args).not.toContain("--disallowedTools");
        // The deny list still rides in --settings on top of the allowlist.
        expect(JSON.parse(valueAfter("--settings")).permissions).toEqual({ deny: CLAUDE_WORKER_PERMISSION_DENIES });
      }
    });

    it("keeps every excluded tool name out of the whole claude argv", () => {
      const joined = workerInvocation("claude", "default").args.join(" ");
      for (const tool of EXCLUDED) expect(joined).not.toMatch(new RegExp(`\\b${tool}\\b`));
    });

    it("leaves the codex invocation without any Claude tool flags", () => {
      const args = workerInvocation("codex", "default").args;
      expect(args).not.toContain("--tools");
      expect(args).not.toContain("--allowedTools");
      expect(args).not.toContain("--permission-mode");
    });
  });

  it("adds --input-format stream-json for claude only when steering is requested, changing nothing else (MOV-214/215)", () => {
    const off = workerInvocation("claude", "default");
    expect(off.args).not.toContain("--input-format");

    const on = workerInvocation("claude", "default", { steering: true });
    const idx = on.args.indexOf("--input-format");
    expect(idx).toBeGreaterThan(-1);
    expect(on.args[idx + 1]).toBe("stream-json");
    // Removing exactly the two inserted tokens must reproduce the
    // steering-off array byte-for-byte -- nothing safety-relevant (the
    // permission mode, sandbox flags, the sandbox-disabling --settings
    // override) moved, changed, or disappeared.
    const withoutInserted = [...on.args.slice(0, idx), ...on.args.slice(idx + 2)];
    expect(withoutInserted).toEqual(off.args);
  });

  it("ignores the steering option for codex, which has no equivalent interactive protocol (MOV-214/215)", () => {
    expect(workerInvocation("codex", "default", { steering: true })).toEqual(workerInvocation("codex", "default"));
  });

  it("disables Claude Code's own internal sandbox for every model tier (MOV-184)", () => {
    // A second, independent Seatbelt sandbox_apply call inside
    // worker-guard.mjs's already-confined outer profile deterministically
    // fails (verified: any profile with a (deny ...) rule -- which the
    // outer profile always has -- cannot re-apply a sandbox to itself).
    // The outer profile is the sole, sufficient security boundary; asserting
    // the JSON shape here (not a substring match) so a future formatting
    // change can't silently stop actually disabling it.
    for (const tier of ["cheap", "default", "strong"]) {
      const invocation = workerInvocation("claude", tier);
      const settingsIndex = invocation.args.indexOf("--settings");
      expect(settingsIndex).toBeGreaterThan(-1);
      const parsed = JSON.parse(invocation.args[settingsIndex + 1]);
      expect(parsed.sandbox).toEqual({ enabled: false });
      expect(parsed.permissions).toEqual({ deny: CLAUDE_WORKER_PERMISSION_DENIES });
    }
  });

  it("does not add the sandbox-disabling settings override to codex, which is unaffected (MOV-184)", () => {
    const invocation = workerInvocation("codex", "default");
    expect(invocation.args).not.toContain("--settings");
  });

  it("scopes the claude invocation to a non-hanging, non-bypassing permission mode", () => {
    // dontAsk auto-denies anything not covered by the base project allow list
    // or the dispatcher-only worker deny list, instead of prompting -- which is what prevents a
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

  it("keeps every legacy Claude deny in the dispatcher-only settings payload (MOV-237)", () => {
    expect(CLAUDE_WORKER_PERMISSION_DENIES).toEqual([
      "Bash(git*)",
      "Bash(gh api*)",
      "Bash(gh pr create*)",
      "Bash(gh pr edit*)",
      "Bash(gh pr merge*)",
      "Bash(gh pr close*)",
      "Bash(gh issue*)",
      "Bash(gh secret*)",
      "Bash(gh ruleset*)",
      "Bash(gh release*)",
      "Bash(gh repo delete*)",
      "Bash(curl*)",
      "Bash(wget*)",
      "Bash(ssh*)",
      "Bash(scp*)",
      "Bash(sftp*)",
      "Bash(security*)",
      "Bash(npm publish*)",
      "Bash(vercel*)",
      "Bash(supabase *reset*)",
      "Bash(supabase *drop*)",
      "Bash(*SUPABASE_DB_URL_PROD*)",
      "Read(~/.config/gh/**)",
      "Read(~/.config/moviecal/**)",
      "Read(~/.ssh/**)",
      "Read(~/.git-credentials)",
      "Read(~/.netrc)",
      "Read(~/.npmrc)",
      "Read(.env)",
      "Read(.env.local)",
      "Edit(AGENTS.md)",
      "Edit(.github/copilot-instructions.md)",
      "Edit(docs/product/**)",
      "Edit(.github/workflows/**)",
      "Edit(.claude/**)",
      "Edit(.codex/**)",
    ]);
  });

  it("builds a codex invocation with the workspace-write sandbox, no brief-path arg (stdin instead)", () => {
    const invocation = workerInvocation("codex", "default");
    expect(invocation.command).toBe("codex");
    expect(invocation.args).toEqual([
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--strict-config",
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--json",
      "-c",
      "model_reasoning_effort=medium",
      "--model",
      "gpt-6-sol",
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

    it.each([["cheap", "gpt-6-luna", "low"], ["default", "gpt-6-sol", "medium"], ["strong", "gpt-6-sol", "high"]])("pins %s model and effort independently of user config", (tier, model, effort) => {
      const args = workerInvocation("codex", tier).args;
      expect(args.slice(-4)).toEqual(["-c", `model_reasoning_effort=${effort}`, "--model", model]);
      expect(args).toContain("--ignore-user-config");
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
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "--strict-config",
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--json",
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
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "--strict-config",
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--json",
        "-c",
        "model_reasoning_effort=medium",
        "--model",
        "gpt-6-sol",
      ]);
    });
  });
});

describe("Claude effort routing (MOV-364)", () => {
  const names = ["CHEAP", "DEFAULT", "STRONG"].map((tier) => `MOVIECAL_CLAUDE_EFFORT_${tier}`);
  afterEach(() => names.forEach((name) => delete process.env[name]));

  it("uses no flag for cheap, medium for default and high for strong", () => {
    expect(workerInvocation("claude", "cheap").args).not.toContain("--effort");
    for (const [tier, value] of [["default", "medium"], ["strong", "high"]]) {
      const args = workerInvocation("claude", tier).args;
      expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", value]);
    }
  });

  it("honors each override and none, and rejects invalid values", () => {
    process.env.MOVIECAL_CLAUDE_EFFORT_CHEAP = "low";
    process.env.MOVIECAL_MODEL_CHEAP = "claude-sonnet-5";
    expect(claudeEffortForTier("cheap")).toBe("low");
    process.env.MOVIECAL_CLAUDE_EFFORT_DEFAULT = "none";
    expect(workerInvocation("claude", "default").args).not.toContain("--effort");
    process.env.MOVIECAL_CLAUDE_EFFORT_STRONG = "xhigh";
    expect(claudeEffortForTier("strong")).toBe("xhigh");
    process.env.MOVIECAL_CLAUDE_EFFORT_DEFAULT = "bogus";
    expect(() => workerInvocation("claude", "default")).toThrow(/invalid Claude effort "bogus"/);
    delete process.env.MOVIECAL_MODEL_CHEAP;
  });

  it("omits effort for Haiku 4.5 even when a tier override requests it", () => {
    process.env.MOVIECAL_MODEL_DEFAULT = "claude-haiku-4-5-20251001";
    process.env.MOVIECAL_CLAUDE_EFFORT_DEFAULT = "high";
    expect(workerInvocation("claude", "default").args).not.toContain("--effort");
    delete process.env.MOVIECAL_MODEL_DEFAULT;
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

  it("returns explicit defaults without overrides", () => {
    expect(codexModelIdForTier("cheap")).toBe("gpt-6-luna");
    expect(codexModelIdForTier("default")).toBe("gpt-6-sol");
    expect(codexModelIdForTier("strong")).toBe("gpt-6-sol");
  });

  it.each(["cheap", "default", "strong"])("isolates the %s model and effort overrides", (tier) => {
    const tiers = ["cheap", "default", "strong"];
    const before = tiers.map((t) => workerInvocation("codex", t));
    process.env[`MOVIECAL_CODEX_MODEL_${tier.toUpperCase()}`] = "custom-model";
    process.env[`MOVIECAL_CODEX_EFFORT_${tier.toUpperCase()}`] = "custom-effort";
    tiers.forEach((t, i) => {
      const invocation = workerInvocation("codex", t);
      if (t === tier) expect(invocation.args.slice(-4)).toEqual(["-c", "model_reasoning_effort=custom-effort", "--model", "custom-model"]);
      else expect(invocation).toEqual(before[i]);
    });
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
  const originalModelEnv = Object.fromEntries(
    ["MOVIECAL_MODEL_CHEAP", "MOVIECAL_MODEL_DEFAULT", "MOVIECAL_MODEL_STRONG"].map((key) => [key, process.env[key]]),
  );

  afterEach(() => {
    for (const [key, value] of Object.entries(originalModelEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses the new Claude strong default in the worker invocation", () => {
    delete process.env.MOVIECAL_MODEL_STRONG;
    const args = workerInvocation("claude", "strong").args;
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "claude-opus-5-5"]);
  });

  it("honors the configured Claude strong model override", () => {
    process.env.MOVIECAL_MODEL_STRONG = "custom-strong-model";
    const args = workerInvocation("claude", "strong").args;
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "custom-strong-model"]);
  });

  it("keeps the Claude cheap and default models unchanged", () => {
    delete process.env.MOVIECAL_MODEL_CHEAP;
    delete process.env.MOVIECAL_MODEL_DEFAULT;
    expect(modelIdForTier("claude", "cheap")).toBe("claude-haiku-4-5");
    expect(modelIdForTier("claude", "default")).toBe("claude-sonnet-5");
  });

  it("returns null for a non-claude worker (codex resolves its own default)", () => {
    expect(modelIdForTier("codex", "default")).toBeNull();
  });

  it("throws for an unknown tier", () => {
    expect(() => modelIdForTier("claude", "bogus")).toThrow(/unknown model tier/);
  });
});
