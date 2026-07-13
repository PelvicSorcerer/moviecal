#!/usr/bin/env bash

# Shared helpers for project-first queue validation scripts.
# The GitHub Project is authoritative for dispatch state; issue bodies remain
# authoritative for implementation contracts.

PROJECT_QUEUE_REPO="${PROJECT_QUEUE_REPO:-PelvicSorcerer-Software/moviecal}"
PROJECT_QUEUE_OWNER="${PROJECT_QUEUE_OWNER:-PelvicSorcerer-Software}"
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

project_queue_graphql_project_items_query() {
  local owner_kind="$1"
  local graphql_limit="$2"

  gh api graphql -f query="query {
    ${owner_kind}(login: \"$PROJECT_QUEUE_OWNER\") {
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
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
          }
        }
      }
    }
  }"
}

project_queue_normalize_project_items_response() {
  local response="$1"
  local owner_kind="$2"

  echo "$response" | jq --arg owner_kind "$owner_kind" '{
    items: [
      .data[$owner_kind].projectV2.items.nodes[]
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
          track: (
            [.fieldValues.nodes[] | select(.field.name == "Track") | .name][0] // ""
          ),
          "agent Dispatch": (
            [.fieldValues.nodes[] | select(.field.name == "Agent Dispatch") | .name][0] // ""
          ),
          dependencies: (
            [.fieldValues.nodes[] | select(.field.name == "Dependencies") | .text][0] // ""
          )
        }
    ]
  }'
}

project_queue_fetch_project_items_json() {
  local response graphql_limit=100 owner_kind
  if [ "$PROJECT_QUEUE_LIST_LIMIT" -lt "$graphql_limit" ]; then
    graphql_limit="$PROJECT_QUEUE_LIST_LIMIT"
  fi

  if PROJECT_ITEMS_JSON=$(gh project item-list "$PROJECT_QUEUE_NUMBER" --owner "$PROJECT_QUEUE_OWNER" --limit "$PROJECT_QUEUE_LIST_LIMIT" --format json 2>/dev/null); then
    return 0
  fi

  for owner_kind in organization user; do
    response=$(project_queue_graphql_project_items_query "$owner_kind" "$graphql_limit")
    if echo "$response" | jq -e --arg owner_kind "$owner_kind" '.data[$owner_kind].projectV2.items.nodes' >/dev/null 2>&1; then
      PROJECT_ITEMS_JSON=$(project_queue_normalize_project_items_response "$response" "$owner_kind")
      return 0
    fi
  done

  echo "Could not read project items for $PROJECT_QUEUE_OWNER/$PROJECT_QUEUE_NUMBER via gh project or GraphQL." >&2
  return 1
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

project_queue_validate_dispatch_track() {
  local track="$1"
  local issue_number="$2"

  case "$track" in
    "Shared Watchlists"|Calendar|Docs|Future|iOS)
      return 0
      ;;
    Product)
      echo "Issue #$issue_number has Track = Product, which is not a live project option. Map product-delivery work to a domain Track per docs/planning/project-field-taxonomy.md before setting Agent Dispatch = Yes." >&2
      return 1
      ;;
    Platform|Migration)
      echo "Issue #$issue_number has Agent Dispatch = Yes but Track = $track. Only dispatch-eligible domain tracks and Future may hold the dispatch slot." >&2
      return 1
      ;;
    "")
      echo "Issue #$issue_number has Agent Dispatch = Yes but is missing a Track field." >&2
      return 1
      ;;
    *)
      echo "Issue #$issue_number has Agent Dispatch = Yes with unknown Track = $track. See docs/planning/project-field-taxonomy.md for allowed values." >&2
      return 1
      ;;
  esac
}

project_queue_validate_issue_taxonomy_hints() {
  local issue_number="$1"
  local issue_body="$2"
  local failures=0

  if echo "$issue_body" | grep -Eq 'Track[[:space:]]*=[[:space:]]*Product'; then
    echo "Issue #$issue_number uses Track = Product in its body. Product is a policy category, not a project Track option. See docs/planning/project-field-taxonomy.md and stop before writing project fields." >&2
    failures=$((failures + 1))
  fi

  if echo "$issue_body" | grep -Eq 'Area[[:space:]]*=[[:space:]]*backend'; then
    echo "Issue #$issue_number uses Area = backend in its body. backend is not a project Area option. See docs/planning/project-field-taxonomy.md and stop before writing project fields." >&2
    failures=$((failures + 1))
  fi

  if [ "$failures" -gt 0 ]; then
    return 1
  fi
}

