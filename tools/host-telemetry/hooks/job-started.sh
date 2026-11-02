#!/bin/bash
# Thin launcher for job-started.mjs: the runner starts hooks with a minimal PATH.
here="$(cd "$(dirname "$0")" && pwd)"
for node in "${MOVIECAL_NODE:-}" "$(command -v node)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$node" ] && [ -x "$node" ]; then
    "$node" "$here/job-started.mjs" || true
    break
  fi
done
exit 0
