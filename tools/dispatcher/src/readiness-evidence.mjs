// Trusted readiness-evidence handling for dispatcher-published pull requests.
//
// A worker's final prose is not verification evidence. The dispatcher accepts
// a passing command only when its structured transcript includes a completed,
// successful execution of the exact required command, then writes that result
// beside the transcript before it publishes the PR.

import fs from "node:fs";
import path from "node:path";

const VERIFY_COMMAND = "npm run verify";
const EVIDENCE_FILENAME = "verification-evidence.json";

function parseTranscript(transcript) {
  const commands = new Map();
  const results = new Map();
  let malformed = false;

  for (const rawLine of String(transcript || "").split("\n")) {
    if (!rawLine.trim()) continue;
    let event;
    try {
      event = JSON.parse(rawLine);
    } catch {
      malformed = true;
      continue;
    }

    const item = event.item || {};
    if (item.type === "command_execution" && item.command === VERIFY_COMMAND) {
      const key = item.id || event.id || `${commands.size}`;
      commands.set(key, {
        command: item.command,
        completed: event.type === "item.completed",
        exitCode: item.exit_code ?? item.exitCode ?? null,
      });
    }

    const content = event.message?.content || event.content || [];
    const values = Array.isArray(content) ? content : [content];
    for (const value of values) {
      if (value?.type === "tool_use" && value.name === "Bash" && value.input?.command === VERIFY_COMMAND) {
        commands.set(value.id, { command: VERIFY_COMMAND, completed: false, exitCode: null });
      }
      if (value?.type === "tool_result" && value.tool_use_id) {
        results.set(value.tool_use_id, {
          isError: value.is_error === true,
          text: typeof value.content === "string" ? value.content : JSON.stringify(value.content || ""),
        });
      }
    }
  }

  const executions = [...commands.entries()].map(([id, command]) => {
    const result = results.get(id);
    if (command.completed) {
      return { ...command, outcome: command.exitCode === 0 ? "passed" : command.exitCode == null ? "ambiguous" : "failed" };
    }
    if (result) {
      // Claude's stream protocol carries the Bash exit code in the linked
      // tool result rather than in the tool-use event. A textual success
      // claim alone is deliberately insufficient.
      const exit = /(?:^|\n)Exit code:\s*(\d+)\b/i.exec(result.text);
      return {
        ...command,
        outcome: !result.isError && exit?.[1] === "0" ? "passed" : exit ? "failed" : "ambiguous",
      };
    }
    return { ...command, outcome: "ambiguous" };
  });

  return { malformed, executions };
}

/** Capture the one local verification fact the publisher is allowed to claim. */
export function captureVerificationEvidence(logDir, { fsImpl = fs, now = () => new Date() } = {}) {
  const transcriptPath = path.join(logDir || "", "stdout.log");
  const artifactPath = path.join(logDir || "", EVIDENCE_FILENAME);
  let parsed = { malformed: true, executions: [] };
  try {
    parsed = parseTranscript(fsImpl.readFileSync(transcriptPath, "utf8"));
  } catch {
    // Missing/unreadable logs are indistinguishable from missing durable
    // evidence. Publication may still make a draft, but autonomy cannot act.
  }

  const outcomes = parsed.executions.map((execution) => execution.outcome);
  const status = !parsed.malformed && outcomes.length > 0 && outcomes.every((outcome) => outcome === "passed")
    ? "passed"
    : outcomes.includes("failed") ? "failed" : "incomplete";
  const evidence = {
    version: 1,
    capturedAt: now().toISOString(),
    command: VERIFY_COMMAND,
    status,
    transcriptPath,
    artifactPath,
    executions: parsed.executions,
  };
  try {
    fsImpl.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    fsImpl.writeFileSync(artifactPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  } catch {
    evidence.status = "incomplete";
  }
  return evidence;
}

function manualVerificationSection(description) {
  const match = /^## Manual Verification[ \t]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(String(description || ""));
  return match?.[1] || "";
}

function oneMarker(section, label, values) {
  const matches = [...section.matchAll(new RegExp(`^\\s*${label}:\\s*(${values.join("|")})\\s*$`, "gim"))];
  return matches.length === 1 ? matches[0][1].toLowerCase() : null;
}

function rationaleFrom(section) {
  const match = /^\s*Rationale:\s*([\s\S]*?)(?=^\s*(?:Autonomy|Pilot control):|^##\s|(?![\s\S]))/im.exec(section);
  return match?.[1].trim() || null;
}

/** Derive issue declarations without guessing missing human/autonomy policy. */
export function declaredReadiness(issue = {}) {
  const section = manualVerificationSection(issue.description);
  const humanTesting = oneMarker(section, "Human testing", ["required", "not-required"]);
  const autonomy = oneMarker(section, "Autonomy", ["eligible", "disabled"]);
  const rationale = rationaleFrom(section);
  const internallyConsistent = Boolean(
    humanTesting
      && (humanTesting === "required" || rationale)
      && !(humanTesting === "required" && autonomy === "eligible"),
  );
  return {
    humanTesting: internallyConsistent ? humanTesting : "incomplete",
    autonomy: internallyConsistent && humanTesting === "not-required" && autonomy === "eligible" ? "eligible" : "disabled",
    rationale: humanTesting === "not-required" ? rationale : null,
  };
}

/** Render the repository PR contract from dispatcher-proven facts only. */
export function pullRequestReadinessEvidence(issue, verification = {}) {
  const declared = declaredReadiness(issue);
  const verificationPassed = verification.status === "passed";
  const autonomy = declared.autonomy === "eligible" && verificationPassed ? "eligible" : "disabled";
  const localEvidence = verificationPassed
    ? `\`${VERIFY_COMMAND}\` passed; durable dispatcher record: \`${verification.artifactPath}\`.`
    : verification.status === "failed"
      ? `incomplete — a durable \`${VERIFY_COMMAND}\` execution failed; inspect \`${verification.artifactPath || verification.transcriptPath || "the dispatcher transcript"}\`.`
      : `incomplete — no durable successful exact \`${VERIFY_COMMAND}\` execution was captured.`;
  const noHumanRationale = declared.humanTesting === "not-required" && declared.rationale
    ? declared.rationale
    : declared.humanTesting === "not-required"
      ? "incomplete — the Linear issue did not provide one unambiguous rationale."
      : "N/A";

  return [
    "## Readiness Evidence",
    "",
    `Human testing: ${declared.humanTesting}`,
    "",
    `Autonomy: ${autonomy}`,
    "",
    `- Local-agent evidence: ${localEvidence}`,
    `- Human tester and date: ${declared.humanTesting === "not-required" ? "N/A" : "pending human verification"}`,
    `- Checklist result: ${declared.humanTesting === "not-required" ? "N/A — not-required" : "pending"}`,
    `- No-human-testing rationale: ${noHumanRationale}`,
    "- Ready promoted by: ",
  ].join("\n");
}

/** Require the durable record, not merely a non-empty PR evidence line. */
export function hasDurablePassedVerification(body) {
  return /^\s*-\s*Local-agent evidence:\s*`npm run verify` passed; durable dispatcher record:\s*`[^`]+`\.$/im.test(String(body || ""));
}
