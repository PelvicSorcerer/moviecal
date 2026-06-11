#!/usr/bin/env bash
set -euo pipefail

repo="PelvicSorcerer/moviecal"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is not installed. Install/authenticate gh before relying on issue queue checks." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh CLI is not authenticated. Run 'gh auth login -h github.com' before running this script." >&2
  exit 1
fi

default_branch=$(gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name)
echo "Repository: $repo (default branch: $default_branch)"
echo "Checking open issues labeled 'agent-ready'..."

issues_json=$(gh issue list --repo "$repo" --label agent-ready --state open --json number,title,body)
count=$(echo "$issues_json" | jq length)

if [ "$count" -eq 0 ]; then
  echo "No open agent-ready issues found."
  exit 1
fi

if [ "$count" -gt 1 ]; then
  echo "Found $count open agent-ready issues. Reconcile the queue before starting implementation." >&2
  echo "$issues_json" | jq -r '.[] | "- #\(.number) \(.title)"'
  exit 1
fi

issue_number=$(echo "$issues_json" | jq -r '.[0].number')
issue_title=$(echo "$issues_json" | jq -r '.[0].title')
issue_body=$(echo "$issues_json" | jq -r '.[0].body')

echo "Single agent-ready issue: #$issue_number - $issue_title"

if ! echo "$issue_body" | grep -iq "Acceptance criteria"; then
  echo "Issue #$issue_number is missing an Acceptance criteria section." >&2
  exit 1
fi

if ! echo "$issue_body" | grep -iq "Verification"; then
  echo "Issue #$issue_number is missing a Verification section." >&2
  exit 1
fi

echo "Issue body includes Acceptance criteria and Verification."
