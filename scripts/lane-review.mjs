#!/usr/bin/env node
// lane-review: an independent, automated second-pass review of a PR's diff,
// run as a required CI status check (not a GitHub "review"/"approval").
//
// Design (MOV-116, rescoped 2026-09-08): GitHub's own Copilot review deliberately
// never posts an "Approve" so it can't satisfy `required_approving_review_count` —
// a same-family bot approving its own sibling's PR would just be a rubber stamp.
// The proven pattern (Devin Review, CodeRabbit) instead gates autonomous merge on
// a required status check. This script IS that check: it fails (non-zero exit)
// on a blocking finding, and never posts anything that counts as a GitHub review.
//
// Two layers, with deliberately different trust properties (MOV-150):
//
//  1. Deterministic heuristic checks (sensitive-path, secret-shaped strings,
//     diff size) — always run, need no external credential, cannot be bypassed
//     by omitting a secret. These are FAIL-CLOSED and non-advisory: a heuristic
//     `block` fails the check. The only downgrade is the narrow, auditable
//     sensitive-path acknowledgement (label + `lane-review-ack:` marker); secret
//     and diff-size blocks are never downgradeable.
//
//  2. An AI review pass — a non-deterministic model call. Its substantive
//     findings are ADVISORY by default: a model `block` still fails the check,
//     but (unlike a heuristic block) it can be downgraded to a warning with an
//     explicit, auditable acknowledgement — the `lane-review-ai-ack` label plus
//     a `lane-review-ai-ack: <reason>` line in the PR body. This exists because
//     the AI layer has produced false-positive blocks with no override path.
//
//     Trust boundary for layer 2: "advisory" applies only to what the model
//     *says about the diff*. If the AI is CONFIGURED (ANTHROPIC_API_KEY present)
//     but cannot run or returns an unusable response, that is a loss of scrutiny,
//     not a clean pass — it fails the check as a NON-downgradeable `block`. Only
//     when ANTHROPIC_API_KEY is absent entirely is the skipped AI pass a mere
//     warning, so this lane can stay a required status check without depending on
//     secret provisioning first.
//
// Findings are computed fresh from the diff at HEAD every run and are stamped
// with the PR head SHA in the log and summary comment, so a stale comment from
// an earlier push is never mistaken for the current verdict.
//
// Exit 0: no blocking finding. Exit 1: at least one blocking finding.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// A sensitive-path finding is a `block` by default. It can be downgraded to a
// `warn` (still printed, still in the summary comment — fully auditable) only
// when BOTH of these are present, the same fail-closed shape as MOV-121's
// workflow-edit authorization: the PR carries this label AND its body has a
// `lane-review-ack: <reason>` line. Secret-detection and diff-size blocks are
// never downgradeable this way. See docs/operators/local-execution.md §Security
// model (MOV-134).
const SENSITIVE_PATH_ACK_LABEL = "sensitive-path-ack";
const SENSITIVE_PATH_ACK_MARKER_RE = /^lane-review-ack:[ \t]*(\S.*?)\s*$/im;

// A substantive AI-review `block` (the model's judgement about the diff) is
// advisory: it still fails the check, but the repo owner can downgrade it to a
// `warn` — same fail-closed shape as the sensitive-path ack above — by adding
// this label AND a `lane-review-ai-ack: <reason>` line to the PR body. This does
// NOT cover an AI pass that was configured but failed to run or returned garbage:
// that is a non-downgradeable `block` (loss of scrutiny, not a model opinion).
const AI_ACK_LABEL = "lane-review-ai-ack";
const AI_ACK_MARKER_RE = /^lane-review-ai-ack:[ \t]*(\S.*?)\s*$/im;

const SENSITIVE_PATH_PATTERNS = [
  /^\.github\/workflows\//,
  /^AGENTS\.md$/,
  /^\.github\/copilot-instructions\.md$/,
  /^docs\/product\//,
  /^\.claude\/settings.*\.json$/,
  /ruleset|branch-protection/i,
];

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9]{20,}/, "generic API-key-shaped secret (sk-...)"],
  [/AIza[0-9A-Za-z\-_]{35}/, "Google API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "PEM private key block"],
  [/ghp_[A-Za-z0-9]{36}/, "GitHub personal access token"],
  [/xox[baprs]-[A-Za-z0-9-]+/, "Slack token"],
];