project_queue_validate_dependencies() {
  local deps_value="$1"
  local open_issues_json="$2"
  local project_items_json="$3"
  local self_number="${4:-}"

  # Blank means no dependencies — always passes.
  if [ -z "$deps_value" ]; then
    return 0
  fi

  # Syntax check: must be comma-separated integers only (no #, no spaces, no other chars).
  if ! echo "$deps_value" | grep -Eq '^[0-9]+(,[0-9]+)*$'; then
    echo "Invalid Dependencies field value: '$deps_value'" >&2
    echo "Expected comma-separated numeric issue numbers with no '#', no spaces, and no non-numeric tokens." >&2
    echo "Correct the Dependencies field in the GitHub Project before setting Agent Dispatch = Yes." >&2
    return 1
  fi

  # Split into individual numbers.
  local dep_numbers
  IFS=',' read -ra dep_numbers <<< "$deps_value"

  # Self-dependency check.
  if [ -n "$self_number" ]; then
    local dep
    for dep in "${dep_numbers[@]}"; do
      if [ "$dep" = "$self_number" ]; then
        echo "Invalid Dependencies field: issue #$self_number lists itself as a dependency (self-dependency)." >&2
        echo "Remove #$self_number from the Dependencies field before setting Agent Dispatch = Yes." >&2
        return 1
      fi
    done
  fi

  # For each dependency, check satisfaction.
  local unsatisfied=()
  local dep
  for dep in "${dep_numbers[@]}"; do
    # Is this issue number referenced by any other item that itself depends on the current issue?
    # We'll do cycle detection as part of this loop below via a separate helper.

    # Is the dep a closed issue? A closed issue is not in OPEN_ISSUES_JSON.
    local is_open
    is_open=$(echo "$open_issues_json" | jq --argjson n "$dep" 'map(select(.number == $n)) | length')

    if [ "$is_open" -eq 0 ]; then
      # Not in open issues. Per contract: a closed GitHub issue → satisfied.
      # Check whether the dep appears in project items; if so, it's clearly a closed issue.
      local in_project
      in_project=$(echo "$project_items_json" | jq --argjson n "$dep" \
        '[.items[] | select(.content.type == "Issue" and .content.number == $n)] | length')

      if [ "$in_project" -eq 0 ]; then
        # Not in open issues, not in project items.
        # Nonexistent detection requires a live gh call; fixture mode cannot distinguish
        # a closed issue that was never added to the project from a genuinely nonexistent one.
        # In fixture mode: assume closed → satisfied (callers control the fixture data).
        # In live mode: confirm via gh issue view; error only if the issue truly doesn't exist.
        local using_fixture=false
        if [ -n "${PROJECT_QUEUE_ITEMS_JSON:-}" ] || [ -n "${PROJECT_QUEUE_OPEN_ISSUES_JSON:-}" ]; then
          using_fixture=true
        fi

        if [ "$using_fixture" = "false" ] && command -v gh >/dev/null 2>&1; then
          if ! gh issue view "$dep" --repo "$PROJECT_QUEUE_REPO" >/dev/null 2>&1; then
            echo "Invalid Dependencies field: referenced issue #$dep does not exist." >&2
            echo "Verify that issue #$dep exists and update the Dependencies field accordingly." >&2
            return 1
          fi
        fi
        # Closed (confirmed via gh or assumed in fixture mode) → satisfied.
        continue
      fi

      # It's in the project but not in open issues → it was closed; satisfied.
      continue
    fi

    # Issue is open — check its project Status.
    local status
    status=$(echo "$project_items_json" | jq -r --argjson n "$dep" \
      '[.items[] | select(.content.type == "Issue" and .content.number == $n) | .status][0] // ""')

    if [ "$status" = "Done" ]; then
      # Open but Status = Done → satisfied.
      continue
    fi

    # Open and Status ≠ Done → unsatisfied blocker.
    unsatisfied+=("$dep")
  done

  # Cycle detection: build a simple dependency graph from project items and check for cycles.
  # We detect cycles involving the current dispatch candidate's dependency set.
  if [ -n "$self_number" ]; then
    local cycle_result
    cycle_result=$(echo "$project_items_json" | jq -r \
      --argjson self_num "$self_number" \
      --arg deps_value "$deps_value" '
      # Build adjacency map: issue_number -> [dep_numbers]
      # Include the dispatch candidate itself.
      def parse_deps(s):
        if s == "" then []
        else (s | split(",") | map(tonumber))
        end;

      # Build map from project items
      (reduce .items[] as $item (
        {};
        if ($item.content.type == "Issue" and $item.content.number != null) then
          . + {($item.content.number | tostring): parse_deps($item.dependencies // "")}
        else . end
      )) as $graph |

      # Override/add the dispatch candidate with the provided deps
      ($graph + {($self_num | tostring): parse_deps($deps_value)}) as $graph |

      # DFS cycle detection starting from self_num.
      # Capture node as $node immediately: jq passes args as filter thunks, so
      # "node" re-evaluates "." in each piped context. Without capturing first,
      # "stack | index(node)" becomes "stack | index(stack)" (always found).
      def has_cycle(node; visited; stack):
        node as $node |
        if (stack | index($node)) != null then true
        elif (visited | index($node)) != null then false
        else
          ($graph[($node | tostring)] // []) as $neighbors |
          ($neighbors | length) > 0 and
          ($neighbors | any(. as $n | has_cycle($n; visited + [$node]; stack + [$node])))
        end;

      if has_cycle($self_num; []; []) then
        "CYCLE"
      else
        "OK"
      end
    ')

    if [ "$cycle_result" = "CYCLE" ]; then
      echo "Invalid Dependencies field: a dependency cycle was detected involving issue #$self_number." >&2
      echo "Inspect the Dependencies fields of the referenced issues and break the cycle before setting Agent Dispatch = Yes." >&2
      return 1
    fi
  fi

  if [ "${#unsatisfied[@]}" -gt 0 ]; then
    echo "Issue #${self_number:-?} has unsatisfied dependencies: ${unsatisfied[*]}" >&2
    local u
    for u in "${unsatisfied[@]}"; do
      local u_status
      u_status=$(echo "$project_items_json" | jq -r --argjson n "$u" \
        '[.items[] | select(.content.type == "Issue" and .content.number == $n) | .status][0] // "(unknown)"')
      echo "  - #$u is open with Status = $u_status (must be Done or closed to satisfy dependency)" >&2
    done
    echo "Resolve the above issues before setting Agent Dispatch = Yes on issue #${self_number:-?}." >&2
    return 1
  fi

  return 0
}

project_queue_validate_post_cutover() {
  local open_issue_numbers_json dispatch_open_json dispatch_open_count invalid_dispatch_json invalid_dispatch_count
  local dispatch_status dispatch_track

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

  if [ "$dispatch_open_count" -gt 1 ]; then
    echo "Post-cutover mode allows at most one open issue with Agent Dispatch = Yes; found $dispatch_open_count." >&2
    echo "$PROJECT_ITEMS_JSON" | jq -r --argjson open "$open_issue_numbers_json" '
      .items[]
      | select(."agent Dispatch" == "Yes")
      | select(.content.type == "Issue" and (($open | index(.content.number)) != null))
      | "- #\(.content.number) \(.title)"' >&2
    return 1
  fi

  unset DISPATCH_NUMBER DISPATCH_TITLE DISPATCH_ISSUE_BODY

  if [ "$dispatch_open_count" -eq 0 ]; then
    echo "Post-cutover queue is blocked: no open issue currently has Agent Dispatch = Yes."
    return 0
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

  DISPATCH_NUMBER=$(echo "$dispatch_open_json" | jq -r '.[0].content.number')
  dispatch_track=$(echo "$dispatch_open_json" | jq -r '.[0].track // ""')
  project_queue_validate_dispatch_track "$dispatch_track" "$DISPATCH_NUMBER" || return 1

  local dispatch_deps
  dispatch_deps=$(echo "$dispatch_open_json" | jq -r '.[0].dependencies // ""')
  project_queue_validate_dependencies "$dispatch_deps" "$OPEN_ISSUES_JSON" "$PROJECT_ITEMS_JSON" "$DISPATCH_NUMBER" || return 1

  DISPATCH_TITLE=$(echo "$dispatch_open_json" | jq -r '.[0].title')
  DISPATCH_ISSUE_BODY=$(echo "$OPEN_ISSUES_JSON" | jq -r --argjson issue "$DISPATCH_NUMBER" '.[] | select(.number == $issue) | .body')

  echo "Post-cutover invariant holds for #$DISPATCH_NUMBER - $DISPATCH_TITLE"
}

project_queue_validate_worker_dispatch() {
  project_queue_validate_post_cutover || return 1

  if [ -z "${DISPATCH_NUMBER:-}" ]; then
    echo "Worker implementation requires exactly one open issue with Agent Dispatch = Yes and Status = Ready." >&2
    echo "The queue is currently blocked; promote the next issue in the GitHub Project before dispatching a worker." >&2
    return 1
  fi
}

project_queue_validate_claude_model_annotation() {
  local issue_number="$1"
  local issue_body="$2"
  local model_value

  model_value=$(echo "$issue_body" | grep -i "Requested Claude model" | head -1 | sed 's/.*Requested Claude model[[:space:]]*:[[:space:]]*//' | tr -d '`' | awk '{print $1}')

  case "$model_value" in
    ""|"<!--"*)
      # No value or unfilled template comment — not a Claude worker issue; skip
      return 0
      ;;
    default)
      echo "Issue #$issue_number specifies 'Requested Claude model: default'. An explicit model ID is required; see docs/operators/claude-model-selection-policy.md." >&2
      return 1
      ;;
    claude-haiku-4-5|claude-sonnet-4-6|claude-sonnet-5|claude-opus-4-8)
      echo "Claude model annotation for #$issue_number: $model_value (valid)"
      return 0
      ;;
    *)
      echo "Issue #$issue_number specifies an unrecognized Claude model: '$model_value'. Valid options: claude-haiku-4-5 | claude-sonnet-4-6 | claude-sonnet-5 | claude-opus-4-8." >&2
      return 1
      ;;
  esac
}

