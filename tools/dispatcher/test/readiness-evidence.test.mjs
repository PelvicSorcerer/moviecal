import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureVerificationEvidence,
  declaredReadiness,
  hasDurablePassedVerification,
  pullRequestReadinessEvidence,
} from "../src/readiness-evidence.mjs";

let tmpDir;
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function issue(description) {
  return { identifier: "MOV-1", description };
}

function logs(lines) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mov275-evidence-"));
  fs.writeFileSync(path.join(tmpDir, "stdout.log"), lines.join("\n") + "\n");
  return tmpDir;
}

const eligibleIssue = issue([
  "## Manual Verification",
  "",
  "Human testing: not-required",
  "",
  "Rationale: deterministic local and CI coverage covers every acceptance criterion.",
  "",
  "Autonomy: eligible",
].join("\n"));

describe("MOV-275 durable local verification", () => {
  it("records only an exact completed successful verify command", () => {
    const evidence = captureVerificationEvidence(logs([
      JSON.stringify({ type: "item.completed", item: { id: "verify", type: "command_execution", command: "npm run verify", exit_code: 0 } }),
    ]), { now: () => new Date("2026-09-21T12:00:00Z") });

    expect(evidence).toMatchObject({ status: "passed", command: "npm run verify" });
    expect(fs.existsSync(evidence.artifactPath)).toBe(true);
  });

  it("accepts Claude evidence only when its linked result explicitly records exit code zero", () => {
    const evidence = captureVerificationEvidence(logs([
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "verify", name: "Bash", input: { command: "npm run verify" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "verify", is_error: false, content: "Exit code: 0\nall lanes passed" }] } }),
    ]));

    expect(evidence.status).toBe("passed");
  });

  it.each([
    ["missing", [], "incomplete"],
    ["failed", [JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm run verify", exit_code: 1 } })], "failed"],
    ["ambiguous shell wrapper", [JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm run verify || true", exit_code: 0 } })], "incomplete"],
    ["piped to tail (MOV-274 autonomy-pilot blocker)", [JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm run verify 2>&1 | tail -300", exit_code: 0 } })], "incomplete"],
  ])("fails closed for %s evidence", (_name, lines, status) => {
    expect(captureVerificationEvidence(logs(lines)).status).toBe(status);
  });

  it("renders Autonomy: eligible once the worker runs the exact command instead of piping it (MOV-274 follow-up)", () => {
    const evidence = captureVerificationEvidence(logs([
      JSON.stringify({ type: "item.completed", item: { id: "verify", type: "command_execution", command: "npm run verify", exit_code: 0 } }),
    ]));
    const body = pullRequestReadinessEvidence(eligibleIssue, evidence);
    expect(body).toContain("Autonomy: eligible");
    expect(hasDurablePassedVerification(body)).toBe(true);
  });
});

describe("MOV-275 declared readiness rendering", () => {
  it("carries explicit consistent no-human/autonomy declarations with durable evidence", () => {
    const evidence = { status: "passed", artifactPath: "/logs/MOV-1/verification-evidence.json" };
    const body = pullRequestReadinessEvidence(eligibleIssue, evidence);

    expect(declaredReadiness(eligibleIssue)).toMatchObject({ humanTesting: "not-required", autonomy: "eligible" });
    expect(body).toContain("Human testing: not-required");
    expect(body).toContain("Autonomy: eligible");
    expect(hasDurablePassedVerification(body)).toBe(true);
  });

  it("emits disabled/incomplete values for required, missing, or contradictory declarations", () => {
    const required = pullRequestReadinessEvidence(issue("## Manual Verification\n\nHuman testing: required\n\nAutonomy: eligible"), { status: "passed", artifactPath: "/logs/evidence.json" });
    const missing = pullRequestReadinessEvidence(issue("## Manual Verification\n\nHuman testing: not-required"), { status: "incomplete" });

    expect(required).toContain("Human testing: incomplete");
    expect(required).toContain("Autonomy: disabled");
    expect(missing).toContain("Autonomy: disabled");
    expect(missing).toContain("no durable successful exact `npm run verify` execution");
  });
});
