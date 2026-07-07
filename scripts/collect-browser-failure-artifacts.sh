#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

output_dir="${PLAYWRIGHT_OUTPUT_DIR:-test-results/playwright}"
summary_path="$output_dir/failure-summary.json"

if [[ ! -d "$output_dir" ]]; then
  echo "No Playwright output directory at $output_dir."
  echo "Run a browser lane first (for example: npm run lane:browser)."
  exit 1
fi

echo "Playwright failure artifacts under $output_dir:"
find "$output_dir" -type f \( \
  -name '*.png' -o \
  -name '*.webm' -o \
  -name '*.zip' -o \
  -name 'failure-summary.json' \
\) | sort || true

if [[ -f "$summary_path" ]]; then
  echo
  echo "Failure summary:"
  cat "$summary_path"
else
  echo
  echo "No failure-summary.json present. The last browser run likely passed."
fi
