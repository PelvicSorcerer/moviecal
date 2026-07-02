#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=lib/project-queue-common.sh
source "$repo_root/scripts/lib/project-queue-common.sh"

mode="${PROJECT_QUEUE_MODE:-pre-cutover}"
project_items_fixture="${PROJECT_QUEUE_ITEMS_JSON:-}"
open_issues_fixture="${PROJECT_QUEUE_OPEN_ISSUES_JSON:-}"

project_queue_require_jq

case "$mode" in
  pre-cutover|post-cutover) ;;
  *)
    echo "Unsupported PROJECT_QUEUE_MODE: $mode" >&2
    echo "Supported modes: pre-cutover, post-cutover" >&2
    exit 1
    ;;
esac

if [ -n "$project_items_fixture" ] || [ -n "$open_issues_fixture" ]; then
  project_queue_load_fixture_state
  project_queue_print_context "$mode" "yes"
else
  project_queue_load_live_state
  project_queue_print_context "$mode" "no"
fi

case "$mode" in
  pre-cutover)
    project_queue_validate_pre_cutover
    ;;
  post-cutover)
    project_queue_validate_post_cutover
    ;;
esac
