#!/usr/bin/env bash

# Shared helpers for project-first queue validation scripts.
# The GitHub Project is authoritative for dispatch state; issue bodies remain
# authoritative for implementation contracts.

PROJECT_QUEUE_REPO="${PROJECT_QUEUE_REPO:-PelvicSorcerer/moviecal}"
PROJECT_QUEUE_OWNER="${PROJECT_QUEUE_OWNER:-PelvicSorcerer}"
PROJECT_QUEUE_NUMBER="${PROJECT_QUEUE_NUMBER:-1}"
PROJECT_QUEUE_LIST_LIMIT="${PROJECT_QUEUE_LIST_LIMIT:-200}"

project_queue_setup_token() {
  if [ -n "${GITHUB_PAT_OPERATOR:-}" ]; then
    export GH_TOKEN="$GITHUB_PAT_OPERATOR"
  fi
  unset GITHUB_TOKEN 2>/dev/null || true
}

project_queue_require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "jq is not installed. Install jq before relying on project queue checks." >&2
    return 1
  fi
}

project_queue_require_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI is not installed. Install/authenticate gh before relying on project queue checks." >&2
    return 1
  fi

  project_queue_setup_token

  if ! gh auth status >/dev/null 2>&1; then
    echo "gh CLI is not authenticated. Provide GH_TOKEN/PROJECT_QUEUE_TOKEN/GITHUB_PAT_OPERATOR in CI or locally." >&2
    echo "If gh is authenticated in your normal macOS terminal but still fails in Codex, rerun this check with elevated execution so gh can access the local keychain outside the sandbox." >&2
    return 1
  fi
}

