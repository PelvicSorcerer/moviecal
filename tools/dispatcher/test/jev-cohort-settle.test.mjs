import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settleExitedCohortRequests } from "../src/jev-cohort-settle.mjs";

const store = (pending, root) => ({
  storeRoot: root,
  pendingFor: vi.fn(() => pending),
  reconcileOrphans: vi.fn(() => ({ outcome: "settle", applied: true })),
});

describe("settleExitedCohortRequests", () => {
  it("does not read the account when the issue has nothing pending", async () => {
    const readAccount = vi.fn();
    expect(await settleExitedCohortRequests(store([], "/nowhere"), "MOV-1", { readAccount })).toBeNull();
    expect(readAccount).not.toHaveBeenCalled();
  });

  it("settles through reconcileOrphans with no minimum age, scoped to the issue", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "settle-"));
    fs.writeFileSync(path.join(root, "openrouter-jev.env"), "OPENROUTER_API_KEY=sk-test-12345678\n", { mode: 0o600 });
    const s = store([{ requestId: "r1" }], root);
    const account = { keyUsageUsd: 1 };
    const readAccount = vi.fn(async () => account);
    const result = await settleExitedCohortRequests(s, "MOV-1", { readAccount });
    expect(result.outcome).toBe("settle");
    expect(s.reconcileOrphans).toHaveBeenCalledWith(account, expect.objectContaining({ apply: true, minAgeMs: 0, issue: "MOV-1", reason: "worker-exited-request-settled" }));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails closed on an invalid credential", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "settle-"));
    fs.writeFileSync(path.join(root, "openrouter-jev.env"), "garbage\n");
    await expect(settleExitedCohortRequests(store([{}], root), "MOV-1", { readAccount: vi.fn() })).rejects.toThrow(/credential/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
