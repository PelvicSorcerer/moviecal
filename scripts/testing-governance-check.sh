#!/usr/bin/env bash
set -euo pipefail

# testing-governance-check.sh
#
# Validates that the repo's testing governance artifacts are consistent:
#   1. Referenced testing-policy docs exist on disk.
#   2. Required testing sections are present in governance surfaces
#      (PR template, agent task issue template, AGENTS.md).
#   3. Lane commands documented in testing-lanes.md exist in package.json.
#   4. CI workflow files referenced in testing-lanes.md exist.
#
# Run via: npm run check:testing-governance
# Or directly: bash scripts/testing-governance-check.sh

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=lib/project-queue-common.sh
source "$repo_root/scripts/lib/project-queue-common.sh"

project_queue_require_jq

echo "Repository root: $repo_root"
echo "Running testing governance consistency checks..."
echo ""

project_queue_validate_testing_governance "$repo_root"
