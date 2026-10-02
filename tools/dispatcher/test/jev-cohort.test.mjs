import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JevCohortStore, policyDigest, validateCohortPolicy,
  validateCohortApproval, resolveCohortTransport } from "../src/jev-cohort.mjs";
import { validateOpenRouterTransport, buildOpenRouterRequest } from "../src/openrouter-transport.mjs";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const policy = () => ({ trialId: "fixture-1", route: "codex-openrouter-responses",
  activatedAt: "2026-10-01T12:00:00.000Z", expiresAt: "2026-10-10T12:00:00.000Z",
  pairs: [{ routed: "MOV-10", control: "MOV-11" }, { routed: "MOV-12", control: "MOV-13" }],
  routed: { model: "typesafe/jev-router", worker: "codex", tier: "default" },
  control: { model: "openai/fixture", worker: "codex", provider: "OpenAI", effort: "medium", tier: "default" },
  keyId: "fixture_key", workspaceId: "fixture_workspace", keyLimitUsd: 69,
  allInCeilingUsd: 75, priorOutlayUsd: 5, baselineKeyUsageUsd: 1, purchaseFeesUsd: 0.5,
  modelAliases: { "openai/fixture": "openai/fixture", "~fixture": "openai/fixture" } });
const approval = (p) => ({ issue: "MOV-431", owner: "Adam Moore", ownerApproved: true,
  securityReviewPassed: true, accountPolicyReviewed: true, effectiveEligibilityUnrestricted: true,
  promptLoggingOff: true, zdrOff: true, dataCollectionUnrestricted: true,
  priorOutlayBasisReviewed: true, keyLimitUsd: 69, allInCeilingUsd: 75,
  keyId: p.keyId, workspaceId: p.workspaceId, policySha256: policyDigest(p),
  reviewedAt: "2026-10-01T11:00:00.000Z", expiresAt: p.expiresAt,
  availableCreditUsd: 69, keyRemainingUsd: 68 });

