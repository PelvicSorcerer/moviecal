#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=lib/project-queue-common.sh
source "$repo_root/scripts/lib/project-queue-common.sh"

mode="${PROJECT_QUEUE_MODE:-post-cutover}"
project_items_fixture="${PROJECT_QUEUE_ITEMS_JSON:-}"
open_issues_fixture="${PROJECT_QUEUE_OPEN_ISSUES_JSON:-}"

project_queue_require_jq

if [ "$mode" != "post-cutover" ]; then
  echo "agent-check validates the post-cutover dispatch invariant only." >&2
  echo "Set PROJECT_QUEUE_MODE=post-cutover or use scripts/project-queue-check.sh for pre-cutover checks." >&2
  exit 1
fi

if [ -n "$project_items_fixture" ] || [ -n "$open_issues_fixture" ]; then
  project_queue_load_fixture_state
  default_branch="master"
else
  project_queue_load_live_state
  default_branch=$(gh repo view "$PROJECT_QUEUE_REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
fi

echo "Repository: $PROJECT_QUEUE_REPO (default branch: $default_branch)"
echo "Validating project-first dispatch state before worker implementation..."
project_queue_print_context "$mode" "$([ -n "$project_items_fixture" ] || [ -n "$open_issues_fixture" ] && echo yes || echo no)"

project_queue_validate_post_cutover
project_queue_validate_issue_contract "$DISPATCH_NUMBER" "$DISPATCH_ISSUE_BODY"
echo "Dispatchable issue #$DISPATCH_NUMBER matches the project-first queue invariant."
