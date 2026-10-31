import fs from "node:fs";
import path from "node:path";

/** Only the run loop's bounded routing projection belongs in this record. */
export function writeRoutingEvidence(logDir, record) {
  const boundedId = (value) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
  // MOV-427: the Jev router-arm admission, when this issue was admitted to
  // one. Bounded identifiers and a UTC timestamp only -- never a model,
  // provider, or price, since no live routing exists yet.
  const jev = record.selected?.jev ? {
    trialId: boundedId(record.selected.jev.trialId),
    armId: boundedId(record.selected.jev.armId),
    policyHash: boundedId(record.selected.jev.policyHash),
    routingReason: record.selected.jev.routingReason,
    assignedAt: record.selected.jev.assignedAt,
  } : null;
  const selected = record.selected ? {
    worker: record.selected.worker,
    tier: record.selected.tier,
    modelId: boundedId(record.selected.modelId),
    reasoningEffort: boundedId(record.selected.reasoningEffort),
    turnBudget: record.selected.turnBudget,
    reason: record.selected.reason,
    jev,
  } : null;
  const evidence = {
    kind: "routing-decision",
    issue: boundedId(record.issue),
    at: record.at,
    decision: record.decision,
    poll: record.poll,
    refreshed: record.refreshed,
    selected,
  };
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, "routing-decisions.jsonl"), `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
}
