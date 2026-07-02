#!/usr/bin/env bash
# Add Platform track issues (#98, #102–#106) to the moviecal Delivery GitHub Project.
# Requires gh authenticated with project scope (see AGENTS.md GITHUB_PAT_OPERATOR).
set -euo pipefail

repo="${PROJECT_QUEUE_REPO:-PelvicSorcerer/moviecal}"
owner="${PROJECT_QUEUE_OWNER:-PelvicSorcerer}"
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
  [98]="In Progress"
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

issues=(98 102 103 104 105 106)

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Set GITHUB_PAT_OPERATOR and start a new agent run." >&2
  exit 1
fi

if ! gh project view "$project_number" --owner "$owner" >/dev/null 2>&1; then
  echo "Cannot access project $owner/$project_number." >&2
  echo "Ensure GITHUB_PAT_OPERATOR has Account → Projects (Read and write)." >&2
  echo "Verify with: gh project list --owner $owner" >&2
  exit 1
fi

project_id=$(gh project view "$project_number" --owner "$owner" --format json --jq .id)
fields_json=$(gh project field-list "$project_number" --owner "$owner" --format json)
items_json=$(gh project item-list "$project_number" --owner "$owner" --limit 500 --format json)

field_id() {
  local name="$1"
  echo "$fields_json" | jq -r --arg n "$name" '.fields[] | select(.name == $n) | .id' | head -1
}

single_select_option_id() {
  local field_name="$1"
  local option_name="$2"
  echo "$fields_json" | jq -r --arg fn "$field_name" --arg on "$option_name" \
    '.fields[] | select(.name == $fn) | .options[]? | select(.name == $on) | .id' | head -1
}

item_id_for_issue() {
  local issue_num="$1"
  echo "$items_json" | jq -r --argjson n "$issue_num" \
    '.items[] | select(.content.type == "Issue" and .content.number == $n) | .id' | head -1
}

set_single_select() {
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
  gh project item-edit --id "$item_id" --project-id "$project_id" --field-id "$fid" --single-select-option-id "$oid" >/dev/null
  echo "  set $field_name = $value"
}

set_number() {
  local item_id="$1"
  local field_name="$2"
  local value="$3"
  local fid
  fid=$(field_id "$field_name")
  if [ -z "$fid" ]; then
    echo "  warn: could not resolve field '$field_name'" >&2
    return 0
  fi
  gh project item-edit --id "$item_id" --project-id "$project_id" --field-id "$fid" --number "$value" >/dev/null
  echo "  set $field_name = $value"
}

echo "Project: $owner/$project_number ($project_id)"
echo "Repository: $repo"
echo

for issue in "${issues[@]}"; do
  url="https://github.com/$repo/issues/$issue"
  item_id=$(item_id_for_issue "$issue")

  if [ -n "$item_id" ]; then
    echo "#$issue already in project (item $item_id)"
  else
    echo "Adding #$issue to project..."
    add_json=$(gh project item-add "$project_number" --owner "$owner" --url "$url" --format json)
    item_id=$(echo "$add_json" | jq -r '.id')
    echo "  added item $item_id"
    items_json=$(gh project item-list "$project_number" --owner "$owner" --limit 500 --format json)
  fi

  set_number "$item_id" "Queue Order" "${QUEUE_ORDER[$issue]}"
  set_single_select "$item_id" "Track" "Platform"
  set_single_select "$item_id" "Status" "${STATUS[$issue]}"
  set_single_select "$item_id" "Area" "${AREA[$issue]}"
  set_single_select "$item_id" "Execution Mode" "${EXECUTION_MODE[$issue]}"
  set_single_select "$item_id" "Agent Dispatch" "No"
  set_single_select "$item_id" "Priority" "${PRIORITY[$issue]}"
  echo
done

echo "Platform track sync complete. Run 'npm run agent:project-check' to validate project invariants."
