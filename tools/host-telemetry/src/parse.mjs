// Pure parsers, redaction and grouping for host command output. MOV-494.
import path from "node:path";

export const MAX_COMMAND_LENGTH = 100;
const SECRET_PREFIX = /(ghp_|gho_|ghs_|github_pat_|sk-|xox[abp]-|lin_api_|lin_oauth_|eyJ|AKIA|Bearer)/i;

// Keeps the executable path only: cuts at the first flag, key=value or token-looking word, and truncates.
export function sanitizeCommand(raw) {
  const kept = [];
  for (const word of String(raw).trim().split(/\s+/)) {
    if (kept.length && (word.startsWith("-") || word.includes("="))) break;
    if (SECRET_PREFIX.test(word) || (!word.startsWith("/") && word.length >= 16 && /\d/.test(word) && /[A-Za-z]/.test(word))) {
      if (kept.length) break;
      kept.push("[redacted]");
    } else {
      kept.push(word);
    }
  }
  const out = kept.join(" ");
  return out.length > MAX_COMMAND_LENGTH ? out.slice(0, MAX_COMMAND_LENGTH - 1) + "…" : out;
}

export function redactText(text) {
  return String(text)
    .replace(/\b(?:ghp_|gho_|ghs_|github_pat_|sk-|xox[abp]-|lin_api_|lin_oauth_)[A-Za-z0-9_\-]{8,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_\-.]{10,}/g, "[redacted]")
    .replace(/\b((?:\w*(?:token|secret|password|passwd|apikey|api_key|auth)\w*)\s*[=:]\s*)\S+/gi, "$1[redacted]");
}

// `ps -axo pid=,ppid=,pcpu=,rss=,comm=` (comm is the executable path, no arguments).
export function parsePs(text) {
  const procs = [];
  for (const line of String(text).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      rssMb: Math.round((Number(m[4]) / 1024) * 10) / 10,
      command: sanitizeCommand(m[5]),
    });
  }
  return procs;
}

export function parseVmStat(text) {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages = (label) => {
    const m = new RegExp(`${label}:\\s+(\\d+)`).exec(text);
    return m ? Number(m[1]) : null;
  };
  const mb = (n) => (n === null ? null : Math.round(((n * page) / 1048576) * 10) / 10);
  return { freeMb: mb(pages("Pages free")), compressorMb: mb(pages("Pages occupied by compressor")) };
}

export function parseSysctlInt(text) {
  const m = /(-?\d+)\s*$/.exec(String(text).trim());
  return m ? Number(m[1]) : null;
}

// `sysctl vm.swapusage`: "total = 3072.00M  used = 2764.50M  free = 307.50M  (encrypted)"
export function parseSwapUsage(text) {
  const m = /used\s*=\s*([\d.]+)([MGK])/.exec(text);
  if (!m) return null;
  const factor = { K: 1 / 1024, M: 1, G: 1024 }[m[2]];
  return Math.round(Number(m[1]) * factor * 10) / 10;
}

// `pmset -g therm`: CPU_Speed_Limit is only listed when throttled.
export function parsePmsetTherm(text) {
  const m = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(text);
  return { speedLimit: m ? Number(m[1]) : 100, warning: /No thermal warning level has been recorded/.test(text) ? "none" : /thermal warning/i.test(text) ? "recorded" : "unknown" };
}

// `df -k /`: available KiB is the 4th column.
export function parseDfFreeGb(text) {
  const line = String(text).trim().split("\n")[1];
  const cols = line?.trim().split(/\s+/);
  const kb = Number(cols?.[3]);
  return Number.isFinite(kb) ? Math.round((kb / 1048576) * 100) / 100 : null;
}

export const GROUPS = ["runner", "xcode", "simulator", "workers", "node", "other"];

export function groupOf(command) {
  const base = path.basename(command);
  if (/Runner\.(Worker|Listener)|actions-runner/.test(command)) return "runner";
  if (/CoreSimulator|\/Simulator\.app|launchd_sim|simctl/.test(command)) return "simulator";
  if (/^(xcodebuild|xctest|XCBBuildService|swift|swiftc|swift-.*|clang.*|ld|SWBBuildService)$/.test(base)) return "xcode";
  if (/^(claude|codex)$/.test(base)) return "workers";
  if (/^(node|vitest)$/.test(base)) return "node";
  return "other";
}

export function rollup(procs) {
  const groups = Object.fromEntries(GROUPS.map((g) => [g, { count: 0, cpu: 0, rssMb: 0 }]));
  for (const p of procs) {
    const g = groups[groupOf(p.command)];
    g.count += 1;
    g.cpu += p.cpu;
    g.rssMb += p.rssMb;
  }
  for (const g of Object.values(groups)) {
    g.cpu = Math.round(g.cpu * 10) / 10;
    g.rssMb = Math.round(g.rssMb * 10) / 10;
  }
  return groups;
}

export function topBy(procs, key, n = 15) {
  return [...procs]
    .sort((a, b) => b[key] - a[key])
    .slice(0, n)
    .map(({ pid, cpu, rssMb, command }) => ({ pid, cpu, rssMb, command }));
}

export function hasBusyProcess(procs) {
  return procs.some((p) => {
    const base = path.basename(p.command);
    return (
      /^(Runner\.Worker|xcodebuild|xctest|Simulator)$/.test(base) ||
      /CoreSimulator\/Devices\//.test(p.command)
    );
  });
}
