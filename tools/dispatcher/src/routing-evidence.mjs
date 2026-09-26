import fs from "node:fs";
import path from "node:path";

/** Only the run loop's bounded routing projection belongs in this record. */
export function writeRoutingEvidence(logDir, record) {
  const boundedId = (value) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
  const selected = record.selected ? {
    worker: record.selected.worker,
    tier: record.selected.tier,
    modelId: boundedId(record.selected.modelId),
    reasoningEffort: boundedId(record.selected.reasoningEffort),
    turnBudget: record.selected.turnBudget,
    reason: record.selected.reason,
  } : null;
  const evidence = {
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
