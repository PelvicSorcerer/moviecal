// Deep snapshot writer. MOV-494.
import fs from "node:fs";
import path from "node:path";
import { ADMIN_REMINDER } from "./common.mjs";
import { parsePs } from "./parse.mjs";
import { redactText } from "./parse.mjs";
import { SNAPSHOT_MAX_FILES } from "./triggers.mjs";

export const SAMPLE_TIMEOUT_MS = 15_000;
export const LOG_TIMEOUT_MS = 20_000;
const SIMPLE_TIMEOUT_MS = 5_000;
const LOG_PREDICATE =
  'subsystem == "com.apple.memorystatus" OR eventMessage CONTAINS[c] "jetsam" OR eventMessage CONTAINS[c] "memorystatus"';

function section(title, result) {
  const body = result.ok ? result.stdout : `(${result.timedOut ? "timed out, skipped" : "failed"})`;
  return `\n## ${title}\n${redactText(body)}\n`;
}

export function snapshotDir(dir) {
  return path.join(dir, "snapshots");
}

export function pruneSnapshots(snapDir, max = SNAPSHOT_MAX_FILES) {
  const files = fs.readdirSync(snapDir).filter((f) => f.startsWith("snapshot-")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - max))) fs.rmSync(path.join(snapDir, f), { force: true });
}

export async function takeSnapshot({ run, dir, nowMs, reasons }) {
  const snapDir = snapshotDir(dir);
  fs.mkdirSync(snapDir, { recursive: true });
  const iso = new Date(nowMs).toISOString();
  const file = path.join(snapDir, `snapshot-${iso.replace(/:/g, "-")}.txt`);
  const ps = await run("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,rss=,etime=,comm="], { timeoutMs: SIMPLE_TIMEOUT_MS });
  const cpuPs = await run("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,rss=,comm="], { timeoutMs: SIMPLE_TIMEOUT_MS });
  const top = cpuPs.ok ? parsePs(cpuPs.stdout).sort((a, b) => b.cpu - a.cpu).slice(0, 3) : [];
  let text = `# moviecal host telemetry deep snapshot\n# ${ADMIN_REMINDER}\n# time: ${iso}\n# triggers: ${reasons.join("; ")}\n`;
  text += section("process tree (pid ppid %cpu rss_kb etime command)", ps);
  for (const p of top) {
    const r = await run("/usr/bin/sample", [String(p.pid), "2"], { timeoutMs: SAMPLE_TIMEOUT_MS });
    text += section(`sample pid ${p.pid} ${p.command}`, r);
  }
  text += section("vm_stat", await run("/usr/bin/vm_stat", [], { timeoutMs: SIMPLE_TIMEOUT_MS }));
  text += section(
    "unified log, last 2m, memory-status and jetsam",
    await run("/usr/bin/log", ["show", "--last", "2m", "--style", "compact", "--predicate", LOG_PREDICATE], { timeoutMs: LOG_TIMEOUT_MS }),
  );
  fs.writeFileSync(file, text);
  pruneSnapshots(snapDir);
  return file;
}
