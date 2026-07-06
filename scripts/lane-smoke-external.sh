#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
lane:smoke-external — external-provider smoke lane (stub)

This lane will exercise real third-party connectivity through the app/backend
boundary on a schedule or manual trigger. It is intentionally separate from the
fast deterministic PR lanes so live provider drift does not destabilize ordinary
validation.

Implementation is tracked in GitHub issue #139.
EOF

echo "lane:smoke-external: skipped (not yet implemented — see #139)"
