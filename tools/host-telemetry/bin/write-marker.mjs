#!/usr/bin/env node
// Detached marker writer spawned by src/emit.mjs so a slow or stalled disk can
// never block the process that raised the event. argv[2] is JSON:
// { fields: { source, event, ... }, dir, ms }. Exit 0 = written, 1 = failed. MOV-495.
import { appendMarker } from "../src/markers.mjs";

try {
  const { fields, dir, ms } = JSON.parse(process.argv[2]);
  appendMarker(fields, { dir, now: () => ms });
} catch {
  process.exitCode = 1;
}
