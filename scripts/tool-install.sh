#!/usr/bin/env bash
set -euo pipefail

# Cross-platform installer for the repo-local Supabase and Vercel CLIs.
# Supported combinations mirror the platforms known to run agents against this
# repo (Codex Desktop on macOS, Codex/Cursor/Copilot workers on Linux). Windows
# is not supported by this script; install the tools separately there.

tools_dir=".codex/tools"
bin_dir="$tools_dir/bin"
supabase_version="2.105.0"

os_name="$(uname -s)"
arch_name="$(uname -m)"

case "$os_name" in
  Darwin) supabase_os="darwin" ;;
  Linux) supabase_os="linux" ;;
  *)
    echo "Unsupported OS '$os_name' for the repo-local Supabase/Vercel install path." >&2
    echo "Install Supabase and Vercel separately on this machine, or extend scripts/tool-install.sh for your platform." >&2
    exit 1
    ;;
esac

case "$arch_name" in
  arm64|aarch64) supabase_arch="arm64" ;;
  x86_64|amd64) supabase_arch="amd64" ;;
  *)
    echo "Unsupported architecture '$arch_name' for the repo-local Supabase/Vercel install path." >&2
    echo "Install Supabase and Vercel separately on this machine, or extend scripts/tool-install.sh for your platform." >&2
    exit 1
    ;;
esac

supabase_archive="supabase_${supabase_version}_${supabase_os}_${supabase_arch}.tar.gz"
supabase_url="https://github.com/supabase/cli/releases/download/v${supabase_version}/${supabase_archive}"

mkdir -p "$bin_dir"

echo "Installing workspace-local Vercel CLI..."
npm install --prefix "$tools_dir" vercel

echo "Installing workspace-local Supabase CLI (${supabase_os}/${supabase_arch})..."
tmp_archive="$(mktemp /tmp/supabase.XXXXXX.tar.gz)"
curl -L "$supabase_url" -o "$tmp_archive"
tar -xzf "$tmp_archive" -C "$bin_dir"
rm -f "$tmp_archive"

if [ "$os_name" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  # macOS Gatekeeper can refuse to run an unsigned binary downloaded outside the App Store;
  # this ad-hoc re-sign is a no-op on Linux and is skipped there.
  codesign --force --sign - "$bin_dir/supabase" >/dev/null 2>&1 || true
fi

echo "Tool install complete. Run 'npm run tool:check' to verify."
