#!/usr/bin/env bash
set -euo pipefail

vercel_cli="node .codex/tools/node_modules/vercel/dist/vc.js"
supabase_binary=".codex/tools/bin/supabase"

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
if ! "$supabase_binary" --version; then
  echo "Supabase CLI is installed but not runnable in this environment. Re-run 'npm run tool:install' or re-sign the binary locally on this Apple Silicon macOS machine." >&2
  exit 1
fi
