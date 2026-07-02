#!/usr/bin/env bash
set -euo pipefail

vercel_cli="node .codex/tools/node_modules/vercel/dist/vc.js"
supabase_binary=".codex/tools/bin/supabase"
supabase_home="${TMPDIR:-/tmp}/moviecal-supabase-home"

if [ ! -f .codex/tools/node_modules/vercel/dist/vc.js ]; then
  echo "Vercel CLI is not installed in .codex/tools. Run 'npm run tool:install' first." >&2
  exit 1
fi

if [ ! -f "$supabase_binary" ]; then
  echo "Supabase CLI binary is not installed in .codex/tools/bin. Run 'npm run tool:install' first." >&2
  exit 1
fi

echo "Vercel CLI:"
$vercel_cli --version

echo "Supabase CLI:"
mkdir -p "$supabase_home"
if ! HOME="$supabase_home" "$supabase_binary" --version; then
  echo "Supabase CLI is installed but not runnable in this environment. Re-run 'npm run tool:install', or on macOS re-sign the binary locally (codesign --force --sign - .codex/tools/bin/supabase)." >&2
  exit 1
fi

echo "Supabase db lint wrapper:"
echo "- Run 'npm run db:lint' to execute 'supabase db lint'."
echo "- Without SUPABASE_DB_URL, the wrapper expects a reachable local Supabase/Postgres instance on 127.0.0.1:54322."