const MAX_DIFF_LINES = 1500;
const MAX_DIFF_FILES = 40;
const AI_DIFF_CHAR_BUDGET = 60_000; // keep the review prompt bounded

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
}

function resolveBaseRef() {
  const baseRef = process.env.GITHUB_BASE_REF;
  if (!baseRef) {
    throw new Error("GITHUB_BASE_REF not set — this script expects to run on a pull_request event");
  }
  return `origin/${baseRef}`;
}

function getChangedFiles(base) {
  return sh(`git diff --name-only ${base}...HEAD`)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function getDiff(base) {
  return sh(`git diff ${base}...HEAD`);
}

/**
 * Decide whether a sensitive-path change has been explicitly acknowledged.
 * Returns one of:
 *   { acknowledged: true, reason }        - label + marker both present
 *   { acknowledged: false, problem }      - one present without the other
 *   { acknowledged: false, problem: null} - neither present (the normal case)
 */
export function resolveSensitivePathAck({ prBody = "", labels = [] } = {}) {
  const hasLabel = labels.includes(SENSITIVE_PATH_ACK_LABEL);
  const markerMatch = SENSITIVE_PATH_ACK_MARKER_RE.exec(prBody || "");

  if (!hasLabel && !markerMatch) return { acknowledged: false, problem: null };
  if (hasLabel && !markerMatch) {
    return {
      acknowledged: false,
      problem: `labeled "${SENSITIVE_PATH_ACK_LABEL}" but the PR body has no "lane-review-ack: <reason>" line`,
    };
  }
  if (!hasLabel && markerMatch) {
    return {
      acknowledged: false,
      problem: `PR body has a "lane-review-ack:" line but the PR is not labeled "${SENSITIVE_PATH_ACK_LABEL}"`,
    };
  }
  return { acknowledged: true, reason: markerMatch[1].trim() };
}

/**
 * Decide whether a substantive AI-review `block` has been explicitly
 * acknowledged. Same truth table and return shape as resolveSensitivePathAck,
 * keyed on the `lane-review-ai-ack` label + `lane-review-ai-ack: <reason>` line.
 */
export function resolveAiAck({ prBody = "", labels = [] } = {}) {
  const hasLabel = labels.includes(AI_ACK_LABEL);
  const markerMatch = AI_ACK_MARKER_RE.exec(prBody || "");

  if (!hasLabel && !markerMatch) return { acknowledged: false, problem: null };
  if (hasLabel && !markerMatch) {
    return {
      acknowledged: false,
      problem: `labeled "${AI_ACK_LABEL}" but the PR body has no "lane-review-ai-ack: <reason>" line`,
    };
  }
  if (!hasLabel && markerMatch) {
    return {
      acknowledged: false,
      problem: `PR body has a "lane-review-ai-ack:" line but the PR is not labeled "${AI_ACK_LABEL}"`,
    };
  }
  return { acknowledged: true, reason: markerMatch[1].trim() };
}

export function runHeuristics(files, diffText, ack = { acknowledged: false, problem: null }) {
  const findings = [];

  const sensitiveHits = files.filter((f) => SENSITIVE_PATH_PATTERNS.some((re) => re.test(f)));
  if (sensitiveHits.length > 0) {
    if (ack.acknowledged) {
      findings.push({
        severity: "warn",
        summary: `Touches sensitive path(s): ${sensitiveHits.join(", ")} — acknowledged (${SENSITIVE_PATH_ACK_LABEL} + lane-review-ack: "${ack.reason}")`,
      });
    } else {
      const how = ack.problem
        ? ack.problem
        : `to acknowledge, add the "${SENSITIVE_PATH_ACK_LABEL}" label AND a "lane-review-ack: <reason>" line to the PR body`;
      findings.push({
        severity: "block",
        summary: `Touches sensitive path(s) requiring explicit human sign-off: ${sensitiveHits.join(", ")} — ${how}`,
      });
    }
  }

  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(diffText)) {
      findings.push({ severity: "block", summary: `Diff appears to contain a ${label}` });
    }
  }

  const diffLineCount = diffText.split("\n").length;
  if (diffLineCount > MAX_DIFF_LINES || files.length > MAX_DIFF_FILES) {
    findings.push({
      severity: "block",
      summary: `Diff exceeds scope threshold (${diffLineCount} lines / ${files.length} files; limits are ${MAX_DIFF_LINES}/${MAX_DIFF_FILES}) — split into smaller, issue-scoped PRs`,
    });
  }

  return findings;
}

