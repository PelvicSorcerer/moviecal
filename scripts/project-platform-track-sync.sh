#!/usr/bin/env bash
# Add Platform track items (#98 PR, #102–#106 issues) to the moviecal Delivery GitHub Project.
# Uses the Projects GraphQL API so a classic PAT with project+repo scopes works without read:org.
set -euo pipefail

repo="${PROJECT_QUEUE_REPO:-PelvicSorcerer-Software/moviecal}"
repo_owner="${repo%%/*}"
repo_name="${repo##*/}"
owner="${PROJECT_QUEUE_OWNER:-PelvicSorcerer-Software}"
project_number="${PROJECT_QUEUE_NUMBER:-1}"

declare -A QUEUE_ORDER=(
  [98]=96
  [102]=97
  [103]=98
  [104]=99
  [105]=100
  [106]=101
)

declare -A STATUS=(
  [98]="Done"
  [102]="Backlog"
  [103]="Backlog"
  [104]="Backlog"
  [105]="Backlog"
  [106]="Backlog"
)

declare -A EXECUTION_MODE=(
  [98]="Agent"
  [102]="Human"
  [103]="Agent"
  [104]="Agent"
  [105]="Either"
  [106]="Either"
)

declare -A PRIORITY=(
  [98]="P1"
  [102]="P1"
  [103]="P2"
  [104]="P2"
  [105]="P3"
  [106]="P3"
)

declare -A AREA=(
  [98]="docs"
  [102]="process"
  [103]="process"
  [104]="docs"
  [105]="process"
  [106]="process"
)

# #98 is PR #98 (docs/operators restructure), not a standalone issue.
platform_items=(98 102 103 104 105 106)

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

setup_auth() {
  if [ -n "${GITHUB_PAT_OPERATOR:-}" ]; then
    export GH_TOKEN="$GITHUB_PAT_OPERATOR"
  fi
  unset GITHUB_TOKEN 2>/dev/null || true

  if [ -z "${GH_TOKEN:-}" ]; then
    echo "GITHUB_PAT_OPERATOR or GH_TOKEN is required (classic PAT: project + repo scopes)." >&2
    exit 1
  fi
}

gh_graphql() {
  gh api graphql "$@"
}

load_project() {
  local response owner_kind
  for owner_kind in organization user; do
    response=$(gh_graphql -f query="query {
      ${owner_kind}(login: \"$owner\") {
        projectV2(number: $project_number) {
          id
          title
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
          items(first: 100) {
            nodes {
              id
              content {
                ... on Issue { number }
                ... on PullRequest { number }
              }
            }
          }
        }
      }
    }")

    if [ "$(echo "$response" | jq -r --arg owner_kind "$owner_kind" '.data[$owner_kind].projectV2.id // empty')" = "" ]; then
      continue
    fi

    project_id=$(echo "$response" | jq -r --arg owner_kind "$owner_kind" '.data[$owner_kind].projectV2.id')
    project_title=$(echo "$response" | jq -r --arg owner_kind "$owner_kind" '.data[$owner_kind].projectV2.title')
    fields_json=$(echo "$response" | jq --arg owner_kind "$owner_kind" '.data[$owner_kind].projectV2.fields.nodes')
    items_json=$(echo "$response" | jq --arg owner_kind "$owner_kind" '.data[$owner_kind].projectV2.items.nodes')
    return 0
  done

  echo "Cannot access project $owner/$project_number." >&2
  echo "Ensure GITHUB_PAT_OPERATOR is set with classic PAT scopes: project, repo." >&2
  echo "Verify with: GH_TOKEN=\$GITHUB_PAT_OPERATOR gh api graphql -f query='{ viewer { login } }'" >&2
  exit 1
}

field_id() {
  local name="$1"
  echo "$fields_json" | jq -r --arg n "$name" '.[] | select(.name == $n) | .id' | head -1
}

single_select_option_id() {
  local field_name="$1"
  local option_name="$2"
  echo "$fields_json" | jq -r --arg fn "$field_name" --arg on "$option_name" \
    '.[] | select(.name == $fn) | .options[]? | select(.name == $on) | .id' | head -1
}

