#!/usr/bin/env bash
set -euo pipefail

repo_root="$(pwd)"
env_file="$repo_root/.env.local"
example_file="$repo_root/.env.example"
package_file="$repo_root/package.json"

trim_quotes() {
  local value="${1:-}"
  value="${value%\"}"
  value="${value#\"}"
  printf '%s\n' "$value"
}

read_env_value() {
  local key="$1"
  local file="$2"

  [[ -f "$file" ]] || return 1

  local line=""
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  trim_quotes "${line#*=}"
}

is_ready_value() {
  local value="${1:-}"
  shift

  [[ -n "$value" ]] || return 1

  local placeholder=""
  for placeholder in "$@"; do
    if [[ "$value" == "$placeholder" ]]; then
      return 1
    fi
  done

  return 0
}

env_local_present=0
env_example_present=0
node_present=0
npm_present=0
package_json_present=0
node_modules_present=0
playwright_package_present=0
playwright_cli_present=0
supabase_public_ready=0
supabase_service_ready=0
tmdb_ready=0
cron_ready=0
auth_dev_ready=0
tmdb_dev_ready=0
cron_dev_ready=0
next_port_bind_sandbox_risk=1

[[ -f "$env_file" ]] && env_local_present=1
[[ -f "$example_file" ]] && env_example_present=1
[[ -f "$package_file" ]] && package_json_present=1
command -v node >/dev/null 2>&1 && node_present=1
command -v npm >/dev/null 2>&1 && npm_present=1
[[ -d "$repo_root/node_modules" ]] && node_modules_present=1
[[ -f "$repo_root/node_modules/@playwright/test/package.json" ]] && playwright_package_present=1

if [[ "$npm_present" -eq 1 ]] && npx playwright --version >/dev/null 2>&1; then
  playwright_cli_present=1
fi

supabase_url="$(read_env_value "NEXT_PUBLIC_SUPABASE_URL" "$env_file" || true)"
supabase_anon="$(read_env_value "NEXT_PUBLIC_SUPABASE_ANON_KEY" "$env_file" || true)"
supabase_service="$(read_env_value "SUPABASE_SERVICE_ROLE_KEY" "$env_file" || true)"
tmdb_api_key="$(read_env_value "TMDB_API_KEY" "$env_file" || true)"
cron_secret="$(read_env_value "CRON_SECRET" "$env_file" || true)"

if is_ready_value "$supabase_url" "https://your-project-ref.supabase.co"; then
  if is_ready_value "$supabase_anon" "your-supabase-anon-key"; then
    supabase_public_ready=1
  fi
fi

if is_ready_value "$supabase_service" "your-supabase-service-role-key"; then
  supabase_service_ready=1
fi

if is_ready_value "$tmdb_api_key" "your-tmdb-api-key"; then
  tmdb_ready=1
fi

if is_ready_value "$cron_secret" "replace-with-a-long-random-secret"; then
  cron_ready=1
fi

if [[ "$supabase_public_ready" -eq 1 && "$supabase_service_ready" -eq 1 ]]; then
  auth_dev_ready=1
fi

if [[ "$tmdb_ready" -eq 1 ]]; then
  tmdb_dev_ready=1
fi

if [[ "$cron_ready" -eq 1 ]]; then
  cron_dev_ready=1
fi

cat <<EOF
ENV_CHECK_OK=1
REPO_ROOT=$repo_root
ENV_LOCAL_PRESENT=$env_local_present
ENV_EXAMPLE_PRESENT=$env_example_present
PACKAGE_JSON_PRESENT=$package_json_present
NODE_PRESENT=$node_present
NPM_PRESENT=$npm_present
NODE_MODULES_PRESENT=$node_modules_present
PLAYWRIGHT_PACKAGE_PRESENT=$playwright_package_present
PLAYWRIGHT_CLI_PRESENT=$playwright_cli_present
SUPABASE_PUBLIC_READY=$supabase_public_ready
SUPABASE_SERVICE_READY=$supabase_service_ready
AUTH_DEV_READY=$auth_dev_ready
TMDB_READY=$tmdb_ready
TMDB_DEV_READY=$tmdb_dev_ready
CRON_READY=$cron_ready
CRON_DEV_READY=$cron_dev_ready
NEXT_PORT_BIND_SANDBOX_RISK=$next_port_bind_sandbox_risk
EOF

if [[ "$env_local_present" -ne 1 ]]; then
  echo "ENV_WARNING=.env.local is missing; bootstrap may need to copy from .env.example." >&2
fi

if [[ "$auth_dev_ready" -ne 1 ]]; then
  echo "ENV_WARNING=Supabase auth/watchlist flows still need non-placeholder disposable credentials." >&2
fi

if [[ "$tmdb_dev_ready" -ne 1 ]]; then
  echo "ENV_WARNING=TMDb-backed flows still need a non-placeholder TMDB_API_KEY." >&2
fi

if [[ "$cron_dev_ready" -ne 1 ]]; then
  echo "ENV_WARNING=Cron-protected flows still need a non-placeholder CRON_SECRET." >&2
fi

if [[ "$playwright_cli_present" -ne 1 ]]; then
  echo "ENV_WARNING=Playwright CLI is not currently available in this worktree bootstrap." >&2
fi

echo "ENV_NOTE=Local build/verify can still require unsandboxed execution because Next/Turbopack may need local port binding." >&2
