import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JevCohortStore, policyDigest, validateCohortPolicy,
  validateCohortApproval, resolveCohortTransport, assertCohortBinding } from "../src/jev-cohort.mjs";
import { validateOpenRouterTransport, buildOpenRouterRequest } from "../src/openrouter-transport.mjs";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const policy = () => ({ trialId: "fixture-1", route: "codex-openrouter-responses",
  activatedAt: "2026-10-01T12:00:00.000Z", expiresAt: "2026-10-10T12:00:00.000Z",
  pairs: [{ routed: "MOV-10", control: "MOV-11" }, { routed: "MOV-12", control: "MOV-13" }],
  routed: { model: "typesafe/jev-router", worker: "codex", tier: "default" },
  control: { model: "openai/fixture", worker: "codex", provider: "OpenAI", providerSlug: "openai", effort: "medium", tier: "default" },
  keyId: "fixture_key", workspaceId: "fixture_workspace", keyLimitUsd: 69,
  allInCeilingUsd: 75, priorOutlayUsd: 5, baselineKeyUsageUsd: 1, purchaseFeesUsd: 0.5,
  modelAliases: { "openai/fixture": "openai/fixture", "~fixture": "openai/fixture" } });
const approval = (p) => ({ issue: "MOV-431", owner: "Adam Moore", ownerApproved: true,
  securityReviewPassed: true, accountPolicyReviewed: true, effectiveEligibilityUnrestricted: true,
  promptLoggingOff: true, zdrOff: true, dataCollectionUnrestricted: true,
  priorOutlayBasisReviewed: true, existingCreditOnlyReviewed: true, hardKeyCapReviewed: true,
  dedicatedKeyExclusiveReviewed: true, paymentBound: "dedicated-key-total-limit",
  keyLimitUsd: 69, allInCeilingUsd: 75,
  keyId: p.keyId, workspaceId: p.workspaceId, policySha256: policyDigest(p),
  reviewedAt: "2026-10-01T11:00:00.000Z", expiresAt: p.expiresAt,
  availableCreditUsd: 69, totalCreditsUsd: 69, totalUsageUsd: 0, keyRemainingUsd: 68 });

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
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });
  const issue = (id, labels = ["worker:codex", "router:jev"]) => ({ identifier: id, labels });
  const account = { keyUsageUsd: 1, keyRemainingUsd: 68, availableCreditUsd: 69,
    totalCreditsUsd: 69, totalUsageUsd: 0 };

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
    expect(validateCohortPolicy({ ...p, control: { ...p.control, providerSlug: undefined } })).toMatch(/control/);
    expect(validateCohortPolicy({ ...p, control: { ...p.control, providerSlug: "OpenAI" } })).toMatch(/control/);
    expect(validateCohortPolicy({ ...p, pairs: [{ routed: "MOV-10", control: "MOV-10" }] })).toMatch(/pairs/);
    expect(validateCohortPolicy({ ...p, pairs: Array.from({ length: 13 }, (_, n) => ({ routed: `MOV-${n + 1}`, control: `MOV-${n + 21}` })) })).toMatch(/pairs/);
    expect(validateCohortPolicy({ ...p, expiresAt: "2026-10-16T12:00:00.000Z" })).toMatch(/14 days/);
    expect(validateCohortPolicy({ ...p, modelAliases: {} })).toMatch(/aliases/);
    expect(validateCohortPolicy({ ...p, priorOutlayUsd: 7.1 })).toMatch(/key liability/);
    expect(validateCohortApproval(p, { ...approval(p), hardKeyCapReviewed: false }, NOW)).toMatch(/approval/);
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
    expect(buildOpenRouterRequest({ model: "openai/fixture", reasoning: { effort: "medium" } }, checked.policy).provider)
      .toEqual({ only: ["openai"], allow_fallbacks: false, require_parameters: true });
    expect(() => buildOpenRouterRequest({ model: "openai/fixture", reasoning: { effort: "high" } }, checked.policy)).toThrow(/policy/);
    const serial = buildOpenRouterRequest({ model: "openai/fixture", reasoning: { effort: "medium" },
      parallel_tool_calls: false, tools: [{ type: "function", name: "exec_command" }] }, checked.policy);
    expect(serial).not.toHaveProperty("parallel_tool_calls");
    expect(serial.tools).toHaveLength(1);
    expect(buildOpenRouterRequest({ model: "openai/fixture", reasoning: { effort: "medium" },
      parallel_tool_calls: true }, checked.policy)).not.toHaveProperty("parallel_tool_calls");
    expect(() => buildOpenRouterRequest({ model: "openai/fixture", reasoning: { effort: "medium" },
      parallel_tool_calls: "true" }, checked.policy)).toThrow(/policy/);
  });

  it("reads the validated descriptor even if the config path is replaced after open", () => {
    store.activate(NOW);
    const replacement = path.join(dir, "replacement.json");
    fs.writeFileSync(replacement, JSON.stringify({ enabled: true, policy: { ...p, priorOutlayUsd: 74 } }), { mode: 0o600 });
    const open = fs.openSync;
    let swapped = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
      const fd = open(file, ...args);
      if (file === store.configPath && !swapped) {
        swapped = true;
        fs.renameSync(file, path.join(dir, "original-config.json"));
        fs.symlinkSync(replacement, file);
      }
      return fd;
    });
    expect(store.policy(NOW)).toEqual(p);
    expect(store.state(NOW).status).toBe("invalid");
  });

  it("rejects linked approvals and does not recover a pending invoice from an older backup", () => {
    const linked = path.join(dir, "linked-approval.json");
    fs.linkSync(store.approvalPath, linked);
    expect(() => store.activate(NOW)).toThrow(/unlinked/);
    fs.unlinkSync(linked);
    store.activate(NOW);
    store.admit(issue("MOV-10"), { worker: "codex", tier: "default", effort: "medium", now: NOW });
    store.reserve("request-1", "MOV-10", account, NOW);
    expect(fs.existsSync(`${store.ledger.statePath}.bak`)).toBe(true);
    fs.writeFileSync(store.ledger.statePath, "broken JSON");
    expect(store.state(NOW)).toMatchObject({ status: "invalid", error: "cohort ledger evidence unavailable" });
    expect(() => store.reserve("request-2", "MOV-10", account, NOW)).toThrow();
    fs.unlinkSync(store.ledger.statePath);
    expect(store.state(NOW).status).toBe("invalid");
  });

  it("binds every attempt to the exact current approval and supports a relocated config store", () => {
    store.activate(NOW);
    const record = store.admit(issue("MOV-11", []), { worker: "codex", tier: "default", effort: "medium", now: NOW }).record;
    const transport = resolveCohortTransport(store, record, { home });
    transport.modelAliases = p.modelAliases;
    expect(() => assertCohortBinding(store, transport)).not.toThrow();
    expect(() => assertCohortBinding(store, { ...transport, policy: { ...transport.policy, provider: "Azure" } })).toThrow(/changed/);
    const relocated = path.join(home, "relocated-state");
    fs.cpSync(dir, relocated, { recursive: true });
    const relocatedStore = new JevCohortStore({ storeRoot: relocated, home,
      configPath: path.join(relocated, "jev-cohort.json"), approvalPath: path.join(relocated, "jev-cohort-approval.json"),
      ledgerPath: path.join(relocated, "jev-cohort-ledger.json") });
    const relocatedTransport = resolveCohortTransport(relocatedStore, record, { home });
    expect(validateOpenRouterTransport(relocatedTransport, { cwd: path.join(home, "worktree"), home }).cohort.storeRoot).toBe(relocated);
    expect(relocatedTransport.credentialPath).toBe(path.join(dir, "openrouter-jev.env"));
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

  it("reserves the provider-enforced liability, counts invoices once, and survives restart", () => {
    store.activate(NOW);
    store.admit(issue("MOV-10"), { worker: "codex", tier: "default", effort: "medium", now: NOW });
    store.reserve("request-1", "MOV-10", account, NOW);
    expect(store.state(NOW).status).toBe("pending-invoice");
    expect(() => store.reserve("request-2", "MOV-10", account, NOW)).toThrow(/stopped|pending/);
    const invoice = { invoiceId: "invoice-1", amountUsd: 0.2, model: "openai/fixture", provider: "OpenAI", effort: "medium", account };
    store.finish("request-1", invoice, NOW);
    store.finish("request-1", invoice, NOW);
    const restarted = new JevCohortStore({ home, configPath: store.configPath,
      approvalPath: store.approvalPath, ledgerPath: store.ledger.statePath });
    expect(restarted.state(NOW)).toMatchObject({ routed: 1, spentUsd: 5.7, pending: 0, keyRemainingUsd: 67.8 });
    store.recordFee({ id: "fee-1", amountUsd: 0.1 });
    store.recordFee({ id: "fee-1", amountUsd: 0.1 });
    expect(() => store.recordFee({ id: "fee-1", amountUsd: 0.2 })).toThrow(/changed/);
    expect(store.export()).toMatchObject({ stoppedReason: "new-fee-requires-owner-reconciliation" });
  });

  it("uses existing credit with a delayed balance without losing the hard in-flight bound", () => {
    const reviewed = { ...approval(p), availableCreditUsd: 0.5, totalCreditsUsd: 10.5, totalUsageUsd: 10 };
    save("jev-cohort-approval.json", reviewed);
    store.activate(NOW);
    store.admit(issue("MOV-10"), { worker: "codex", tier: "default", effort: "medium", now: NOW });
    const funded = { ...account, availableCreditUsd: 0.5, totalCreditsUsd: 10.5, totalUsageUsd: 10 };
    store.reserve("request-1", "MOV-10", funded, NOW);
    expect(store.export().requests[0].reservedUsd).toBe(68);
    const invoice = { invoiceId: "invoice-1", amountUsd: 0.2, model: "openai/fixture",
      provider: "OpenAI", effort: "medium", account: funded };
    store.finish("request-1", invoice, NOW);
    expect(store.state(NOW)).toMatchObject({ spentUsd: 5.7, keyRemainingUsd: 67.8 });
    store.reserve("request-2", "MOV-10", funded, NOW);
    expect(store.export().requests[1].reservedUsd).toBe(67.8);
    const restarted = new JevCohortStore({ home, configPath: store.configPath,
      approvalPath: store.approvalPath, ledgerPath: store.ledger.statePath });
    expect(restarted.state(NOW).status).toBe("pending-invoice");
    expect(() => restarted.reserve("request-3", "MOV-10", funded, NOW)).toThrow();
  });

  it("stops on an unreviewed top-up or unexplained account charge", () => {
    store.activate(NOW);
    store.admit(issue("MOV-10"), { worker: "codex", tier: "default", effort: "medium", now: NOW });
    expect(() => store.reserve("request-1", "MOV-10", { ...account,
      totalCreditsUsd: 70, availableCreditUsd: 70 }, NOW)).toThrow(/exposure/);
    expect(store.export().requests).toHaveLength(0);
  });

  it("refuses account usage without a matching local invoice", () => {
    store.activate(NOW);
    store.admit(issue("MOV-10"), { worker: "codex", tier: "default", effort: "medium", now: NOW });
    expect(() => store.reserve("request-1", "MOV-10", { ...account,
      totalUsageUsd: 0.1, availableCreditUsd: 68.9 }, NOW)).toThrow(/exposure/);
    expect(store.export().stoppedReason).toBe("unknown-or-excess-account-exposure");
  });

  it("retains the reservation and stops on a duplicate or missing invoice", () => {
    store.activate(NOW);
    store.admit(issue("MOV-10"), { worker: "codex", tier: "default", effort: "medium", now: NOW });
    store.reserve("request-1", "MOV-10", account, NOW);
    const invoice = { invoiceId: "invoice-1", amountUsd: 0.2, model: "openai/fixture",
      provider: "OpenAI", effort: "medium", account };
    store.finish("request-1", invoice, NOW);
    store.reserve("request-2", "MOV-10", account, NOW);
    expect(() => store.finish("request-2", invoice, NOW)).toThrow(/duplicate provider invoice/);
    expect(store.export()).toMatchObject({ stoppedReason: "invoice-reconciliation-failed",
      requests: [{ status: "complete" }, { status: "pending" }] });
  });

  it("stops immediately on unknown account evidence and cannot resume paid work by restart", () => {
    store.activate(NOW);
    store.admit(issue("MOV-10"), { worker: "codex", tier: "default", effort: "medium", now: NOW });
    expect(() => store.reserve("request-1", "MOV-10", { ...account, availableCreditUsd: null }, NOW)).toThrow(/account/);
    expect(store.state(NOW).status).toBe("disabled");
    expect(store.export().stoppedReason).toBe("unknown-or-excess-account-exposure");
  });
});
