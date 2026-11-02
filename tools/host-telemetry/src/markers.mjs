// Marker library: the one shared writer and reader for
// <telemetry dir>/markers-YYYY-MM-DD.jsonl (UTC date). MOV-494.
//
// Schema, one JSON object per line (after one header line {"header":true,...}):
//   { "t": ISO UTC with ms, "source": "runner"|"sim-lease"|"dispatcher"|"sampler",
//     "event": string, ...extra fields }
//
// Pairing: an event named "<name>-start" opens a span and "<name>-end" closes it.
// Spans pair on (source, name, id), where "id" is an optional string field
// (e.g. the runner job id). A start with no matching end is "open"; starts older
// than 6 hours are ignored. The sampler is busy while any span is open.
// Events from source "sampler" never open spans (its events are "started", "snapshot").
// Extra fields must be small, non-secret scalars; t/source/event cannot be overridden.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DAY_MS, headerLine, utcDate } from "./common.mjs";

export const MARKER_SOURCES = ["runner", "sim-lease", "dispatcher", "sampler"];
export const OPEN_MARKER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function markerFile(dir, ms) {
  return path.join(dir, `markers-${utcDate(ms)}.jsonl`);
}

export function appendMarker({ source, event, ...fields }, { dir, now = Date.now } = {}) {
  if (!MARKER_SOURCES.includes(source)) throw new Error(`invalid marker source: ${source}`);
  if (typeof event !== "string" || !event) throw new Error("marker event must be a non-empty string");
  const ms = now();
  const line = JSON.stringify({ ...fields, t: new Date(ms).toISOString(), source, event });
  const file = markerFile(dir, ms);
  fs.mkdirSync(dir, { recursive: true });
  let prefix = "";
  if (!fs.existsSync(file)) prefix = headerLine("markers") + "\n";
  fs.appendFileSync(file, prefix + line + "\n");
  return JSON.parse(line);
}

function readLines(file) {
  let text;
  try {
    const raw = fs.readFileSync(file);
    text = file.endsWith(".gz") ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && !obj.header && typeof obj.t === "string" && typeof obj.event === "string") out.push(obj);
    } catch {
      // torn or corrupt line: skip
    }
  }
  return out;
}

export function readMarkers({ dir, sinceMs, untilMs }) {
  const out = [];
  for (let day = Math.floor(sinceMs / DAY_MS) * DAY_MS; day <= untilMs; day += DAY_MS) {
    const base = markerFile(dir, day);
    for (const file of [base, `${base}.gz`]) {
      if (fs.existsSync(file)) out.push(...readLines(file));
    }
  }
  return out
    .filter((m) => {
      const ms = Date.parse(m.t);
      return ms >= sinceMs && ms <= untilMs;
    })
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

export function openMarkers(markers) {
  const open = new Map();
  for (const m of markers) {
    if (m.source === "sampler") continue;
    const match = /^(.+)-(start|end)$/.exec(m.event);
    if (!match) continue;
    const key = `${m.source}:${match[1]}:${m.id ?? ""}`;
    if (match[2] === "start") open.set(key, m);
    else open.delete(key);
  }
  return [...open.values()];
}

export function hasOpenMarker({ dir, nowMs }) {
  const markers = readMarkers({ dir, sinceMs: nowMs - OPEN_MARKER_MAX_AGE_MS, untilMs: nowMs });
  return openMarkers(markers).length > 0;
}
