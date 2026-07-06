#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
lane:smoke-post-deploy — post-deploy synthetic smoke lane (stub)

This lane will verify critical deployed runtime paths after release or on a
schedule. It is intentionally separate from PR validation because some failures
only appear after deployment, environment wiring, or hosting changes.

Implementation is tracked in GitHub issue #140.
EOF

echo "lane:smoke-post-deploy: skipped (not yet implemented — see #140)"
