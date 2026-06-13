#!/usr/bin/env bash
set -euo pipefail

repo="PelvicSorcerer/moviecal"
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
queue_file="$repo_root/docs/planning/open-issue-order.json"

if [ ! -f "$queue_file" ]; then
  echo "Missing queue order file: $queue_file" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is not installed. Install/authenticate gh before relying on issue queue checks." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh CLI is not authenticated. Run 'gh auth login -h github.com' before running this script." >&2
  echo "If gh is authenticated in your normal macOS terminal but still fails in Codex, rerun this check with elevated execution so gh can access the local keychain outside the sandbox." >&2
  exit 1
fi

default_branch=$(gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name)
current_branch=$(git rev-parse --abbrev-ref HEAD)

echo "Repository: $repo (default branch: $default_branch)"
echo "Local branch: $current_branch"

if [ "$current_branch" != "$default_branch" ]; then
  echo "Handoff audits should run from the default branch after merge." >&2
  exit 1
fi

if [ -n "$(git status --short)" ]; then
  echo "Working tree is not clean. Commit, stash, or discard local changes before using handoff mode." >&2
  exit 1
fi

open_issues=$(gh issue list --repo "$repo" --state open --json number,title,body)
ready_issues=$(gh issue list --repo "$repo" --label agent-ready --state open --json number,title,body)
ready_count=$(echo "$ready_issues" | jq length)
queue_order=$(jq -r '.queue[].issue' "$queue_file")
open_issue_numbers=$(echo "$open_issues" | jq -r '.[].number')
expected_issue_number=""

while read -r queued_issue; do
  if [ -z "$queued_issue" ]; then
    continue
  fi

  if echo "$open_issue_numbers" | grep -qx "$queued_issue"; then
    expected_issue_number="$queued_issue"
    break
  fi
done <<< "$queue_order"

if [ -z "$expected_issue_number" ]; then
  echo "None of the ordered implementation issues in $queue_file are currently open." >&2
  exit 1
fi

expected_issue_title=$(echo "$open_issues" | jq -r --argjson issue "$expected_issue_number" '.[] | select(.number == $issue) | .title')
expected_issue_comments=$(gh issue view "$expected_issue_number" --repo "$repo" --json comments --jq '.comments')
queue_status=$(echo "$expected_issue_comments" | jq -r '[.[] | select(.body | startswith("Queue status:")) | .body] | last // ""')
open_blockers=""

if [ -n "$queue_status" ]; then
  open_blockers=$(echo "$queue_status" | grep -oE '#[0-9]+' | tr -d '#' | while read -r blocker; do
    if echo "$open_issue_numbers" | grep -qx "$blocker"; then
      echo "$blocker"
    fi
  done || true)
fi

open_prs=$(gh pr list --repo "$repo" --state open --json number,title,headRefName,baseRefName)
open_pr_count=$(echo "$open_prs" | jq length)

echo "Open PR count: $open_pr_count"
echo "Expected next implementation issue: #$expected_issue_number - $expected_issue_title"

if [ -n "$open_blockers" ]; then
  echo "That issue is still blocked by open issues: $(echo "$open_blockers" | paste -sd ', ' -)." >&2

  if [ "$ready_count" -gt 0 ]; then
    echo "No issue should be labeled agent-ready until those blockers close." >&2
  fi

  exit 1
fi

if [ "$ready_count" -eq 0 ]; then
  echo "No open agent-ready issues found. The repo is not ready for the next fresh worker." >&2
  echo "Promote #$expected_issue_number or explicitly record a blocker before handoff." >&2
  exit 1
fi

if [ "$ready_count" -gt 1 ]; then
  echo "Found $ready_count open agent-ready issues. Reconcile the queue before handoff." >&2
  echo "$ready_issues" | jq -r '.[] | "- #\(.number) \(.title)"'
  exit 1
fi

issue_number=$(echo "$ready_issues" | jq -r '.[0].number')
issue_title=$(echo "$ready_issues" | jq -r '.[0].title')
issue_body=$(echo "$ready_issues" | jq -r '.[0].body')

if [ "$issue_number" != "$expected_issue_number" ]; then
  echo "Issue #$issue_number is labeled agent-ready, but the ordered next issue is #$expected_issue_number." >&2
  exit 1
fi

echo "Next worker issue: #$issue_number - $issue_title"

if ! echo "$issue_body" | grep -iq "Acceptance criteria"; then
  echo "Issue #$issue_number is missing an Acceptance criteria section." >&2
  exit 1
fi

if ! echo "$issue_body" | grep -iq "Verification"; then
  echo "Issue #$issue_number is missing a Verification section." >&2
  exit 1
fi

if ! echo "$issue_body" | grep -iq "Relevant docs"; then
  echo "Issue #$issue_number is missing a Relevant docs section." >&2
  exit 1
fi

if echo "$issue_body" | grep -Eiq "(auth|database|calendar|token|cron|secret|supabase|tmdb|rls)"; then
  if ! echo "$issue_body" | grep -iq "Security notes"; then
    echo "Issue #$issue_number appears security-sensitive but is missing a Security notes section." >&2
    exit 1
  fi
fi

echo "Handoff state looks valid for the next worker and matches the deterministic queue order."
