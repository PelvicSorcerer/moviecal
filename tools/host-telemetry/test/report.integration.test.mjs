import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../bin/report.mjs";
import { ADMIN_REMINDER } from "../src/common.mjs";
import { buildFixtureDay, iso, tmpRoot } from "./report-fixture.mjs";

function run(argv, fixture, extra = []) {
  const out = [];
  const err = [];
  const code = main(
    [...argv, "--dir", fixture.dir, "--reports-dir", fixture.reports, "--diag-dir", path.join(fixture.dir, "no-diag"), "--now", iso(fixture.nowMs), ...extra],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("report.mjs against a fixture day", () => {
  const fixture = buildFixtureDay({ root: tmpRoot() });

  it("prints timeline, statistics, groups, overlaps, snapshots, crash reports and gaps from gzipped files", () => {
    const { code, out } = run(["--run", "555"], fixture);
    expect(code).toBe(0);
    expect(out).toContain("Run: 555");
    expect(out).toContain("Result: Succeeded (job-result marker)");
    for (const line of [
      "runner job-started: job lane-ios, run 555",
      "sim-lease acquired: lane ci, waited 5s, device moviecal-ci",
      "sim-lease device-booted: device moviecal-ci, boot took 30s",
      "sim-lease first-test-started: after command start 49s",
      "dispatcher worker-exited: issue MOV-9, exit 0, class ok, took 4m00s",
      "runner job-completed",
      "## Window statistics",
      "- Memory pressure: peak 2 (warn)",
      "xcodebuild",
      "dispatcher worker MOV-9 (claude) overlapped CI job lane-ios (run 555) for 2m00s",
      "snapshot snapshot-2026-01-10T12-02-00.000Z.txt at 12:02:00Z (load 24 above 2x 8 cores)",
      "Jetsam report",
      "JetsamEvent-2026-01-10-120300.ips",
    ]) expect(out).toContain(line);
    expect(out).not.toContain("Old-crash");
    expect(out).toMatch(/GAP 12:02:58Z to 12:03:30Z \(32s\)/);
    expect(out).toMatch(/xcodebuild\s+[\d.]+ CPU-s\s+peak RSS 950 MB/);
  });

  it("prints the baseline with the leftover simulator named and the wedge lines", () => {
    const { out } = run(["--run", "555"], fixture);
    expect(out).toContain("Flag: not started under pressure");
    expect(out).toContain("launchd_sim (pid 200)");
    expect(out).toContain("Simulator devices booted with no release: iPhone 17");
    expect(out).toContain("Likely cause: leftover booted simulator (iPhone 17, launchd_sim (pid 200))");
    expect(out).toContain("shutdown-incomplete at 12:00:05Z: device moviecal-ci, phase cleanup, elapsed 45s, 3 attempts");
    expect(out).not.toContain("high load with no job running");
    const wide = run(["--from", iso(Date.parse("2026-01-10T11:50:00Z")), "--to", iso(Date.parse("2026-01-10T12:06:00Z"))], fixture).out;
    expect(wide).toContain("dispatcher worker-spawned: issue MOV-9, adapter claude");
    expect(wide).toContain("high load with no job running 11:55:00Z to 11:55:55Z");
    expect(wide).toContain("peak runnable 30, peak simProcs 60");
    expect(wide).toContain("high load with no job running 11:58:30Z to 11:59:25Z (55s): peak load 40 (5x 8 cores), runnable and simProcs unavailable (ps timed out), CPU at peak user 20% sys 10% idle 70%");
    expect(wide).toContain("Result: Succeeded");
  });

  it("selects the same data with --since and --from/--to, and works on uncompressed files", () => {
    expect(run(["--since", "2h"], fixture).out).toContain("runner job-started");
    expect(run(["--from", iso(Date.parse("2026-01-10T12:00:00Z")), "--to", iso(Date.parse("2026-01-10T12:06:00Z"))], fixture).out).toContain("Jetsam report");
    const plain = buildFixtureDay({ root: tmpRoot(), gzipSamples: false });
    expect(run(["--run", "555"], plain).out).toContain("Result: Succeeded");
  });

  it("includes the admin reminder in every report, including errors and an idle window", () => {
    expect(run(["--run", "555"], fixture).out).toContain(ADMIN_REMINDER);
    const missing = run(["--run", "404"], fixture);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain(ADMIN_REMINDER);
    const idle = run(["--from", iso(Date.parse("2026-01-10T03:00:00Z")), "--to", iso(Date.parse("2026-01-10T03:10:00Z"))], fixture);
    expect(idle.out).toContain("no markers in the window");
    expect(idle.out).toContain("no samples at all");
    expect(idle.out).toContain(ADMIN_REMINDER);
    expect(idle.out).not.toMatch(/shutdown-incomplete|high load with no job/);
  });

  it("prints a short Markdown summary for the job summary", () => {
    const { code, out } = run(["--summary", "--run", "555"], fixture);
    expect(code).toBe(0);
    expect(out).toMatchInlineSnapshot(`
      "### Host telemetry

      - **Result:** Succeeded; **duration:** 5m30s
      - **Memory pressure:** peak 2 (warn); **swap change:** +200 MB; **peak load:** 7 on 8 cores
      - **Top CPU:** xcodebuild 279s, simulator 91.5s, runner 18.3s; **top peak RSS:** xcodebuild 950 MB, simulator 700 MB, other 300 MB
      - **Baseline:** not started under pressure
      - **Leftovers at start:** launchd_sim (pid 200), xcodebuild (pid 300), device iPhone 17; already running: dispatcher worker MOV-9 (claude)
      - Likely cause: leftover booted simulator (iPhone 17, launchd_sim (pid 200)) with peak load 40, peak runnable 30, against 8 cores
      - **Snapshots/crash reports:** snapshot-2026-01-10T12-02-00.000Z.txt, JetsamEvent-2026-01-10-120300.ips
      - **Sampling gaps:** 12:02:58Z (32s)
      - shutdown-incomplete at 12:00:05Z: device moviecal-ci, phase cleanup, elapsed 45s, 3 attempts

      _Admin-level collection (powermetrics, spindump) is NOT enabled. If load problems persist after reviewing this data, ask Adam to consider enabling it._"
    `);
    expect(out.split("\n").length).toBeLessThan(20);
  });

  it("summary mode never fails: a missing folder or run gives one explanatory line plus the reminder", () => {
    const lines = [];
    expect(main(["--summary", "--run", "1", "--dir", path.join(tmpRoot(), "renamed")], { out: (l) => lines.push(l) })).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Telemetry summary unavailable: telemetry folder not found/);
    expect(lines[0]).toContain(ADMIN_REMINDER);
    const bad = [];
    expect(main(["--summary", "--bogus"], { out: (l) => bad.push(l) })).toBe(0);
    expect(bad[0]).toContain(ADMIN_REMINDER);
    const noRun = [];
    expect(main(["--summary", "--run", "123", "--dir", fixture.dir], { out: (l) => noRun.push(l) })).toBe(0);
    expect(noRun[0]).toContain("no telemetry markers for run 123");
    expect(fs.existsSync(fixture.dir)).toBe(true);
  });
});
