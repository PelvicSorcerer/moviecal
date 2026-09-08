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
// Two layers:
//  1. Heuristic checks — always run, need no external credential, and cannot be
//     bypassed by omitting a secret.
//  2. An AI review pass — runs only when ANTHROPIC_API_KEY is present. Its absence
//     is a warning, not a failure, so this lane can be added to required status
//     checks immediately without depending on secret provisioning first.
//
// Exit 0: no blocking finding. Exit 1: at least one blocking finding.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

function runHeuristics(files, diffText) {
  const findings = [];

  const sensitiveHits = files.filter((f) => SENSITIVE_PATH_PATTERNS.some((re) => re.test(f)));
  if (sensitiveHits.length > 0) {
    findings.push({
      severity: "block",
      summary: `Touches sensitive path(s) requiring explicit human sign-off: ${sensitiveHits.join(", ")}`,
    });
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

async function runAiReview(diffText, prTitle, prBody) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ran: false,
      findings: [
        {
          severity: "warn",
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
      findings: [
        {
          severity: "warn",
          summary: `AI review pass failed to run (HTTP ${res.status}): ${body.slice(0, 300)}`,
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
      findings: [{ severity: "warn", summary: "AI review pass returned an unparseable response — treated as non-blocking" }],
    };
  }

  try {
    const parsed = JSON.parse(match[0]);
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    return {
      ran: true,
      findings: findings.filter(
        (f) => f && typeof f.summary === "string" && (f.severity === "block" || f.severity === "warn")
      ),
    };
  } catch {
    return {
      ran: true,
      findings: [{ severity: "warn", summary: "AI review pass returned invalid JSON — treated as non-blocking" }],
    };
  }
}

async function postSummaryComment(findings) {
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
    "_This is a required status check, not a GitHub review/approval — it never approves a PR. See `docs/operators/local-execution.md` §Security model._"
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

async function main() {
  const base = resolveBaseRef();
  const files = getChangedFiles(base);
  const diffText = getDiff(base);

  const heuristicFindings = runHeuristics(files, diffText);
  const aiResult = await runAiReview(diffText, process.env.PR_TITLE, process.env.PR_BODY);

  const allFindings = [...heuristicFindings, ...aiResult.findings];

  console.log(`lane-review: ${files.length} file(s) changed, AI pass ${aiResult.ran ? "ran" : "skipped"}`);
  for (const f of allFindings) {
    console.log(`  [${f.severity}] ${f.summary}`);
  }

  await postSummaryComment(allFindings);

  const blocking = allFindings.some((f) => f.severity === "block");
  if (blocking) {
    console.error("lane-review: FAIL — at least one blocking finding");
    process.exit(1);
  }
  console.log("lane-review: PASS");
}

main().catch((err) => {
  console.error("lane-review: unexpected error:", err);
  process.exit(1);
});
