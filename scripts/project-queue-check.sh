#!/usr/bin/env bash
set -euo pipefail

repo="${PROJECT_QUEUE_REPO:-PelvicSorcerer/moviecal}"
owner="${PROJECT_QUEUE_OWNER:-PelvicSorcerer}"
project_number="${PROJECT_QUEUE_NUMBER:-1}"
mode="${PROJECT_QUEUE_MODE:-pre-cutover}"
list_limit="${PROJECT_QUEUE_LIST_LIMIT:-200}"
project_items_fixture="${PROJECT_QUEUE_ITEMS_JSON:-}"
open_issues_fixture="${PROJECT_QUEUE_OPEN_ISSUES_JSON:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is not installed. Install jq before relying on project queue checks." >&2
  exit 1
fi

setup_token() {
  if [ -n "${GITHUB_PAT_OPERATOR:-}" ]; then
    export GH_TOKEN="$GITHUB_PAT_OPERATOR"
  fi
  unset GITHUB_TOKEN 2>/dev/null || true
}

fetch_project_items_json() {
  local response graphql_limit=100
  if [ "$list_limit" -lt "$graphql_limit" ]; then
    graphql_limit="$list_limit"
  fi

  if project_items_json=$(gh project item-list "$project_number" --owner "$owner" --limit "$list_limit" --format json 2>/dev/null); then
    return 0
  fi

  response=$(gh api graphql -f query="query {
    user(login: \"$owner\") {
      projectV2(number: $project_number) {
        items(first: $graphql_limit) {
          nodes {
            content {
              __typename
              ... on Issue { number title labels(first: 20) { nodes { name } } }
              ... on PullRequest { number title }
            }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldNumberValue {
                  number
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
          }
        }
      }
    }
  }")

  project_items_json=$(echo "$response" | jq '{
    items: [
      .data.user.projectV2.items.nodes[]
      | {
          title: .content.title,
          labels: ((.content.labels.nodes // []) | map(.name)),
          content: (
            if .content.__typename == "Issue" then
              {type: "Issue", number: .content.number}
            elif .content.__typename == "PullRequest" then
              {type: "PullRequest", number: .content.number}
            else
              {type: "Draft", number: null}
            end
          ),
          status: (
            [.fieldValues.nodes[] | select(.field.name == "Status") | .name][0] // ""
          ),
          "agent Dispatch": (
            [.fieldValues.nodes[] | select(.field.name == "Agent Dispatch") | .name][0] // ""
          )
        }
    ]
  }')
}

case "$mode" in
  pre-cutover|post-cutover) ;;
  *)
    echo "Unsupported PROJECT_QUEUE_MODE: $mode" >&2
    echo "Supported modes: pre-cutover, post-cutover" >&2
    exit 1
    ;;
esac

if [ -n "$project_items_fixture" ] || [ -n "$open_issues_fixture" ]; then
  if [ -z "$project_items_fixture" ] || [ -z "$open_issues_fixture" ]; then
    echo "Fixture mode requires both PROJECT_QUEUE_ITEMS_JSON and PROJECT_QUEUE_OPEN_ISSUES_JSON." >&2
    exit 1
  fi

  project_items_json="$project_items_fixture"
  open_issues_json="$open_issues_fixture"
  echo "Repository: $repo"
  echo "Project: $owner/$project_number"
  echo "Queue mode: $mode"
  echo "Using fixture input: yes"
else
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI is not installed. Install/authenticate gh before relying on project queue checks." >&2
    exit 1
  fi

  setup_token

  if ! gh auth status >/dev/null 2>&1; then
    echo "gh CLI is not authenticated. Provide GH_TOKEN/PROJECT_QUEUE_TOKEN/GITHUB_PAT_OPERATOR in CI or locally." >&2
    exit 1
  fi

  fetch_project_items_json
  open_issues_json=$(gh issue list --repo "$repo" --state open --limit "$list_limit" --json number,title)
  echo "Repository: $repo"
  echo "Project: $owner/$project_number"
  echo "Queue mode: $mode"
  echo "Using fixture input: no"
fi

open_issue_numbers_json=$(echo "$open_issues_json" | jq '[.[].number]')
dispatch_json=$(echo "$project_items_json" | jq '[.items[] | select(."agent Dispatch" == "Yes")]')
dispatch_count=$(echo "$dispatch_json" | jq 'length')

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
    | (.content.number // null) as $issue_number
    | select(.content.type == "Issue" and (($open | index($issue_number)) != null))
  ]')
dispatch_open_count=$(echo "$dispatch_open_json" | jq 'length')

invalid_dispatch_json=$(echo "$project_items_json" | jq --argjson open "$open_issue_numbers_json" '
  [.items[]
    | select(."agent Dispatch" == "Yes")
    | (.content.number // null) as $issue_number
    | select(.content.type != "Issue" or (($open | index($issue_number)) == null))
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
