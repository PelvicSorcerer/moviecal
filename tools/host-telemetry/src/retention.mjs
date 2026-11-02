// Retention: gzip dated files older than one day, delete after 14 days. MOV-494.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DAY_MS } from "./common.mjs";

export const KEEP_DAYS = 14;

function fileAgeDays(name, nowMs) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(name);
  if (!m) return null;
  const startOfToday = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return Math.round((startOfToday - Date.parse(`${m[1]}T00:00:00Z`)) / DAY_MS);
}

export function applyRetention(dir, nowMs) {
  const result = { gzipped: [], deleted: [] };
  for (const d of [dir, path.join(dir, "snapshots")]) {
    let names;
    try {
      names = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const name of names) {
      const age = fileAgeDays(name, nowMs);
      if (age === null) continue;
      const file = path.join(d, name);
      if (age > KEEP_DAYS) {
        fs.rmSync(file, { force: true });
        result.deleted.push(name);
      } else if (age >= 1 && !name.endsWith(".gz")) {
        fs.writeFileSync(`${file}.gz`, zlib.gzipSync(fs.readFileSync(file)));
        fs.rmSync(file, { force: true });
        result.gzipped.push(name);
      }
    }
  }
  return result;
}
