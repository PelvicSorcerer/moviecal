// Host-wide circuit breaker for failure signatures that mean "this Mac's own
// infrastructure is broken", not "this issue's task failed" (MOV-180).
//
// Persisted outside the repo (same home as worktrees.json — see config.mjs)
// so the breaker survives a dispatcher restart: the underlying condition
// (e.g. a nested-sandbox collision in one adapter's tool sandbox) does not
// clear itself just because the daemon process restarted.
//
// MOV-403: an open breaker also persists its own probe schedule. A half-open
// probe is admitted only once `nextProbeAt` has passed; claiming one counts it
// as failed up front (so a crash mid-probe cannot buy an immediate retry after
// restart) and pushes the deadline out on a growing, capped backoff. After
// `maxAutoProbes` unproven probes automatic probing stops until an operator
// authorizes one (`dispatcher breaker probe-now`). Only positive evidence from
// the affected adapter, passed to `recover()`, closes the breaker.
//
// Named breakers share one state file (keyed by reason) so an unrelated
// breaker never contends with another. Atomic fsync+rename with a `.bak`
// recovery copy, matching WorktreeManager's saveState.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_PROBE_BACKOFF = Object.freeze({
  baseMs: 10 * 60 * 1000,
  factor: 2,
  maxMs: 4 * 60 * 60 * 1000,
  maxAutoProbes: 6,
});

const HISTORY_LIMIT = 10;

/** Delay before the next automatic probe after `failedProbes` unproven probes. */
export function probeDelayMs(failedProbes, backoff = DEFAULT_PROBE_BACKOFF) {
  const exponent = Math.max(0, Number(failedProbes) || 0);
  return Math.min(backoff.maxMs, backoff.baseMs * backoff.factor ** exponent);
}

export class CircuitBreakerStore {
  constructor(statePath, { now = () => new Date(), backoff = DEFAULT_PROBE_BACKOFF } = {}) {
    if (!statePath) throw new Error("statePath is required");
    this.statePath = statePath;
    this.now = now;
    this.backoff = { ...DEFAULT_PROBE_BACKOFF, ...backoff };
  }

  load() {
    if (!fs.existsSync(this.statePath)) return {};
    const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
    try {
      return read(this.statePath);
    } catch (primaryError) {
      try {
        return read(`${this.statePath}.bak`);
      } catch {
        throw new Error(`circuit breaker state is corrupt and no valid backup exists: ${primaryError.message}`);
      }
    }
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tempPath, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tempPath, 0o600);
    if (fs.existsSync(this.statePath)) {
      try {
        fs.copyFileSync(this.statePath, `${this.statePath}.bak`);
      } catch {
        // best-effort backup; a missing/corrupt prior file must never block a new write
      }
    }
    fs.renameSync(tempPath, this.statePath);
    try {
      const dirFd = fs.openSync(path.dirname(this.statePath), "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // directory fsync is best-effort (not supported on every filesystem)
    }
  }

  /** Is the named breaker currently open (tripped)? */
  isOpen(name) {
    return Boolean(this.load()[name]?.open);
  }

  /**
   * The named breaker's admission view at `at`. `due` is true only for an open
   * breaker whose persisted deadline has passed (or that an operator authorized);
   * a legacy record with no deadline is treated as due once, which then
   * persists a schedule via claimProbe().
   */
  status(name, at = this.now()) {
    const record = this.load()[name];
    if (!record?.open) return { name, open: false, due: false, nextProbeAt: null, adapter: null, reason: null };
    const operatorAuthorized = Boolean(record.operatorProbe);
    const exhausted = !operatorAuthorized && (record.failedProbes || 0) >= this.backoff.maxAutoProbes;
    const next = record.nextProbeAt ? new Date(record.nextProbeAt) : null;
    const due = operatorAuthorized || (!exhausted && (!next || next.getTime() <= at.getTime()));
    return {
      name,
      open: true,
      due,
      exhausted,
      nextProbeAt: exhausted ? null : record.nextProbeAt || null,
      failedProbes: record.failedProbes || 0,
      adapter: record.adapter || null,
      reason: record.reason || null,
      evidence: record.evidence || null,
      trippedAt: record.trippedAt || null,
      lastFailureAt: record.lastFailureAt || null,
      probe: record.probe || null,
      operatorProbe: record.operatorProbe || null,
    };
  }

