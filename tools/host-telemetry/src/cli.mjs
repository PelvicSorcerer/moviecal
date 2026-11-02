// CLI entry for bin/sampler.mjs. MOV-494.
import os from "node:os";
import { ADMIN_REMINDER, telemetryDir } from "./common.mjs";
import { runCommand } from "./exec.mjs";
import { runLoop } from "./loop.mjs";
import { appendMarker } from "./markers.mjs";
import { collectSample } from "./sample.mjs";

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function main(argv, { run = runCommand, clock = realClock, out = console.log, dir = telemetryDir() } = {}) {
  out(ADMIN_REMINDER);
  if (argv.includes("--once")) {
    out(JSON.stringify(await collectSample({ run, nowMs: clock.now() }), null, 2));
    return 0;
  }
  out(`moviecal telemetry sampler writing to ${dir}`);
  appendMarker({ source: "sampler", event: "started", pid: process.pid, host: os.hostname() }, { dir, now: clock.now });
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await runLoop({ run, clock, dir, shouldStop: () => stopping, log: (m) => console.error(m) });
  return 0;
}
