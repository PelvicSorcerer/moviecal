#!/usr/bin/env bash
set -euo pipefail

# check-surface-drift.sh
#
# Verifies that every product API route is covered in the testing-strategy doc
# or has at least one test file that references the route segment.
#
# A route "segment" is the first path component directly under src/app/api/.
# For example:
#   src/app/api/calendar/[token]/route.ts  → segment: calendar
#   src/app/api/cron/refresh-releases/route.ts → segment: cron
#   src/app/api/movies/search/route.ts     → segment: movies
#   src/app/api/watchlist/route.ts         → segment: watchlist
#
# A segment passes if EITHER:
#   1. It appears in docs/planning/repository-testing-strategy.md, OR
#   2. At least one test file under test/, src/, or __tests__/ contains the
#      segment string (as a word boundary or path component).
#
# Usage:
#   bash scripts/check-surface-drift.sh
#   npm run check:surface-drift

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

api_dir="$repo_root/src/app/api"
testing_strategy_doc="$repo_root/docs/planning/repository-testing-strategy.md"

echo "Repository root: $repo_root"
echo "Checking surface drift: API routes vs. testing coverage..."
echo ""

# Verify the API directory and strategy doc exist.
if [ ! -d "$api_dir" ]; then
  echo "ERROR: API directory not found: $api_dir" >&2
  exit 1
fi

if [ ! -f "$testing_strategy_doc" ]; then
  echo "ERROR: Testing strategy doc not found: $testing_strategy_doc" >&2
  exit 1
fi

# Collect unique route segments by enumerating route.ts files.
declare -a segments=()
declare -A seen_segments=()

while IFS= read -r route_file; do
  # Strip the api_dir prefix to get the relative path: e.g. calendar/[token]/route.ts
  relative="${route_file#"$api_dir/"}"
  # The segment is the first path component.
  segment="${relative%%/*}"
  if [ -z "${seen_segments[$segment]:-}" ]; then
    seen_segments[$segment]=1
    segments+=("$segment")
  fi
done < <(find "$api_dir" -name "route.ts" | sort)

if [ ${#segments[@]} -eq 0 ]; then
  echo "No route.ts files found under $api_dir — nothing to check."
  exit 0
fi

echo "Discovered route segments (${#segments[@]} total):"
for seg in "${segments[@]}"; do
  echo "  - $seg"
done
echo ""

# Test search directories (relative to repo root).
test_search_dirs=()
for candidate in "$repo_root/test" "$repo_root/__tests__" "$repo_root/src"; do
  if [ -d "$candidate" ]; then
    test_search_dirs+=("$candidate")
  fi
done

failed_segments=()

for segment in "${segments[@]}"; do
  covered=0

  # Check 1: segment appears in the testing-strategy doc.
  if grep -qF "$segment" "$testing_strategy_doc"; then
    covered=1
  fi

  # Check 2: at least one test file references this segment.
  if [ "$covered" -eq 0 ] && [ ${#test_search_dirs[@]} -gt 0 ]; then
    if grep -rqF "$segment" \
        --include="*.test.ts" \
        --include="*.test.tsx" \
        --include="*.spec.ts" \
        --include="*.spec.tsx" \
        "${test_search_dirs[@]}"; then
      covered=1
    fi
  fi

  if [ "$covered" -eq 1 ]; then
    echo "  PASS  $segment"
  else
    echo "  FAIL  $segment — not found in testing-strategy doc and no test file references it" >&2
    failed_segments+=("$segment")
  fi
done

echo ""

if [ ${#failed_segments[@]} -gt 0 ]; then
  echo "Surface drift detected: ${#failed_segments[@]} route segment(s) lack testing coverage documentation:" >&2
  for seg in "${failed_segments[@]}"; do
    echo "  - $seg" >&2
    echo "    Fix: add '$seg' to docs/planning/repository-testing-strategy.md" >&2
    echo "    OR add a test file under test/, src/, or __tests__/ that references '$seg'." >&2
  done
  echo "" >&2
  echo "Run 'npm run check:surface-drift' after making corrections." >&2
  exit 1
fi

echo "All ${#segments[@]} route segment(s) are covered. No surface drift detected."
exit 0
