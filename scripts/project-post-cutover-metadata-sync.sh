#!/usr/bin/env bash
# Apply post-cutover metadata to the moviecal Delivery GitHub Project (issue #119).
# Idempotent: skips only when both the short description and readme match the canonical post-cutover text.
set -euo pipefail

owner="${PROJECT_QUEUE_OWNER:-PelvicSorcerer}"
project_number="${PROJECT_QUEUE_NUMBER:-1}"

read -r -d '' POST_CUTOVER_SHORT_DESCRIPTION <<'EOF' || true
Operational delivery board for moviecal. GitHub Project is the authoritative source for live queue state, workflow status, and execution order. GitHub issues remain the authoritative source for scoped task requirements, acceptance criteria, verification steps, and security notes.
EOF

read -r -d '' POST_CUTOVER_README <<'EOF' || true
## Queue authority

GitHub Project is the authoritative source for live queue state, workflow status, and execution order. GitHub issues remain the authoritative source for scoped task requirements, acceptance criteria, verification steps, and security notes. Repo planning docs describe policy and context only; they do not define the live execution queue.

## Dispatch rule

A fresh implementation agent may start only from the single open issue whose project item has `Agent Dispatch = Yes` and `Status = Ready`. If no such issue exists, the queue is intentionally blocked pending orchestrator action.

## Compatibility surfaces

`docs/planning/open-issue-order.json` is a generated compatibility artifact only. Use `npm run agent:project-check` to validate the live dispatch invariant from project state.
EOF

ROLLOUT_MARKERS=(
  "planning-only"
  "repo-driven queue remains authoritative"
  "repo-driven queue model remains authoritative"
)

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

requires_rollout_update() {
  local description="$1"
  local marker

  for marker in "${ROLLOUT_MARKERS[@]}"; do
    if [[ "$description" == *"$marker"* ]]; then
      return 0
    fi
  done

  return 1
}

metadata_matches_expected() {
  [ "$CURRENT_SHORT_DESCRIPTION" = "$POST_CUTOVER_SHORT_DESCRIPTION" ] &&
    [ "$CURRENT_README" = "$POST_CUTOVER_README" ]
}

describe_metadata_drift() {
  if requires_rollout_update "$CURRENT_SHORT_DESCRIPTION"; then
    echo "- short description contains rollout-era wording"
  elif [ "$CURRENT_SHORT_DESCRIPTION" != "$POST_CUTOVER_SHORT_DESCRIPTION" ]; then
    echo "- short description does not match the canonical post-cutover text"
  fi

  if [ -z "$CURRENT_README" ]; then
    echo "- readme is missing"
  elif [ "$CURRENT_README" != "$POST_CUTOVER_README" ]; then
    echo "- readme does not match the canonical post-cutover text"
  fi
}

load_project_metadata() {
  local response
  response=$(gh api graphql -f query="query {
    user(login: \"$owner\") {
      projectV2(number: $project_number) {
        id
        title
        shortDescription
        readme
      }
    }
  }")

  PROJECT_ID=$(echo "$response" | jq -r '.data.user.projectV2.id')
  PROJECT_TITLE=$(echo "$response" | jq -r '.data.user.projectV2.title')
  CURRENT_SHORT_DESCRIPTION=$(echo "$response" | jq -r '.data.user.projectV2.shortDescription // ""')
  CURRENT_README=$(echo "$response" | jq -r '.data.user.projectV2.readme // ""')
}

update_project_metadata() {
  gh api graphql \
    -f query='mutation($projectId: ID!, $shortDescription: String!, $readme: String!) {
      updateProjectV2(input: {
        projectId: $projectId
        shortDescription: $shortDescription
        readme: $readme
      }) {
        projectV2 {
          id
          title
          shortDescription
        }
      }
    }' \
    -f projectId="$PROJECT_ID" \
    -f shortDescription="$POST_CUTOVER_SHORT_DESCRIPTION" \
    -f readme="$POST_CUTOVER_README" >/dev/null
}

main() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI is required." >&2
    exit 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required." >&2
    exit 1
  fi

  setup_auth
  load_project_metadata

  echo "Project: $PROJECT_TITLE ($owner/$project_number)"

  if metadata_matches_expected; then
    echo "Project metadata already matches the post-cutover operating model."
    echo "Current description: $CURRENT_SHORT_DESCRIPTION"
    exit 0
  fi

  echo "Updating project metadata to the canonical post-cutover state..."
  describe_metadata_drift
  if [ -n "$CURRENT_SHORT_DESCRIPTION" ]; then
    echo "Previous description: $CURRENT_SHORT_DESCRIPTION"
  fi
  update_project_metadata
  load_project_metadata
  echo "Updated description: $CURRENT_SHORT_DESCRIPTION"

  if ! metadata_matches_expected; then
    echo "Project metadata still does not match the canonical post-cutover text after update." >&2
    describe_metadata_drift >&2
    exit 1
  fi

  if requires_rollout_update "$CURRENT_SHORT_DESCRIPTION"; then
    echo "Project metadata still contains rollout-era wording after update." >&2
    exit 1
  fi

  echo "Post-cutover project metadata sync complete."
}

main "$@"
