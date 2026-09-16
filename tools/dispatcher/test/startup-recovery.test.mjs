import { describe, it, expect, vi } from "vitest";
import { reconcileStartupRecoveries } from "../src/startup-recovery.mjs";

function setup({ dirty = false, unpushed = false } = {}) {
  const entry = {
    startupRecovery: {
      stateMoved: false,
      commentPosted: false,
    },
  };
  const manager = {
    loadState: () => ({ "MOV-1": entry }),
    markStartupRecoveryProgress: vi.fn((_id, update) => Object.assign(entry.startupRecovery, update)),
  };
  const linear = {
    moveToState: vi.fn(),
    addComment: vi.fn(),
  };
  const change = {
    id: "MOV-1",
    linearIssueId: "linear-1",
    path: "/tmp/MOV-1",
    reason: "dispatcher restarted after worker stopped without a terminal update",
    dirty,
    uncommittedPaths: dirty ? ["src/recovery.mjs"] : [],
    hasUnpushedCommits: unpushed,
  };
  return { manager, linear, change, entry };
}

describe("reconcileStartupRecoveries (MOV-173)", () => {
  it("requeues a clean abandonment exactly once", async () => {
    const { manager, linear, change, entry } = setup();
    const options = {
      worktreeManager: manager,
      linearClient: linear,
      readyForAgentStateId: "ready",
      needsHumanDecisionStateId: "human",
    };

    await reconcileStartupRecoveries([change], options);
    await reconcileStartupRecoveries([change], options);

    expect(linear.moveToState).toHaveBeenCalledTimes(1);
    expect(linear.moveToState).toHaveBeenCalledWith("linear-1", "ready");
    expect(linear.addComment).toHaveBeenCalledWith("linear-1", expect.stringContaining("Requeuing"));
    expect(entry.startupRecovery).toMatchObject({ stateMoved: true, commentPosted: true });
  });

  it("preserves and escalates an abandonment with uncommitted work", async () => {
    const { manager, linear, change } = setup({ dirty: true });
    await reconcileStartupRecoveries([change], {
      worktreeManager: manager,
      linearClient: linear,
      readyForAgentStateId: "ready",
      needsHumanDecisionStateId: "human",
    });

    expect(linear.moveToState).toHaveBeenCalledWith("linear-1", "human");
    expect(linear.addComment).toHaveBeenCalledWith("linear-1", expect.stringContaining("/tmp/MOV-1"));
    expect(linear.addComment).toHaveBeenCalledWith("linear-1", expect.stringContaining("uncommitted changes"));
  });

  it("escalates an abandonment with only unpushed commits", async () => {
    const { manager, linear, change } = setup({ dirty: true, unpushed: true });
    change.uncommittedPaths = [];
    await reconcileStartupRecoveries([change], {
      worktreeManager: manager,
      linearClient: linear,
      readyForAgentStateId: "ready",
      needsHumanDecisionStateId: "human",
    });

    expect(linear.moveToState).toHaveBeenCalledWith("linear-1", "human");
    expect(linear.addComment).toHaveBeenCalledWith("linear-1", expect.stringContaining("remote-tracking branch"));
  });

  it("does not write for a non-abandoned worktree because no recovery change exists", async () => {
    const { manager, linear } = setup();
    await reconcileStartupRecoveries([], {
      worktreeManager: manager,
      linearClient: linear,
      readyForAgentStateId: "ready",
      needsHumanDecisionStateId: "human",
    });
    expect(linear.moveToState).not.toHaveBeenCalled();
    expect(linear.addComment).not.toHaveBeenCalled();
  });
});
