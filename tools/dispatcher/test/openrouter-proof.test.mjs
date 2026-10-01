import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readProofApproval } from "../src/openrouter-proof.mjs";
let root;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mov429-approval-")));
  fs.mkdirSync(path.join(root, ".config/moviecal"), { recursive: true });
  const now = new Date("2026-10-01T03:00:00Z");
  const approval = { issue: "MOV-429", owner: "Adam Moore", ownerApproved: true, securityReviewPassed: true,
    effectiveEligibilityUnrestricted: true, promptLoggingOff: true, zdrOff: true, dataCollectionUnrestricted: true,
    keyLimitUsd: 69, allInCeilingUsd: 75, availableCreditUsd: 5, keyRemainingUsd: 69, allInOutlayUsd: 5,
    keyId: "fixture-key", workspaceId: "fixture-workspace", maxRequests: 6,
    reviewedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString() };
  const file = path.join(root, ".config/moviecal/jev-proof-approval.json");
  const save = () => fs.writeFileSync(file, JSON.stringify(approval), { mode: 0o600 });
  save(); return { now, approval, file, save };
}
describe("disposable paid proof approval", () => {
  it("accepts a scoped current attestation without reading a provider key", () => {
    const { now, approval } = setup();
    expect(readProofApproval({ home: root, now }).approval).toEqual(approval);
    expect(fs.readdirSync(path.join(root, ".config/moviecal"))).toEqual(["jev-proof-approval.json"]);
  });
  it.each(["ownerApproved", "securityReviewPassed", "effectiveEligibilityUnrestricted", "promptLoggingOff", "zdrOff", "dataCollectionUnrestricted"])("refuses an unconfirmed %s gate", (field) => {
    const { now, approval, save } = setup(); approval[field] = false; save();
    expect(() => readProofApproval({ home: root, now })).toThrow(/approval/);
  });
  it.each([
    ["maxRequests", 7], ["availableCreditUsd", 0], ["keyRemainingUsd", 70], ["allInOutlayUsd", 76],
    ["expiresAt", "2026-10-01T03:00:00Z"], ["expiresAt", "2026-10-01T05:00:00Z"], ["owner", "worker"],
  ])("refuses invalid %s", (field, value) => {
    const { now, approval, save } = setup(); approval[field] = value; save();
    expect(() => readProofApproval({ home: root, now })).toThrow(/approval/);
  });
  it("refuses readable or symlinked approval files", () => {
    const { now, file } = setup(); fs.chmodSync(file, 0o644);
    expect(() => readProofApproval({ home: root, now })).toThrow(/mode 600/);
    const actual = `${file}.actual`; fs.renameSync(file, actual); fs.symlinkSync(actual, file);
    expect(() => readProofApproval({ home: root, now })).toThrow(/unlinked/);
  });
});
