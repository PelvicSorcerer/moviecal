#!/usr/bin/env bash
set -euo pipefail

# Exports a generated compatibility artifact for product-track queue ordering only.
# Dispatch promotion uses live project fields and considers both Product and Future tracks.
# This export intentionally excludes Future, Platform, Migration, process, and docs items.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/project-queue-common.sh
source "$repo_root/scripts/lib/project-queue-common.sh"

output_path="${1:-docs/planning/open-issue-order.json}"

project_queue_require_gh
project_queue_require_jq

project_queue_fetch_project_items_json
project_queue_fetch_open_issues_json

project_items_json="$PROJECT_ITEMS_JSON"
open_issues_json="$OPEN_ISSUES_JSON"

generated_json=$(jq -n \
  --arg repo "$PROJECT_QUEUE_REPO" \
  --arg owner "$PROJECT_QUEUE_OWNER" \
  --argjson project_number "$PROJECT_QUEUE_NUMBER" \
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