  /**
   * Trip the named breaker. A first trip opens it with the base delay. A trip
   * while already open (a failed probe) keeps its history and never moves the
   * deadline earlier. Returns whether this is a repeat of the same condition
   * already reported for the same issue, so callers can avoid duplicate comments.
   */
  trip(name, reason, { adapter = null, evidence = null, issue = null, at = this.now() } = {}) {
    const state = this.load();
    const prior = state[name]?.open ? state[name] : null;
    const failedProbes = prior?.failedProbes || 0;
    const earliest = at.getTime() + probeDelayMs(failedProbes, this.backoff);
    const priorNext = prior?.nextProbeAt ? new Date(prior.nextProbeAt).getTime() : 0;
    const noticeKey = `${adapter || ""}|${reason || ""}`;
    const repeatNotice = Boolean(prior && issue && prior.lastNotice?.issue === issue && prior.lastNotice?.key === noticeKey);
    state[name] = {
      open: true,
      reason: reason || null,
      adapter: adapter || prior?.adapter || null,
      evidence: evidence || null,
      trippedAt: prior?.trippedAt || at.toISOString(),
      lastFailureAt: at.toISOString(),
      failedProbes,
      nextProbeAt: new Date(Math.max(earliest, priorNext)).toISOString(),
      probe: null,
      operatorProbe: null,
      lastNotice: issue ? { issue, key: noticeKey } : prior?.lastNotice || null,
      history: [...(prior?.history || []), { at: at.toISOString(), reason: reason || null, issue }].slice(-HISTORY_LIMIT),
    };
    this.save(state);
    return { firstTrip: !prior, repeatNotice, nextProbeAt: state[name].nextProbeAt };
  }

  /**
   * Reserve the single half-open probe for an open breaker. Counted as an
   * unproven probe immediately, so the next deadline is persisted before any
   * worker starts and survives a crash or restart during the probe.
   */
  claimProbe(name, { issue = null, at = this.now() } = {}) {
    const state = this.load();
    const record = state[name];
    if (!record?.open) return null;
    const failedProbes = (record.failedProbes || 0) + 1;
    state[name] = {
      ...record,
      failedProbes,
      nextProbeAt: new Date(at.getTime() + probeDelayMs(failedProbes, this.backoff)).toISOString(),
      probe: { issue, startedAt: at.toISOString(), operatorAuthorized: Boolean(record.operatorProbe) },
      operatorProbe: null,
    };
    this.save(state);
    return state[name];
  }

  /**
   * Operator-led recovery: make the next poll admit one probe before the
   * deadline (and after the automatic budget is spent). History and the
   * failed-probe count are kept; the probe still runs under normal confinement.
   */
  authorizeProbe(name, { by = "operator", at = this.now() } = {}) {
    const state = this.load();
    const record = state[name];
    if (!record?.open) return null;
    state[name] = { ...record, operatorProbe: { by, authorizedAt: at.toISOString() } };
    this.save(state);
    return state[name];
  }

  /**
   * Close the named breaker on positive evidence. A breaker recorded against
   * one adapter is not closed by another adapter's success.
   */
  recover(name, { adapter = null, evidence = null, at = this.now() } = {}) {
    const state = this.load();
    const record = state[name];
    if (!record?.open) return false;
    if (record.adapter && record.adapter !== adapter) return false;
    state[name] = {
      open: false,
      reason: null,
      clearedAt: at.toISOString(),
      recoveredBy: { adapter, evidence },
      history: record.history || [],
    };
    this.save(state);
    return true;
  }

  /** Unconditionally clear the named breaker. A no-op when already closed. */
  clear(name) {
    const state = this.load();
    if (!state[name]?.open) return;
    state[name] = { open: false, reason: null, clearedAt: this.now().toISOString(), history: state[name].history || [] };
    this.save(state);
  }
}

/** Operator-facing snapshot of every named breaker (doctor and `breaker status`). */
export function describeBreakers(store, names, at = store.now()) {
  return names.map((name) => {
    const status = store.status(name, at);
    if (!status.open) return { name, open: false, line: `${name}: closed` };
    const when = status.exhausted
      ? "automatic probes exhausted; run `dispatcher breaker probe-now` after fixing the cause"
      : status.operatorProbe
        ? `operator-authorized probe pending (by ${status.operatorProbe.by} at ${status.operatorProbe.authorizedAt})`
        : `next probe ${status.due ? "due now" : `not before ${status.nextProbeAt}`}`;
    const adapter = status.adapter ? ` on ${status.adapter}` : "";
    return {
      name,
      open: true,
      ...status,
      line: `${name}: OPEN${adapter} since ${status.trippedAt}; ${status.failedProbes} unproven probe(s); ${when}; reason: ${status.reason}`,
    };
  });
}

/**
 * `dispatcher breaker status` (read-only) and
 * `dispatcher breaker probe-now <name>` (authorizes one early probe; deletes nothing).
 */
export function runBreakerCommand(args, store, names, { print = console.log, printError = console.error, operator = "operator" } = {}) {
  const [action = "status", name] = args;
  if (action === "status") {
    for (const entry of describeBreakers(store, names)) print(entry.line);
    return 0;
  }
  if (action === "probe-now") {
    if (!names.includes(name)) {
      printError(`Usage: dispatcher breaker probe-now <${names.join("|")}>`);
      return 1;
    }
    const record = store.authorizeProbe(name, { by: operator });
    if (!record) {
      printError(`${name} is not open; nothing to probe.`);
      return 1;
    }
    print(`${name}: the next poll may admit one recovery probe on ${record.adapter || "any adapter"}. It runs under normal worker confinement; state and history are kept.`);
    return 0;
  }
  printError("Usage: dispatcher breaker <status|probe-now <name>>");
  return 1;
}
