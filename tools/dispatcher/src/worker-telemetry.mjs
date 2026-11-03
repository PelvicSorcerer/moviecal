// Dispatcher-side host telemetry (MOV-495): worker spawn/exit markers, iOS lease
// markers and ISO-timestamped console lines. Observation only -- nothing here
// changes dispatch behavior, and every failure is swallowed.
import path from "node:path";
import { emitMarker } from "../../host-telemetry/src/emit.mjs";

export function emitDispatcherMarker(event, fields = {}, options = {}) {
  try {
    return emitMarker({ source: "dispatcher", event, ...fields }, options);
  } catch {
    return Promise.resolve(false);
  }
}

/** "initial", "budget-continuation" or the operator-resume attempt id, from the attempt's log directory. */
export function attemptLabel(logDir) {
  const parts = String(logDir ?? "").split(path.sep).filter(Boolean);
  if (parts.at(-2) === "operator-resume") return `operator-resume:${parts.at(-1)}`;
  return parts.at(-1) === "budget-continuation" ? "budget-continuation" : "initial";
}

export function classifyExit({ exitCode, aborted, failed }) {
  if (failed) return "spawn-error";
  if (aborted) return "aborted";
  return exitCode === 0 ? "ok" : "failed";
}

/**
 * Wraps a `spawnWorker`-shaped function: the returned value (a promise, or the
 * steering handle holding one) is the original, untouched.
 */
export function withWorkerMarkers(spawnWorkerFn, { emit = emitDispatcherMarker, now = Date.now, logger = console } = {}) {
  return (args) => {
    const startedAt = now();
    const base = {
      issue: args.issueIdentifier ?? null,
      adapter: args.invocation?.command ? path.basename(args.invocation.command) : null,
      attempt: attemptLabel(args.logDir),
    };
    const settle = (result, failed) => {
      const exitCode = failed ? null : (result?.exitCode ?? null);
      const classification = classifyExit({ exitCode, aborted: Boolean(args.signal?.aborted), failed });
      const durationMs = now() - startedAt;
      try {
        logger.log(`Worker exited for ${base.issue} (${base.adapter}, ${base.attempt}): ${classification}, exit ${exitCode} after ${Math.round(durationMs / 1000)}s`);
      } catch {
        // logging is best effort
      }
      emit("worker-exited", { ...base, exitCode, classification, durationMs });
    };

    const spawned = spawnWorkerFn(args);
    try {
      logger.log(`Worker spawned for ${base.issue} (${base.adapter}, ${base.attempt})`);
    } catch {
      // logging is best effort
    }
    emit("worker-spawned", base);
    const promise = spawned && typeof spawned.then !== "function" ? spawned.promise : spawned;
    Promise.resolve(promise).then((result) => settle(result, false), () => settle(null, true));
    return spawned;
  };
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];

/** Prefixes every console line with an ISO UTC timestamp so the dispatcher log can be lined up with markers. */
export function installTimestampedConsole(target = console, now = () => new Date()) {
  for (const method of CONSOLE_METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args) => {
      const stamp = now().toISOString();
      if (typeof args[0] === "string") original(`${stamp} ${args[0]}`, ...args.slice(1));
      else original(stamp, ...args);
    };
  }
}
