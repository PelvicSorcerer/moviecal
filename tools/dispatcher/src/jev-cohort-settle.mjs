// A worker and its provider broker die together (the supervisor reaps one when
// the other exits), so once an attempt's worker has exited no request of that
// attempt can still be in flight. Settle what it left pending through the same
// fail-closed path as `jev-cohort reconcile`: usage is charged from the key's
// own counter, never estimated, and anything not attributable stops the cohort.
import fs from "node:fs";
import path from "node:path";
import { readOpenRouterAccount } from "./openrouter-account.mjs";
import { OPENROUTER_UPSTREAM } from "./openrouter-transport.mjs";

export async function settleExitedCohortRequests(store, issue, { readAccount = readOpenRouterAccount, upstream = OPENROUTER_UPSTREAM, now = new Date() } = {}) {
  if (!store.pendingFor(issue).length) return null;
  const credential = path.join(store.storeRoot, "openrouter-jev.env");
  const match = /^OPENROUTER_API_KEY=([A-Za-z0-9_-]{8,256})$/.exec(fs.readFileSync(credential, "utf8").trim());
  if (!match) throw new Error("provider credential invalid");
  const account = await readAccount(upstream, match[1]);
  return store.reconcileOrphans(account, { apply: true, minAgeMs: 0, now, issue, reason: "worker-exited-request-settled" });
}