project_queue_validate_testing_governance() {
  local repo_root="$1"
  local failures=0

  # Check 1: Required testing policy docs exist on disk.
  # These are referenced from testing-lanes.md, repository-testing-strategy.md,
  # manual-versus-automated-testing-policy.md, and AGENTS.md.
  local doc
  for doc in \
    "docs/planning/testing-lanes.md" \
    "docs/planning/repository-testing-strategy.md" \
    "docs/planning/manual-versus-automated-testing-policy.md" \
    "docs/planning/test-environment-contract.md" \
    "docs/planning/manual-testing-checklist-template.md" \
    "docs/planning/browser-runtime-test-stability.md"
  do
    if [ ! -f "$repo_root/$doc" ]; then
      echo "MISSING referenced testing policy doc: $doc" >&2
      failures=$((failures + 1))
    fi
  done

  # Check 2: Required testing-related sections in governance surfaces.

  local pr_template="$repo_root/.github/pull_request_template.md"
  if [ -f "$pr_template" ]; then
    if ! grep -qi "Test Impact" "$pr_template"; then
      echo "MISSING required 'Test Impact' section in .github/pull_request_template.md" >&2
      failures=$((failures + 1))
    fi
  else
    echo "MISSING .github/pull_request_template.md" >&2
    failures=$((failures + 1))
  fi

  local agent_task_template="$repo_root/.github/ISSUE_TEMPLATE/agent_task.md"
  if [ -f "$agent_task_template" ]; then
    if ! grep -qi "Testing Expectations" "$agent_task_template"; then
      echo "MISSING required 'Testing Expectations' section in .github/ISSUE_TEMPLATE/agent_task.md" >&2
      failures=$((failures + 1))
    fi
  else
    echo "MISSING .github/ISSUE_TEMPLATE/agent_task.md" >&2
    failures=$((failures + 1))
  fi

  local agents_md="$repo_root/AGENTS.md"
  if [ -f "$agents_md" ]; then
    if ! grep -qi "testing-lanes" "$agents_md"; then
      echo "AGENTS.md does not reference testing-lanes.md — testing governance docs may have drifted from the agent contract" >&2
      failures=$((failures + 1))
    fi
  else
    echo "MISSING AGENTS.md" >&2
    failures=$((failures + 1))
  fi

  # Check 3: Lane commands documented in testing-lanes.md exist in package.json.
  local package_json="$repo_root/package.json"
  if [ ! -f "$package_json" ]; then
    echo "MISSING package.json" >&2
    failures=$((failures + 1))
  else
    local lane
    for lane in "lane:baseline" "lane:unit" "lane:integration" "lane:browser" "lane:real-stack" "verify"; do
      if ! jq -e --arg lane "$lane" '.scripts | has($lane)' "$package_json" >/dev/null 2>&1; then
        echo "Lane command '$lane' is documented in testing-lanes.md but missing from package.json scripts" >&2
        failures=$((failures + 1))
      fi
    done
  fi

  # Check 4: CI workflow files referenced in testing-lanes.md exist.
  local workflow
  for workflow in \
    ".github/workflows/verify.yml" \
    ".github/workflows/browser-verify.yml" \
    ".github/workflows/supabase-verify.yml" \
    ".github/workflows/smoke-external.yml" \
    ".github/workflows/smoke-post-deploy.yml"
  do
    if [ ! -f "$repo_root/$workflow" ]; then
      echo "MISSING CI workflow referenced in testing-lanes.md: $workflow" >&2
      failures=$((failures + 1))
    fi
  done

  if [ "$failures" -gt 0 ]; then
    echo ""
    echo "Testing governance check FAILED: $failures issue(s) detected. Fix the above before merging." >&2
    return 1
  fi

  echo "Testing governance check passed: all referenced testing docs, required sections, lane commands, and workflow files are present."
  return 0
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

  project_queue_validate_claude_model_annotation "$issue_number" "$issue_body" || return 1

  echo "Issue body includes Relevant docs, Acceptance criteria, and Verification."
}
