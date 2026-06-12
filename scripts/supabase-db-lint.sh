#!/usr/bin/env bash
set -euo pipefail

supabase_home="${TMPDIR:-/tmp}/moviecal-supabase-home"
local_db_host="${SUPABASE_LOCAL_DB_HOST:-127.0.0.1}"
local_db_port="${SUPABASE_LOCAL_DB_PORT:-54322}"

if [ -x ".codex/tools/bin/supabase" ]; then
  supabase_binary=".codex/tools/bin/supabase"
elif command -v supabase >/dev/null 2>&1; then
  supabase_binary="$(command -v supabase)"
else
  echo "Supabase CLI is not installed. Run 'npm run tool:install' for the repo-local binary or provide 'supabase' on PATH." >&2
  exit 1
fi

mkdir -p "$supabase_home"

if [ -n "${SUPABASE_DB_URL:-}" ]; then
  echo "Running 'supabase db lint' against SUPABASE_DB_URL."
  HOME="$supabase_home" "$supabase_binary" db lint --db-url "$SUPABASE_DB_URL"
  exit 0
fi

if ! command -v nc >/dev/null 2>&1; then
  echo "nc is required to probe the local Supabase Postgres port before running 'supabase db lint --local'." >&2
  echo "Use a disposable database via SUPABASE_DB_URL or run the command on a machine with a reachable local Supabase stack." >&2
  exit 1
fi

if ! nc -z "$local_db_host" "$local_db_port" >/dev/null 2>&1; then
  echo "No reachable local Supabase/Postgres instance was found at ${local_db_host}:${local_db_port}." >&2
  echo "In this Codex environment, 'supabase db lint --local' can fail because Docker is unavailable and sandboxed localhost access may be blocked." >&2
  echo "Use a disposable database via SUPABASE_DB_URL or run the local lint on a machine where the Supabase local stack is reachable." >&2
  exit 1
fi

echo "Running 'supabase db lint --local' against ${local_db_host}:${local_db_port}."
HOME="$supabase_home" "$supabase_binary" db lint --local
