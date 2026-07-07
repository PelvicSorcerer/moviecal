#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
lane:browser:quarantine — non-blocking quarantined browser specs

Runs only tests tagged @quarantine or listed in e2e/quarantine.json.
Failures in this lane do not block pull requests; they surface unstable
coverage while a linked follow-up issue tracks remediation.

See docs/planning/browser-runtime-test-stability.md for quarantine policy.
EOF

export PLAYWRIGHT_QUARANTINE_MODE=quarantine-only
npm run lane:browser
