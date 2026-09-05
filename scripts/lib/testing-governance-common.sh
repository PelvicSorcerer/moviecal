#!/usr/bin/env bash

# Shared helpers for scripts/testing-governance-check.sh.
#
# Extracted from the retired scripts/lib/project-queue-common.sh (removed as
# part of the Linear dev-governance migration -- see
# docs/planning/decision-log.md Stage 11) because this specific check is
# app-level testing-policy governance, not agent-dispatch queue mechanics,
# and remains genuinely useful on its own.

testing_governance_require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "jq is not installed. Install jq before running the testing governance check." >&2
    return 1
  fi
}

testing_governance_validate() {
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
