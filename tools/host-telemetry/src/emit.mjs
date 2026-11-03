// Best-effort marker emitter (MOV-495). The write runs in a detached child
// process (bin/write-marker.mjs) so a stalled or unwritable telemetry directory
// can never fail, block or noticeably slow the caller. The timestamp is taken
// here, before the spawn, so events keep their true order.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { telemetryDir } from "./common.mjs";

const WRITER = fileURLToPath(new URL("../bin/write-marker.mjs", import.meta.url));
export const DEFAULT_WAIT_MS = 2000;

let warned = false;

export function resetEmitWarning() {
  warned = false;
}

function warnOnce(warn, reason) {
  if (warned) return;
  warned = true;
  try {
    warn(`host telemetry: marker write failed (${reason}); further failures are not reported`);
  } catch {
    // logging is best effort too
  }
}

/**
 * Fire-and-forget by default. With `wait: true` the returned promise settles
 * (true = written, false = failed or timed out) within `timeoutMs`, for short
 * lived callers such as runner hooks that must not exit before the child runs.
 * Never throws and never rejects.
 */
export function emitMarker(
  fields,
  { env = process.env, now = Date.now, spawnImpl = spawn, writer = WRITER, warn = console.error, wait = false, timeoutMs = DEFAULT_WAIT_MS } = {},
) {
  try {
    const payload = JSON.stringify({ fields, dir: telemetryDir(env), ms: now() });
    const child = spawnImpl(process.execPath, [writer, payload], { detached: true, stdio: "ignore" });
    if (!wait) {
      child.on("error", (error) => warnOnce(warn, error.message));
      child.on("exit", (code) => {
        if (code !== 0) warnOnce(warn, `writer exit ${code}`);
      });
      child.unref();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        warnOnce(warn, `no result within ${timeoutMs}ms`);
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve(false);
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        warnOnce(warn, error.message);
        resolve(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) warnOnce(warn, `writer exit ${code}`);
        resolve(code === 0);
      });
    });
  } catch (error) {
    warnOnce(warn, error.message);
    return Promise.resolve(false);
  }
}