item_id_for_number() {
  local num="$1"
  echo "$items_json" | jq -r --argjson n "$num" \
    '.[] | select(.content.number == $n) | .id' | head -1
}

content_id_for_number() {
  local num="$1"
  local response

  if [ "$num" = "98" ]; then
    response=$(gh_graphql -f query="query {
      repository(owner: \"$repo_owner\", name: \"$repo_name\") {
        pullRequest(number: $num) { id number title }
      }
    }")
    echo "$response" | jq -r '.data.repository.pullRequest.id // empty'
    return
  fi

  response=$(gh_graphql -f query="query {
    repository(owner: \"$repo_owner\", name: \"$repo_name\") {
      issue(number: $num) { id number title }
    }
  }")
  echo "$response" | jq -r '.data.repository.issue.id // empty'
}

add_item() {
  local content_id="$1"
  local response
  response=$(gh_graphql -f query="mutation {
    addProjectV2ItemById(input: { projectId: \"$project_id\", contentId: \"$content_id\" }) {
      item { id }
    }
  }")
  echo "$response" | jq -r '.data.addProjectV2ItemById.item.id'
}

set_number_field() {
  local item_id="$1"
  local field_name="$2"
  local value="$3"
  local fid
  fid=$(field_id "$field_name")
  if [ -z "$fid" ]; then
    echo "  warn: could not resolve field '$field_name'" >&2
    return 0
  fi
  gh_graphql -f query="mutation {
    updateProjectV2ItemFieldValue(input: {
      projectId: \"$project_id\"
      itemId: \"$item_id\"
      fieldId: \"$fid\"
      value: { number: $value }
    }) { projectV2Item { id } }
  }" >/dev/null
  echo "  set $field_name = $value"
}

set_single_select_field() {
  local item_id="$1"
  local field_name="$2"
  local value="$3"
  local fid oid
  fid=$(field_id "$field_name")
  oid=$(single_select_option_id "$field_name" "$value")
  if [ -z "$fid" ] || [ -z "$oid" ]; then
    echo "  warn: could not resolve field '$field_name' = '$value'" >&2
    return 0
  fi
  gh_graphql -f query="mutation {
    updateProjectV2ItemFieldValue(input: {
      projectId: \"$project_id\"
      itemId: \"$item_id\"
      fieldId: \"$fid\"
      value: { singleSelectOptionId: \"$oid\" }
    }) { projectV2Item { id } }
  }" >/dev/null
  echo "  set $field_name = $value"
}

setup_auth
load_project

echo "Project: $owner/$project_number ($project_title)"
echo "Repository: $repo"
echo

for num in "${platform_items[@]}"; do
  item_id=$(item_id_for_number "$num")
  label="#$num"
  [ "$num" = "98" ] && label="PR #$num"

  if [ -n "$item_id" ]; then
    echo "$label already in project (item $item_id)"
  else
    content_id=$(content_id_for_number "$num")
    if [ -z "$content_id" ]; then
      echo "Could not resolve GraphQL node id for $label; skipping." >&2
      continue
    fi
    echo "Adding $label to project..."
    item_id=$(add_item "$content_id")
    echo "  added item $item_id"
    items_json=$(echo "$items_json" | jq --arg id "$item_id" --argjson n "$num" \
      '. + [{id: $id, content: {number: $n}}]')
  fi

  set_number_field "$item_id" "Queue Order" "${QUEUE_ORDER[$num]}"
  set_single_select_field "$item_id" "Track" "Platform"
  set_single_select_field "$item_id" "Status" "${STATUS[$num]}"
  set_single_select_field "$item_id" "Area" "${AREA[$num]}"
  set_single_select_field "$item_id" "Execution Mode" "${EXECUTION_MODE[$num]}"
  set_single_select_field "$item_id" "Agent Dispatch" "No"
  set_single_select_field "$item_id" "Priority" "${PRIORITY[$num]}"
  echo
done

echo "Platform track sync complete. Run 'npm run agent:project-check' to validate project invariants."