describe("reviewed production Jev cohort", () => {
  let home, dir, store, p;
  const save = (filename, value) => fs.writeFileSync(path.join(dir, filename), JSON.stringify(value), { mode: 0o600 });
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mov437-"));
    dir = path.join(home, ".config", "moviecal"); fs.mkdirSync(dir, { recursive: true });
    p = policy();
    save("jev-cohort.json", { enabled: false, policy: p });
    save("jev-cohort-approval.json", approval(p));
    fs.writeFileSync(path.join(dir, "openrouter-jev.env"), "OPENROUTER_API_KEY=fake-only\n", { mode: 0o600 });
    store = new JevCohortStore({ home, configPath: path.join(dir, "jev-cohort.json"),
      approvalPath: path.join(dir, "jev-cohort-approval.json"), ledgerPath: path.join(dir, "jev-cohort-ledger.json") });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const issue = (id, labels = ["worker:codex", "router:jev"]) => ({ identifier: id, labels });
  const account = { keyUsageUsd: 1, keyRemainingUsd: 68, availableCreditUsd: 69 };

  it("binds complete policy and account review before activation", () => {
    expect(store.state(NOW).status).toBe("disabled");
    expect(store.activate(NOW).status).toBe("active");
    const changed = { ...p, priorOutlayUsd: 6 };
    expect(validateCohortApproval(changed, approval(p), NOW)).toMatch(/changed/);
    save("jev-cohort.json", { enabled: true, policy: changed });
    expect(store.state(NOW).status).toBe("invalid");
  });

  it("requires distinct exact pairs, UTC expiry and reviewed aliases", () => {
    expect(validateCohortPolicy({ ...p, control: { ...p.control, worker: "claude" } })).toMatch(/control/);
    expect(validateCohortPolicy({ ...p, pairs: [{ routed: "MOV-10", control: "MOV-10" }] })).toMatch(/pairs/);
    expect(validateCohortPolicy({ ...p, pairs: Array.from({ length: 13 }, (_, n) => ({ routed: `MOV-${n + 1}`, control: `MOV-${n + 21}` })) })).toMatch(/pairs/);
    expect(validateCohortPolicy({ ...p, expiresAt: "2026-10-16T12:00:00.000Z" })).toMatch(/14 days/);
    expect(validateCohortPolicy({ ...p, modelAliases: {} })).toMatch(/aliases/);
  });

  it("admits only exact eligible Codex issues and preserves both side caps and pins", () => {
    store.activate(NOW);
    expect(store.admit(issue("MOV-14"), { worker: "codex", tier: "default", effort: "medium", now: NOW }).admitted).toBe(false);
    expect(store.admit(issue("MOV-10", ["router:jev", "risk:high"]), { worker: "codex", tier: "default", effort: "medium", now: NOW }).admitted).toBe(false);
    expect(store.admit(issue("MOV-11", []), { worker: "codex", tier: "strong", effort: "high", now: NOW }).admitted).toBe(false);
    const routed = store.admit(issue("MOV-10"), { worker: "codex", tier: "default", effort: "medium", now: NOW });
    const fixed = store.admit(issue("MOV-11", []), { worker: "codex", tier: "default", effort: "medium", now: NOW });
    expect([routed.record.side, fixed.record.side]).toEqual(["routed", "control"]);
    expect(store.state(NOW)).toMatchObject({ routed: 1, control: 1 });
    expect(store.admit(issue("MOV-11", []), { worker: "codex", tier: "default", effort: "medium", now: NOW }).existing).toBe(true);
  });

  it("runs fixed control through the guarded transport with a pinned model and effort", () => {
    store.activate(NOW);
    const record = store.admit(issue("MOV-11", []), { worker: "codex", tier: "default", effort: "medium", now: NOW }).record;
    const transport = resolveCohortTransport(store, record, { home });
    const checked = validateOpenRouterTransport(transport, { cwd: path.join(home, "worktree"), home });
    expect(checked.policy).toMatchObject({ side: "control", model: "openai/fixture", provider: "OpenAI", effort: "medium" });
    expect(buildOpenRouterRequest({ model: "openai/fixture", reasoning: { effort: "medium" }, input: "fixture" }, checked.policy).model).toBe("openai/fixture");
    expect(() => buildOpenRouterRequest({ model: "openai/fixture", reasoning: { effort: "high" } }, checked.policy)).toThrow(/policy/);
  });

  it("checks approval and dedicated key before a fresh assignment is consumed", () => {
    store.activate(NOW);
    const prospective = { issue: "MOV-11", side: "control", policyHash: policyDigest(p) };
    const transport = resolveCohortTransport(store, prospective, { home, preview: true });
    expect(validateOpenRouterTransport(transport, { cwd: path.join(home, "worktree"), home, cohortAdmissionPreview: true }).policy.side).toBe("control");
    fs.chmodSync(path.join(dir, "openrouter-jev.env"), 0o644);
    expect(() => validateOpenRouterTransport(transport, { cwd: path.join(home, "worktree"), home, cohortAdmissionPreview: true })).toThrow(/credential/);
    expect(store.get("MOV-11")).toBeNull();
  });

  it("reserves the full remaining key allowance, counts invoices and fees once, and survives restart", () => {
    store.activate(NOW);
    store.admit(issue("MOV-10"), { worker: "codex", tier: "default", effort: "medium", now: NOW });
    store.reserve("request-1", "MOV-10", account, NOW);
    expect(store.state(NOW).status).toBe("pending-invoice");
    expect(() => store.reserve("request-2", "MOV-10", account, NOW)).toThrow(/stopped|pending/);
    const invoice = { invoiceId: "invoice-1", amountUsd: 0.2, model: "openai/fixture", provider: "OpenAI", effort: "medium", account };
    store.finish("request-1", invoice, NOW);
    store.finish("request-1", invoice, NOW);
    store.recordFee({ id: "fee-1", amountUsd: 0.1 });
    store.recordFee({ id: "fee-1", amountUsd: 0.1 });
    expect(() => store.recordFee({ id: "fee-1", amountUsd: 0.2 })).toThrow(/changed/);
    const restarted = new JevCohortStore({ home, configPath: store.configPath,
      approvalPath: store.approvalPath, ledgerPath: store.ledger.statePath });
    expect(restarted.state(NOW)).toMatchObject({ routed: 1, spentUsd: 5.8, pending: 0 });
  });

  it("stops immediately on unknown account evidence and cannot resume paid work by restart", () => {
    store.activate(NOW);
    store.admit(issue("MOV-10"), { worker: "codex", tier: "default", effort: "medium", now: NOW });
    expect(() => store.reserve("request-1", "MOV-10", { ...account, availableCreditUsd: null }, NOW)).toThrow(/account/);
    expect(store.state(NOW).status).toBe("disabled");
    expect(store.export().stoppedReason).toBe("unknown-or-excess-account-exposure");
  });
});
