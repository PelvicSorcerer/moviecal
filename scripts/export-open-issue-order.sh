#!/usr/bin/env bash
set -euo pipefail

repo="${PROJECT_QUEUE_REPO:-PelvicSorcerer/moviecal}"
owner="${PROJECT_QUEUE_OWNER:-PelvicSorcerer}"
project_number="${PROJECT_QUEUE_NUMBER:-1}"
list_limit="${PROJECT_QUEUE_LIST_LIMIT:-200}"
output_path="${1:-docs/planning/open-issue-order.json}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is not installed. Install/authenticate gh before exporting queue compatibility data." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is not installed. Install jq before exporting queue compatibility data." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh CLI is not authenticated. Run 'gh auth login -h github.com' before exporting queue compatibility data." >&2
  exit 1
fi

project_items_json=$(gh project item-list "$project_number" --owner "$owner" --limit "$list_limit" --format json)
open_issues_json=$(gh issue list --repo "$repo" --state open --limit "$list_limit" --json number)

generated_json=$(jq -n \
  --arg repo "$repo" \
  --arg owner "$owner" \
  --argjson project_number "$project_number" \
  --arg generated_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  --argjson items "$project_items_json" \
  --argjson open_issues "$open_issues_json" '
  {
    generated: true,
    compatibilityOnly: true,
    source: {
      type: "github-project",
      owner: $owner,
      projectNumber: $project_number,
      repo: $repo
    },
    generatedAt: $generated_at,
    note: "Generated compatibility artifact. The GitHub Project is authoritative; do not hand-edit this file.",
    queue: (
      [
        $items.items[]
        | (.content.number // null) as $issue_number
        | select(.content.type == "Issue")
        | select((($open_issues | map(.number)) | index($issue_number)) != null)
        | select(.track != "Migration")
        | select(.track != "Platform")
        | select(.track != "Future")
        | select(.area != "process")
        | select(.area != "docs")
        | select(.queueOrder != null or ."queue Order" != null)
        | {
            issue: $issue_number,
            title: .title,
            queueOrder: (.queueOrder // ."queue Order")
          }
      ]
      | sort_by(.queueOrder)
      | map({ issue, title })
    )
  }')

mkdir -p "$(dirname "$output_path")"
printf '%s\n' "$generated_json" > "$output_path"
echo "Wrote compatibility queue artifact to $output_path"