// Each finding carries a `kind` so main() can apply the right trust rule:
//   "ai-skipped" — key absent; AI pass never attempted. warn (lane stays green
//                  without secret provisioning).
//   "ai-infra"   — key present but the pass could not produce a usable verdict
//                  (HTTP error, unparseable / invalid JSON). block, and NOT
//                  downgradeable by lane-review-ai-ack — this is lost scrutiny.
//   "ai-model"   — a judgement the model made about the diff. Advisory: a
//                  `block` still fails, but lane-review-ai-ack can downgrade it.
async function runAiReview(diffText, prTitle, prBody) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ran: false,
      configured: false,
      findings: [
        {
          severity: "warn",
          kind: "ai-skipped",
          summary: "ANTHROPIC_API_KEY not set — AI review pass skipped; heuristic checks only",
        },
      ],
    };
  }

  const truncated = diffText.length > AI_DIFF_CHAR_BUDGET;
  const diffForModel = truncated ? diffText.slice(0, AI_DIFF_CHAR_BUDGET) : diffText;

  const systemPrompt = `You are an independent, strict second-pass reviewer for pull requests in the moviecal repository. You did not write this diff. Your only job is to catch what automated tests (lint/typecheck/build/unit/integration/browser) would not: security issues, obvious correctness bugs, scope creep, and governance-relevant changes. Be conservative — only mark something "block" if a competent human reviewer would clearly stop the PR over it. Style preferences, minor nits, and speculative concerns are "warn" at most, not "block". Respond with ONLY a JSON object, no prose, matching exactly:
{"findings": [{"severity": "block" | "warn", "summary": "one sentence"}]}
An empty findings array means the diff looks clean.`;

  const userPrompt = `PR title: ${prTitle || "(none)"}
PR description:
${prBody || "(none)"}
${truncated ? "\n[diff truncated to first " + AI_DIFF_CHAR_BUDGET + " characters]\n" : ""}
Diff:
${diffForModel}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ran: false,
      configured: true,
      findings: [
        {
          severity: "block",
          kind: "ai-infra",
          summary: `AI review pass is configured but failed to run (HTTP ${res.status}): ${body.slice(0, 300)} — this is lost review scrutiny, not a pass; re-run once the API is reachable`,
        },
      ],
    };
  }

  const data = await res.json();
  const text = data?.content?.[0]?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      ran: true,
      configured: true,
      findings: [
        {
          severity: "block",
          kind: "ai-infra",
          summary: "AI review pass returned an unparseable response — cannot confirm the diff was reviewed; re-run",
        },
      ],
    };
  }

  try {
    const parsed = JSON.parse(match[0]);
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    return {
      ran: true,
      configured: true,
      findings: findings
        .filter((f) => f && typeof f.summary === "string" && (f.severity === "block" || f.severity === "warn"))
        .map((f) => ({ severity: f.severity, kind: "ai-model", summary: f.summary })),
    };
  } catch {
    return {
      ran: true,
      configured: true,
      findings: [
        {
          severity: "block",
          kind: "ai-infra",
          summary: "AI review pass returned invalid JSON — cannot confirm the diff was reviewed; re-run",
        },
      ],
    };
  }
}

/**
 * Apply the lane-review-ai-ack downgrade to AI-review findings.
 *  - "ai-model" `block` findings are advisory: downgraded to `warn` when the ack
 *    is present, annotated (still `block`) when the label/marker are mismatched,
 *    left as `block` with a how-to-ack hint otherwise.
 *  - "ai-infra" `block` findings are NEVER downgraded — a configured-but-broken
 *    AI pass is lost scrutiny, not a model opinion.
 *  - Everything else (warns, the ai-skipped notice) passes through untouched.
 * Pure: returns a new array, does not mutate its input.
 */
export function applyAiAck(aiFindings = [], ack = { acknowledged: false, problem: null }) {
  return aiFindings.map((f) => {
    if (f.kind !== "ai-model" || f.severity !== "block") return { ...f };
    if (ack.acknowledged) {
      return {
        ...f,
        severity: "warn",
        summary: `${f.summary} — AI block acknowledged (${AI_ACK_LABEL} + lane-review-ai-ack: "${ack.reason}")`,
      };
    }
    if (ack.problem) {
      return { ...f, summary: `${f.summary} — ${ack.problem}` };
    }
    return {
      ...f,
      summary: `${f.summary} — if this is a false positive, add the "${AI_ACK_LABEL}" label AND a "lane-review-ai-ack: <reason>" line to the PR body to downgrade it to a warning`,
    };
  });
}

async function postSummaryComment(findings, headSha) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !repo || !eventPath) return;

  let prNumber;
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    prNumber = event?.pull_request?.number;
  } catch {
    return;
  }
  if (!prNumber) return;

  const blocking = findings.filter((f) => f.severity === "block");
  const warnings = findings.filter((f) => f.severity === "warn");

  const lines = ["### lane-review (automated, non-approving)"];
  if (headSha) lines.push(`Findings for head \`${headSha}\`. A comment for a different SHA is stale — re-check the latest run.`);
  if (findings.length === 0) {
    lines.push("No findings.");
  } else {
    if (blocking.length > 0) {
      lines.push("**Blocking:**");
      for (const f of blocking) lines.push(`- ${f.summary}`);
    }
    if (warnings.length > 0) {
      lines.push("**Warnings (non-blocking):**");
      for (const f of warnings) lines.push(`- ${f.summary}`);
    }
  }
  lines.push(
    "",
    "_This is a required status check, not a GitHub review/approval — it never approves a PR. Deterministic heuristic blocks (sensitive-path, secrets, diff-size) are fail-closed; a substantive AI-review block is advisory and downgradeable with the `lane-review-ai-ack` label + marker, but a configured AI pass that could not run still fails. See `docs/operators/local-execution.md` §Security model._"
  );

  try {
    await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: lines.join("\n") }),
    });
  } catch (err) {
    // Comment posting is best-effort visibility only — never fail the check over it.
    console.warn("lane-review: failed to post summary comment:", err?.message ?? err);
  }
}

