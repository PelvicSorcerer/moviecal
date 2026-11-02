// The sampling loop: injected clock and command runner so it is testable. MOV-494.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DAY_MS, headerLine, utcDate } from "./common.mjs";
import { appendMarker, hasOpenMarker } from "./markers.mjs";
import { applyRetention } from "./retention.mjs";
import { createCpuSampler } from "./parse.mjs";
import { collectSample } from "./sample.mjs";
import { takeSnapshot } from "./snapshot.mjs";
import { SnapshotGate, TriggerState, computeLoadNoJob } from "./triggers.mjs";

export const IDLE_INTERVAL_MS = 5000;
export const BUSY_INTERVAL_MS = 1500;

export function appendSample(dir, sample, nowMs) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `samples-${utcDate(nowMs)}.jsonl`);
  const prefix = fs.existsSync(file) ? "" : headerLine("samples") + "\n";
  fs.appendFileSync(file, prefix + JSON.stringify(sample) + "\n");
}

// clock: { now(), sleep(ms) }. Stops when shouldStop() is true.
export async function runLoop({ run, clock, dir, shouldStop, cores, loadavg, readCpus = os.cpus, log = () => {} }) {
  const cpu = createCpuSampler(readCpus);
  const triggers = new TriggerState();
  const gate = new SnapshotGate();
  const snapshots = [];
  let lastRetention = null;
  let next = clock.now();
  while (!shouldStop()) {
    const startMs = clock.now();
    if (lastRetention === null || startMs - lastRetention >= DAY_MS) {
      lastRetention = startMs;
      try {
        applyRetention(dir, startMs);
      } catch (error) {
        log(`retention failed: ${error.message}`);
      }
    }
    const sample = await collectSample({ run, nowMs: startMs, cores, loadavg: loadavg?.(), cpu });
    let markerBusy = false;
    try {
      markerBusy = hasOpenMarker({ dir, nowMs: startMs });
    } catch (error) {
      sample.notes.push(`markers: ${error.message}`);
    }
    const busy = markerBusy || sample.busyProcess === true;
    sample.busy = busy;
    delete sample.busyProcess;
    sample.loadNoJob = computeLoadNoJob({ load: sample.load, cores: sample.cores, runnerWorker: sample.runnerWorker, markerBusy });
    delete sample.runnerWorker;
    try {
      appendSample(dir, sample, startMs);
    } catch (error) {
      log(`sample write failed: ${error.message}`);
    }

    const reasons = triggers.observe(sample, startMs);
    if (reasons.length && gate.tryStart(startMs)) {
      const done = takeSnapshot({ run, dir, nowMs: startMs, reasons })
        .then((file) => {
          appendMarker({ source: "sampler", event: "snapshot", file: path.basename(file), reasons }, { dir, now: clock.now });
        })
        .catch((error) => log(`snapshot failed: ${error.message}`))
        .finally(() => gate.finish());
      snapshots.push(done);
    }

    next += busy ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS;
    const now = clock.now();
    if (next < now) next = now;
    await clock.sleep(next - now);
  }
  await Promise.all(snapshots);
}