project_queue_fetch_project_items_json() {
  local response graphql_limit=100
  if [ "$PROJECT_QUEUE_LIST_LIMIT" -lt "$graphql_limit" ]; then
    graphql_limit="$PROJECT_QUEUE_LIST_LIMIT"
  fi

  if PROJECT_ITEMS_JSON=$(gh project item-list "$PROJECT_QUEUE_NUMBER" --owner "$PROJECT_QUEUE_OWNER" --limit "$PROJECT_QUEUE_LIST_LIMIT" --format json 2>/dev/null); then
    return 0
  fi

  response=$(gh api graphql -f query="query {
    user(login: \"$PROJECT_QUEUE_OWNER\") {
      projectV2(number: $PROJECT_QUEUE_NUMBER) {
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

  PROJECT_ITEMS_JSON=$(echo "$response" | jq '{
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

project_queue_fetch_open_issues_json() {
  OPEN_ISSUES_JSON=$(gh issue list --repo "$PROJECT_QUEUE_REPO" --state open --limit "$PROJECT_QUEUE_LIST_LIMIT" --json number,title,body)
}

project_queue_print_context() {
  local mode="$1"
  local using_fixture="$2"

  echo "Repository: $PROJECT_QUEUE_REPO"
  echo "Project: $PROJECT_QUEUE_OWNER/$PROJECT_QUEUE_NUMBER"
  echo "Queue mode: $mode"
  echo "Using fixture input: $using_fixture"
}

project_queue_load_live_state() {
  project_queue_require_gh || return 1
  project_queue_fetch_project_items_json
  project_queue_fetch_open_issues_json
}

project_queue_load_fixture_state() {
  local project_items_fixture="${PROJECT_QUEUE_ITEMS_JSON:-}"
  local open_issues_fixture="${PROJECT_QUEUE_OPEN_ISSUES_JSON:-}"

  if [ -z "$project_items_fixture" ] || [ -z "$open_issues_fixture" ]; then
    echo "Fixture mode requires both PROJECT_QUEUE_ITEMS_JSON and PROJECT_QUEUE_OPEN_ISSUES_JSON." >&2
    return 1
  fi

  PROJECT_ITEMS_JSON="$project_items_fixture"
  OPEN_ISSUES_JSON="$open_issues_fixture"
}

project_queue_validate_pre_cutover() {
  local dispatch_count
  dispatch_count=$(echo "$PROJECT_ITEMS_JSON" | jq '[.items[] | select(."agent Dispatch" == "Yes")] | length')

  echo "Dispatch-yes items: $dispatch_count"

  if [ "$dispatch_count" -ne 0 ]; then
    echo "Pre-cutover mode expects zero project items with Agent Dispatch = Yes." >&2
    echo "$PROJECT_ITEMS_JSON" | jq -r '.items[] | select(."agent Dispatch" == "Yes") | "- #\(.content.number // "draft") \(.title)"' >&2
    return 1
  fi

  echo "Pre-cutover invariant holds: no project item is currently dispatch-authoritative."
}

project_queue_validate_post_cutover() {
  local open_issue_numbers_json dispatch_open_json dispatch_open_count invalid_dispatch_json invalid_dispatch_count
  local dispatch_status unexpected_agent_ready_json unexpected_agent_ready_count

  open_issue_numbers_json=$(echo "$OPEN_ISSUES_JSON" | jq '[.[].number]')
  dispatch_open_count=$(echo "$PROJECT_ITEMS_JSON" | jq --argjson open "$open_issue_numbers_json" '
    [.items[]
      | select(."agent Dispatch" == "Yes")
      | (.content.number // null) as $issue_number
      | select(.content.type == "Issue" and (($open | index($issue_number)) != null))
    ] | length')

  echo "Dispatch-yes items: $dispatch_open_count"

  invalid_dispatch_json=$(echo "$PROJECT_ITEMS_JSON" | jq --argjson open "$open_issue_numbers_json" '
    [.items[]
      | select(."agent Dispatch" == "Yes")
      | (.content.number // null) as $issue_number
      | select(.content.type != "Issue" or (($open | index($issue_number)) == null))
    ]')
  invalid_dispatch_count=$(echo "$invalid_dispatch_json" | jq 'length')

  if [ "$invalid_dispatch_count" -gt 0 ]; then
    echo "Found Agent Dispatch = Yes on non-open issue items, which is invalid after cutover." >&2
    echo "$invalid_dispatch_json" | jq -r '.[] | "- #\(.content.number // "draft") \(.title)"' >&2
    return 1
  fi

  if [ "$dispatch_open_count" -ne 1 ]; then
    echo "Post-cutover mode requires exactly one open issue with Agent Dispatch = Yes; found $dispatch_open_count." >&2
    echo "$PROJECT_ITEMS_JSON" | jq -r --argjson open "$open_issue_numbers_json" '
      .items[]
      | select(."agent Dispatch" == "Yes")
      | select(.content.type == "Issue" and (($open | map(.number)) | index(.content.number)) != null)
      | "- #\(.content.number) \(.title)"' >&2
    return 1
  fi

  dispatch_open_json=$(echo "$PROJECT_ITEMS_JSON" | jq --argjson open "$open_issue_numbers_json" '
    [.items[]
      | select(."agent Dispatch" == "Yes")
      | (.content.number // null) as $issue_number
      | select(.content.type == "Issue" and (($open | index($issue_number)) != null))
    ]')

  dispatch_status=$(echo "$dispatch_open_json" | jq -r '.[0].status // ""')
  if [ "$dispatch_status" != "Ready" ]; then
    echo "The dispatchable issue must have Status = Ready; found '$dispatch_status'." >&2
    return 1
  fi

  if ! echo "$dispatch_open_json" | jq -e '.[0].labels // [] | index("agent-ready") != null' >/dev/null; then
    echo "The dispatchable issue is missing the derived compatibility label 'agent-ready'." >&2
    return 1
  fi

  unexpected_agent_ready_json=$(echo "$PROJECT_ITEMS_JSON" | jq '
    [.items[]
      | select(.content.type == "Issue")
      | select((.labels // []) | index("agent-ready") != null)
      | select(."agent Dispatch" != "Yes")
    ]')
  unexpected_agent_ready_count=$(echo "$unexpected_agent_ready_json" | jq 'length')

  if [ "$unexpected_agent_ready_count" -gt 0 ]; then
    echo "Found issue items labeled 'agent-ready' without Agent Dispatch = Yes." >&2
    echo "$unexpected_agent_ready_json" | jq -r '.[] | "- #\(.content.number) \(.title)"' >&2
    return 1
  fi

  DISPATCH_NUMBER=$(echo "$dispatch_open_json" | jq -r '.[0].content.number')
  DISPATCH_TITLE=$(echo "$dispatch_open_json" | jq -r '.[0].title')
  DISPATCH_ISSUE_BODY=$(echo "$OPEN_ISSUES_JSON" | jq -r --argjson issue "$DISPATCH_NUMBER" '.[] | select(.number == $issue) | .body')

  echo "Post-cutover invariant holds for #$DISPATCH_NUMBER - $DISPATCH_TITLE"
}

project_queue_validate_issue_contract() {
  local issue_number="$1"
  local issue_body="$2"

  if ! echo "$issue_body" | grep -iq "Acceptance criteria"; then
    echo "Issue #$issue_number is missing an Acceptance criteria section." >&2
    return 1
  fi

  if ! echo "$issue_body" | grep -iq "Verification"; then
    echo "Issue #$issue_number is missing a Verification section." >&2
    return 1
  fi

  if ! echo "$issue_body" | grep -iq "Relevant docs"; then
    echo "Issue #$issue_number is missing a Relevant docs section." >&2
    return 1
  fi

  if echo "$issue_body" | grep -Eiq "(auth|database|calendar|token|cron|secret|supabase|tmdb|rls)"; then
    if ! echo "$issue_body" | grep -iq "Security notes"; then
      echo "Issue #$issue_number appears security-sensitive but is missing a Security notes section." >&2
      return 1
    fi
  fi

  echo "Issue body includes Relevant docs, Acceptance criteria, and Verification."
}
