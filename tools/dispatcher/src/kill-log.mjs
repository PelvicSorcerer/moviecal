// Append-only record of every signal the dispatcher sends to a process or
// process group, so an unexplained worker death can be traced to its sender.
import fs from "node:fs";
import path from "node:path";

/**
 * Best effort: evidence must never change kill behavior. `file` is a JSONL path;
 * `caller` names the code path, `reason` why, and `entry` is the registry
 * record (or attempt identity) the target came from.
 */
export function logKill(file, { caller, target, signal, reason, entry = null, delivered = null }) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), dispatcherPid: process.pid,
      caller, target, signal, reason, delivered, entry })}\n`, { mode: 0o600 });
  } catch { /* best effort */ }
}
