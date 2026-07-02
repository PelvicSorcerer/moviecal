#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=lib/project-queue-common.sh
source "$repo_root/scripts/lib/project-queue-common.sh"

mode="${PROJECT_QUEUE_MODE:-post-cutover}"
project_items_fixture="${PROJECT_QUEUE_ITEMS_JSON:-}"
open_issues_fixture="${PROJECT_QUEUE_OPEN_ISSUES_JSON:-}"
list_limit="${PROJECT_QUEUE_LIST_LIMIT:-100}"

project_queue_require_jq

if [ "$mode" != "post-cutover" ]; then
  echo "agent-handoff validates the post-cutover dispatch invariant only." >&2
  echo "Set PROJECT_QUEUE_MODE=post-cutover or use scripts/project-queue-check.sh for pre-cutover checks." >&2
  exit 1
fi

current_branch=$(git branch --show-current)
upstream_branch=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)

if [ -n "$project_items_fixture" ] || [ -n "$open_issues_fixture" ]; then
  project_queue_load_fixture_state
  default_branch="master"
  using_fixture="yes"
else
  project_queue_load_live_state
  default_branch=$(gh repo view "$PROJECT_QUEUE_REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
  using_fixture="no"
fi

echo "Repository: $PROJECT_QUEUE_REPO (default branch: $default_branch)"
echo "Local branch: $current_branch"
echo "Upstream: ${upstream_branch:-<none>}"

if [ -z "$current_branch" ]; then
  echo "Handoff audits should run from an attached local branch, not detached HEAD." >&2
  exit 1
fi

if [ "$upstream_branch" != "origin/master" ]; then
  echo "Handoff audits should run from a local branch that tracks origin/master after merge." >&2
  exit 1
fi

if [ -n "$(git status --short)" ]; then
  echo "Working tree is not clean. Commit, stash, or discard local changes before using handoff mode." >&2
  exit 1
fi

project_queue_print_context "$mode" "$using_fixture"

if [ "$using_fixture" = "no" ]; then
  open_prs=$(gh pr list --repo "$PROJECT_QUEUE_REPO" --state open --limit "$list_limit" --json number,title,headRefName,baseRefName)
  open_pr_count=$(echo "$open_prs" | jq length)
  echo "Open PR count: $open_pr_count"
else
  echo "Open PR count: skipped in fixture mode"
fi

project_queue_validate_post_cutover
project_queue_validate_issue_contract "$DISPATCH_NUMBER" "$DISPATCH_ISSUE_BODY"
echo "Handoff state looks valid for the next worker and matches the project-first queue invariant."
