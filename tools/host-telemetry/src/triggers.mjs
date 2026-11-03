// Deep-snapshot trigger logic and the snapshot gate (rate limit, cap, no overlap). MOV-494.
export const WARN_SUSTAIN_MS = 60_000;
export const LOAD_SUSTAIN_MS = 60_000;
export const LOAD_FACTOR = 2;
export const DISK_LOW_GB = 10;
export const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60_000;
export const SNAPSHOT_MAX_FILES = 20;

export class TriggerState {
  constructor() {
    this.warnSince = null;
    this.warnSwapStart = null;
    this.loadSince = null;
    this.noJobSince = null;
  }

  // Returns the list of trigger reasons for this sample (empty when none).
  observe(sample, nowMs) {
    const reasons = [];
    if (sample.pressure !== null && sample.pressure >= 4) reasons.push("memory pressure critical");

    if (sample.pressure !== null && sample.pressure >= 2) {
      if (this.warnSince === null) {
        this.warnSince = nowMs;
        this.warnSwapStart = sample.swapUsedMb;
      }
      const grew = sample.swapUsedMb !== null && this.warnSwapStart !== null && sample.swapUsedMb > this.warnSwapStart;
      if (nowMs - this.warnSince >= WARN_SUSTAIN_MS && grew) reasons.push("sustained memory pressure warn with swap growth");
    } else if (sample.pressure !== null) {
      this.warnSince = null;
      this.warnSwapStart = null;
    }

    const limit = sample.thermal?.speedLimit;
    if (limit !== null && limit !== undefined && limit < 100) reasons.push(`thermal speed limit ${limit}`);
    if (sample.diskFreeGb !== null && sample.diskFreeGb < DISK_LOW_GB) reasons.push(`free disk ${sample.diskFreeGb} GB`);

    if (sample.load?.[0] > LOAD_FACTOR * sample.cores) {
      if (this.loadSince === null) this.loadSince = nowMs;
      if (nowMs - this.loadSince >= LOAD_SUSTAIN_MS) reasons.push(`load ${sample.load[0]} above ${LOAD_FACTOR}x ${sample.cores} cores`);
    } else {
      this.loadSince = null;
    }

    if (sample.loadNoJob === true) {
      if (this.noJobSince === null) this.noJobSince = nowMs;
      if (nowMs - this.noJobSince >= LOAD_SUSTAIN_MS) reasons.push("high load with no job running");
    } else {
      this.noJobSince = null;
    }
    return reasons;
  }
}

// True: high load, no Runner.Worker, no open job marker. null: unknowable because ps failed. Ignores
// hasBusyProcess on purpose (a stale booted simulator would look like a running job).
export function computeLoadNoJob({ load, cores, runnerWorker, markerBusy }) {
  if (!(load?.[0] > LOAD_FACTOR * cores)) return false;
  if (markerBusy || runnerWorker === true) return false;
  return runnerWorker === null ? null : true;
}

export class SnapshotGate {
  constructor() {
    this.lastStartMs = null;
    this.inFlight = false;
  }

  tryStart(nowMs) {
    if (this.inFlight) return false;
    if (this.lastStartMs !== null && nowMs - this.lastStartMs < SNAPSHOT_MIN_INTERVAL_MS) return false;
    this.inFlight = true;
    this.lastStartMs = nowMs;
    return true;
  }

  finish() {
    this.inFlight = false;
  }
}
