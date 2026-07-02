#!/usr/bin/env bash
set -euo pipefail

repo="${PROJECT_QUEUE_REPO:-PelvicSorcerer/moviecal}"
owner="${PROJECT_QUEUE_OWNER:-PelvicSorcerer}"
project_number="${PROJECT_QUEUE_NUMBER:-1}"
mode="${PROJECT_QUEUE_MODE:-pre-cutover}"
list_limit="${PROJECT_QUEUE_LIST_LIMIT:-200}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is not installed. Install/authenticate gh before relying on project queue checks." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is not installed. Install jq before relying on project queue checks." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh CLI is not authenticated. Provide GH_TOKEN/PROJECT_QUEUE_TOKEN in CI or run 'gh auth login -h github.com' locally." >&2
  exit 1
fi

case "$mode" in
  pre-cutover|post-cutover) ;;
  *)
    echo "Unsupported PROJECT_QUEUE_MODE: $mode" >&2
    echo "Supported modes: pre-cutover, post-cutover" >&2
    exit 1
    ;;
esac

project_items_json=$(gh project item-list "$project_number" --owner "$owner" --format json)
open_issues_json=$(gh issue list --repo "$repo" --state open --limit "$list_limit" --json number,title)
open_issue_numbers_json=$(echo "$open_issues_json" | jq '[.[].number]')

dispatch_json=$(echo "$project_items_json" | jq '[.items[] | select(."agent Dispatch" == "Yes")]')
dispatch_count=$(echo "$dispatch_json" | jq 'length')

echo "Repository: $repo"
echo "Project: $owner/$project_number"
echo "Queue mode: $mode"
echo "Dispatch-yes items: $dispatch_count"

if [ "$mode" = "pre-cutover" ]; then
  if [ "$dispatch_count" -ne 0 ]; then
    echo "Pre-cutover mode expects zero project items with Agent Dispatch = Yes." >&2
    echo "$dispatch_json" | jq -r '.[] | "- #\(.content.number // "draft") \(.title)"' >&2
    exit 1
  fi

  echo "Pre-cutover invariant holds: no project item is currently dispatch-authoritative."
  exit 0
fi

dispatch_open_json=$(echo "$project_items_json" | jq --argjson open "$open_issue_numbers_json" '
  [.items[]
    | select(."agent Dispatch" == "Yes")
    | select(.content.type == "Issue" and (($open | index(.content.number)) != null))
  ]')
dispatch_open_count=$(echo "$dispatch_open_json" | jq 'length')

invalid_dispatch_json=$(echo "$project_items_json" | jq --argjson open "$open_issue_numbers_json" '
  [.items[]
    | select(."agent Dispatch" == "Yes")
    | select(.content.type != "Issue" or (($open | index(.content.number)) == null))
  ]')
invalid_dispatch_count=$(echo "$invalid_dispatch_json" | jq 'length')

if [ "$invalid_dispatch_count" -gt 0 ]; then
  echo "Found Agent Dispatch = Yes on non-open issue items, which is invalid after cutover." >&2
  echo "$invalid_dispatch_json" | jq -r '.[] | "- #\(.content.number // "draft") \(.title)"' >&2
  exit 1
fi

if [ "$dispatch_open_count" -ne 1 ]; then
  echo "Post-cutover mode requires exactly one open issue with Agent Dispatch = Yes; found $dispatch_open_count." >&2
  echo "$dispatch_open_json" | jq -r '.[] | "- #\(.content.number) \(.title)"' >&2
  exit 1
fi

dispatch_status=$(echo "$dispatch_open_json" | jq -r '.[0].status // ""')
if [ "$dispatch_status" != "Ready" ]; then
  echo "The dispatchable issue must have Status = Ready; found '$dispatch_status'." >&2
  exit 1
fi

if ! echo "$dispatch_open_json" | jq -e '.[0].labels // [] | index("agent-ready") != null' >/dev/null; then
  echo "The dispatchable issue is missing the derived 'agent-ready' label." >&2
  exit 1
fi

unexpected_agent_ready_json=$(echo "$project_items_json" | jq '
  [.items[]
    | select(.content.type == "Issue")
    | select((.labels // []) | index("agent-ready") != null)
    | select(."agent Dispatch" != "Yes")
  ]')
unexpected_agent_ready_count=$(echo "$unexpected_agent_ready_json" | jq 'length')

if [ "$unexpected_agent_ready_count" -gt 0 ]; then
  echo "Found issue items labeled 'agent-ready' without Agent Dispatch = Yes." >&2
  echo "$unexpected_agent_ready_json" | jq -r '.[] | "- #\(.content.number) \(.title)"' >&2
  exit 1
fi

dispatch_number=$(echo "$dispatch_open_json" | jq -r '.[0].content.number')
dispatch_title=$(echo "$dispatch_open_json" | jq -r '.[0].title')
echo "Post-cutover invariant holds for #$dispatch_number - $dispatch_title"
