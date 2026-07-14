#!/usr/bin/env bash
# Fixture-based tests for project_queue_validate_dependencies.
# Uses PROJECT_QUEUE_ITEMS_JSON and PROJECT_QUEUE_OPEN_ISSUES_JSON env vars (fixture mode)
# so no live GitHub connection is needed.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/project-queue-common.sh
source "$repo_root/scripts/lib/project-queue-common.sh"

# Mark every case as fixture-driven so an authenticated local `gh` session
# cannot turn a deterministic unit test into a live issue lookup.
export PROJECT_QUEUE_ITEMS_JSON='{"items":[]}'
export PROJECT_QUEUE_OPEN_ISSUES_JSON='[]'

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

PASS=0
FAIL=0
ERRORS=()

assert_pass() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected success, got failure)"
    ERRORS+=("$label")
    FAIL=$((FAIL + 1))
  fi
}

assert_fail() {
  local label="$1"
  shift
  local output
  if output=$("$@" 2>&1); then
    echo "FAIL: $label (expected failure, got success)"
    ERRORS+=("$label")
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $label"
    PASS=$((PASS + 1))
  fi
}

assert_fail_message() {
  local label="$1"
  local expected_fragment="$2"
  shift 2
  local output
  if output=$("$@" 2>&1); then
    echo "FAIL: $label (expected failure, got success)"
    ERRORS+=("$label")
    FAIL=$((FAIL + 1))
  else
    if echo "$output" | grep -qF "$expected_fragment"; then
      echo "PASS: $label"
      PASS=$((PASS + 1))
    else
      echo "FAIL: $label (failure output did not contain '$expected_fragment')"
      echo "  Actual output: $output"
      ERRORS+=("$label")
      FAIL=$((FAIL + 1))
    fi
  fi
}

# ---------------------------------------------------------------------------
# Fixture data helpers
# ---------------------------------------------------------------------------

# Build a minimal PROJECT_ITEMS_JSON with given items.
# Each item: "NUMBER:STATUS:DEPS" e.g. "100:Ready:" or "101:Done:100"
make_project_items() {
  local json='{"items":['
  local first=1
  for item_spec in "$@"; do
    local number status deps
    number=$(echo "$item_spec" | cut -d: -f1)
    status=$(echo "$item_spec" | cut -d: -f2)
    deps=$(echo "$item_spec" | cut -d: -f3)
    [ "$first" -eq 0 ] && json+=","
    json+=$(printf '{"title":"Issue %s","labels":[],"content":{"type":"Issue","number":%s},"status":"%s","track":"Calendar","agent Dispatch":"No","dependencies":"%s"}' \
      "$number" "$number" "$status" "$deps")
    first=0
  done
  json+=']}'
  echo "$json"
}

# Build an OPEN_ISSUES_JSON array for given issue numbers.
make_open_issues() {
  local json='['
  local first=1
  for n in "$@"; do
    [ "$first" -eq 0 ] && json+=","
    json+=$(printf '{"number":%s,"title":"Issue %s","body":""}' "$n" "$n")
    first=0
  done
  json+=']'
  echo "$json"
}

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

echo "=== project_queue_validate_dependencies tests ==="
echo ""

# 1. Blank dependencies (no deps) — always passes.
assert_pass "blank deps -> passes" \
  project_queue_validate_dependencies "" '[]' '{"items":[]}' "100"

# 2. Valid comma-separated deps where all are satisfied (Status=Done).
PI=$(make_project_items "101:Done:" "102:Done:")
OI=$(make_open_issues 101 102)
assert_pass "all deps satisfied (Status=Done) -> passes" \
  project_queue_validate_dependencies "101,102" "$OI" "$PI" "100"

# 3. Dep satisfied because issue is closed (not in open issues).
PI=$(make_project_items "101:Done:")
OI='[]'  # 101 is closed (not in open issues list)
assert_pass "closed dep -> satisfied -> passes" \
  project_queue_validate_dependencies "101" "$OI" "$PI" "100"

# 4. Dep with '#' prefix — syntax failure.
PI=$(make_project_items "101:Done:")
OI=$(make_open_issues 101)
assert_fail_message "dep with # prefix -> fails with clear message" \
  "no '#'" \
  project_queue_validate_dependencies "#101" "$OI" "$PI" "100"

# 5. Dep with spaces — syntax failure.
PI=$(make_project_items "101:Done:" "102:Done:")
OI=$(make_open_issues 101 102)
assert_fail_message "dep with spaces -> fails with clear message" \
  "no spaces" \
  project_queue_validate_dependencies "101, 102" "$OI" "$PI" "100"

# 6. Non-numeric token — syntax failure.
assert_fail_message "non-numeric token -> fails with clear message" \
  "no non-numeric tokens" \
  project_queue_validate_dependencies "101,abc" '[]' '{"items":[]}' "100"

# 7. Self-dependency — hard failure.
PI=$(make_project_items "100:Ready:")
OI=$(make_open_issues 100)
assert_fail_message "self-dependency -> fails with clear message" \
  "self-dependency" \
  project_queue_validate_dependencies "100" "$OI" "$PI" "100"

# 8. Cycle: A(100) depends on B(101), B(101) depends on A(100).
PI=$(make_project_items "100:Ready:101" "101:Ready:100")
OI=$(make_open_issues 100 101)
assert_fail_message "cycle A->B->A -> fails with clear message" \
  "cycle" \
  project_queue_validate_dependencies "101" "$OI" "$PI" "100"

# 9. Dep absent from open issues AND project items in fixture mode.
# Nonexistent detection requires a live `gh issue view` call, which only runs in live mode.
# In fixture mode (PROJECT_QUEUE_ITEMS_JSON / PROJECT_QUEUE_OPEN_ISSUES_JSON env vars set),
# the dep is assumed closed (satisfied) because callers control the fixture data and cannot
# distinguish a closed issue that was never added to the project from a nonexistent one.
PI='{"items":[]}'
OI='[]'
assert_pass "dep absent from open issues and project (fixture mode) -> assumed closed -> passes" \
  project_queue_validate_dependencies "999" "$OI" "$PI" "100"

# 10. Unsatisfied open dep (Status != Done) — fails with clear message.
PI=$(make_project_items "101:Ready:" "100:Ready:101")
OI=$(make_open_issues 100 101)
assert_fail_message "unsatisfied open dep (Status=Ready) -> fails with clear message" \
  "unsatisfied" \
  project_queue_validate_dependencies "101" "$OI" "$PI" "100"

# 11. Satisfied open dep (Status=Done) — passes.
PI=$(make_project_items "101:Done:" "100:Ready:101")
OI=$(make_open_issues 100 101)
assert_pass "satisfied open dep (Status=Done) -> passes" \
  project_queue_validate_dependencies "101" "$OI" "$PI" "100"

# 12. Three-node cycle: A->B->C->A.
PI=$(make_project_items "100:Ready:101" "101:Ready:102" "102:Ready:100")
OI=$(make_open_issues 100 101 102)
assert_fail_message "three-node cycle A->B->C->A -> fails with clear message" \
  "cycle" \
  project_queue_validate_dependencies "101" "$OI" "$PI" "100"

# 13. Multiple deps, one satisfied one not.
PI=$(make_project_items "101:Done:" "102:Ready:" "100:Ready:")
OI=$(make_open_issues 100 101 102)
assert_fail_message "mixed deps: one satisfied, one not -> fails" \
  "unsatisfied" \
  project_queue_validate_dependencies "101,102" "$OI" "$PI" "100"

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failed tests:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  exit 1
fi

exit 0
