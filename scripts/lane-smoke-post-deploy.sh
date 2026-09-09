#!/usr/bin/env bash
set -euo pipefail

# lane:smoke-post-deploy — post-deploy synthetic smoke lane
#
# Verifies critical deployed runtime paths after release or on a schedule by
# running HTTP checks against a deployed app URL.
# Requires SMOKE_URL to be set in the environment.
# Never prints the SMOKE_URL value.
#
# Checks:
#   1. Home page loads (GET / → expect HTTP 200)
#   2. Search endpoint validates its required query param (GET /api/movies/search?q= → expect HTTP 400).
#      This route is an intentionally public TMDb passthrough, not auth-gated — a 200 here just
#      means the search returned results and is not itself a regression signal.
#   3. Calendar feed resolves unknown tokens to Not Found (GET /api/calendar/smoke-test-invalid-token → expect HTTP 404)
#   4. Auth gating enforced on a protected route (GET /api/watchlist without auth → expect HTTP 401).
#      A 200 here means the deploy is serving watchlist data to unauthenticated callers.
#
# Exit 0 if all checks pass; exit 1 on first failure.

# --- Validate environment ---

if [[ -z "${SMOKE_URL:-}" ]]; then
  echo "lane:smoke-post-deploy: FAIL — SMOKE_URL is not set or is empty" >&2
  echo "Set SMOKE_URL to the deployed application URL before running this lane." >&2
  exit 1
fi

echo "lane:smoke-post-deploy: SMOKE_URL is set"

CHECKS_PASSED=0
CHECKS_FAILED=0

# --- Check 1: Home page loads ---

echo "lane:smoke-post-deploy: [1/4] checking home page ..."

RESPONSE=$(curl --silent --write-out "\n%{http_code}" \
  --max-time 15 \
  --retry 2 \
  --retry-delay 2 \
  "${SMOKE_URL}/")

HTTP_BODY=$(echo "$RESPONSE" | head -n -1)
HTTP_STATUS=$(echo "$RESPONSE" | tail -n 1)

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "lane:smoke-post-deploy: FAIL — home page returned HTTP $HTTP_STATUS (expected 200)" >&2
  echo "Response body: $HTTP_BODY" >&2
  exit 1
fi

echo "lane:smoke-post-deploy: PASS — home page returned HTTP 200"
CHECKS_PASSED=$((CHECKS_PASSED + 1))

# --- Check 2: Search endpoint validates its required query param ---

echo "lane:smoke-post-deploy: [2/4] checking search endpoint query validation ..."

RESPONSE=$(curl --silent --write-out "\n%{http_code}" \
  --max-time 15 \
  --retry 2 \
  --retry-delay 2 \
  "${SMOKE_URL}/api/movies/search?q=")

HTTP_BODY=$(echo "$RESPONSE" | head -n -1)
HTTP_STATUS=$(echo "$RESPONSE" | tail -n 1)

if [[ "$HTTP_STATUS" != "400" ]]; then
  echo "lane:smoke-post-deploy: FAIL — search endpoint returned HTTP $HTTP_STATUS (expected 400 for blank q)" >&2
  echo "Response body: $HTTP_BODY" >&2
  exit 1
fi

echo "lane:smoke-post-deploy: PASS — search endpoint returned HTTP 400 (blank q rejected)"
CHECKS_PASSED=$((CHECKS_PASSED + 1))

# --- Check 3: Calendar feed resolves unknown tokens to Not Found ---

echo "lane:smoke-post-deploy: [3/4] checking calendar endpoint token resolution ..."

RESPONSE=$(curl --silent --write-out "\n%{http_code}" \
  --max-time 15 \
  --retry 2 \
  --retry-delay 2 \
  "${SMOKE_URL}/api/calendar/smoke-test-invalid-token")

HTTP_BODY=$(echo "$RESPONSE" | head -n -1)
HTTP_STATUS=$(echo "$RESPONSE" | tail -n 1)

if [[ "$HTTP_STATUS" != "404" ]]; then
  echo "lane:smoke-post-deploy: FAIL — calendar endpoint returned HTTP $HTTP_STATUS (expected 404 for an unresolvable token)" >&2
  echo "Response body: $HTTP_BODY" >&2
  exit 1
fi

echo "lane:smoke-post-deploy: PASS — calendar endpoint returned HTTP 404 (unresolvable token)"
CHECKS_PASSED=$((CHECKS_PASSED + 1))

# --- Check 4: Auth gating enforced on a protected route ---

echo "lane:smoke-post-deploy: [4/4] checking protected route auth gate ..."

RESPONSE=$(curl --silent --write-out "\n%{http_code}" \
  --max-time 15 \
  --retry 2 \
  --retry-delay 2 \
  "${SMOKE_URL}/api/watchlist")

HTTP_BODY=$(echo "$RESPONSE" | head -n -1)
HTTP_STATUS=$(echo "$RESPONSE" | tail -n 1)

if [[ "$HTTP_STATUS" != "401" ]]; then
  echo "lane:smoke-post-deploy: FAIL — /api/watchlist returned HTTP $HTTP_STATUS (expected 401; 200 would mean the auth gate is broken)" >&2
  echo "Response body: $HTTP_BODY" >&2
  exit 1
fi

echo "lane:smoke-post-deploy: PASS — /api/watchlist returned HTTP 401 (auth gate enforced)"
CHECKS_PASSED=$((CHECKS_PASSED + 1))

# --- Summary ---

echo "lane:smoke-post-deploy: all $CHECKS_PASSED/4 checks passed"
echo "lane:smoke-post-deploy: PASS"