/** PR labels from the Actions event payload (same source as postSummaryComment). */
function getPrLabels() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return [];
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    return (event?.pull_request?.labels ?? []).map((l) => l.name).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The PR head commit these findings describe. Preferred source is the event
 * payload's pull_request.head.sha (the branch tip); GITHUB_SHA on a
 * pull_request event is the ephemeral merge commit, used only as a fallback.
 * Stamped into the log and summary comment so a stale comment from an earlier
 * push is not mistaken for the current verdict.
 */
function getHeadSha() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8"));
      const sha = event?.pull_request?.head?.sha;
      if (sha) return sha;
    } catch {
      /* fall through */
    }
  }
  return process.env.GITHUB_SHA || "unknown";
}

async function main() {
  const base = resolveBaseRef();
  const files = getChangedFiles(base);
  const diffText = getDiff(base);

  const labels = getPrLabels();
  const headSha = getHeadSha();

  const ack = resolveSensitivePathAck({ prBody: process.env.PR_BODY, labels });
  const heuristicFindings = runHeuristics(files, diffText, ack);

  const aiResult = await runAiReview(diffText, process.env.PR_TITLE, process.env.PR_BODY);
  const aiAck = resolveAiAck({ prBody: process.env.PR_BODY, labels });
  const aiFindings = applyAiAck(aiResult.findings, aiAck);

  const allFindings = [...heuristicFindings, ...aiFindings];

  console.log(
    `lane-review: ${files.length} file(s) changed at ${headSha}, AI pass ${
      aiResult.ran ? "ran" : aiResult.configured ? "configured but did not complete" : "skipped (no key)"
    }`
  );
  for (const f of allFindings) {
    console.log(`  [${f.severity}] ${f.summary}`);
  }

  await postSummaryComment(allFindings, headSha);

  const blocking = allFindings.some((f) => f.severity === "block");
  if (blocking) {
    console.error("lane-review: FAIL — at least one blocking finding");
    process.exit(1);
  }
  console.log("lane-review: PASS");
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error("lane-review: unexpected error:", err);
    process.exit(1);
  });
}
