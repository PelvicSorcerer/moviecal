#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  orchestrator-worker-worktree.sh provision \
    --repo-root <abs-path> \
    --repo-name <name> \
    --branch <branch-name> \
    --worker-key <issue-or-task-key> \
    [--environment-profile <profile-name-or-abs-path>] \
    [--base <git-ref>]

  orchestrator-worker-worktree.sh cleanup \
    --repo-root <abs-path> \
    --path <abs-worktree-path> \
    --branch <branch-name> \
    --result <merged|abandoned|failure>

  orchestrator-worker-worktree.sh startup-gate \
    --expected-path <abs-worktree-path> \
    --expected-branch <branch-name> \
    --actual-pwd <abs-path> \
    --actual-top <abs-path> \
    --actual-branch <branch-name>

  orchestrator-worker-worktree.sh review-gate \
    --expected-path <abs-worktree-path> \
    --expected-branch <branch-name> \
    --review-ready <1|0> \
    --modified-files <json-array> \
    --local-test-status <PASS|FAIL|UNSUPPORTED> \
    --git-status-clean <1|0> \
    --latest-commit-hash <sha>

  orchestrator-worker-worktree.sh publish-gate \
    --expected-path <abs-worktree-path> \
    --expected-branch <branch-name> \
    --publish-complete <1|0> \
    --remote-push-status <SUCCESS|FAILED> \
    --remote-branch-url <url-or-ref> \
    --pr-number <number-or-empty> \
    --pr-url <url-or-empty> \
    --latest-commit-hash <sha>

Commands:
  provision
    Pre-create a stable worker worktree under:
      $HOME/.codex/worktrees/workers/<repo-name>/<worker-key>
    and attach the requested branch from the requested base ref.
    Then resolve the selected Codex environment profile from the main repo root
    and execute its native
    setup script inside the fresh worktree before worker dispatch.

  cleanup
    On merged/abandoned: remove the worker worktree immediately, then delete
    the local branch.
    On failure: preserve the worktree for debugging and print that it was preserved.

  startup-gate
    Fail closed unless the worker-reported runtime path and branch exactly match
    the orchestrator-assigned worktree path and branch.

  review-gate
    Fail closed unless the worker review checkpoint is syntactically valid and
    consistent with the assigned worktree and current local git state.

  publish-gate
    Fail closed unless the worker publish checkpoint is syntactically valid and
    consistent with the assigned worktree and current local git state.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_abs_path() {
  case "$1" in
    /*) ;;
    *) die "expected absolute path, got: $1" ;;
  esac
}

resolve_environment_profile() {
  [[ -n "$repo_root" ]] || die "--repo-root is required before resolving environment profile"

  local profile_input="$1"
  local default_profile="$repo_root/.codex/environments/environment.toml"

  if [[ -z "$profile_input" ]]; then
    [[ -f "$default_profile" ]] || die "default environment profile not found: $default_profile"
    printf '%s\n' "$default_profile"
    return 0
  fi

  case "$profile_input" in
    /*)
      [[ -f "$profile_input" ]] || die "environment profile not found: $profile_input"
      printf '%s\n' "$profile_input"
      return 0
      ;;
  esac

  local env_dir="$repo_root/.codex/environments"
  [[ -d "$env_dir" ]] || die "environment directory not found: $env_dir"

  local matches=()
  local path=""
  local filename=""
  local stem=""
  local profile_name=""

  while IFS= read -r -d '' path; do
    filename="$(basename "$path")"
    stem="${filename%.toml}"
    profile_name="$(
      sed -n 's/^name = "\(.*\)"$/\1/p' "$path" | head -n 1
    )"

    if [[ "$profile_input" == "$filename" || "$profile_input" == "$stem" || "$profile_input" == "$profile_name" ]]; then
      matches+=("$path")
    fi
  done < <(find "$env_dir" -maxdepth 1 -type f -name '*.toml' -print0 | sort -z)

  if [[ "${#matches[@]}" -eq 0 ]]; then
    die "no environment profile named '$profile_input' found under $env_dir"
  fi

  if [[ "${#matches[@]}" -gt 1 ]]; then
    die "profile name '$profile_input' is ambiguous; matches: ${matches[*]}"
  fi

  printf '%s\n' "${matches[0]}"
}

extract_setup_script() {
  local profile_path="$1"
  [[ -f "$profile_path" ]] || die "environment profile not found: $profile_path"

  awk '
    BEGIN { in_setup = 0; in_script = 0 }
    /^\[setup\]/ { in_setup = 1; next }
    /^\[/ && $0 !~ /^\[setup\]/ && in_script == 0 { in_setup = 0 }
    in_setup && /^script = '\'''\'''\''$/ { in_script = 1; next }
    in_script && /^'\'''\'''\''$/ { exit }
    in_script { print }
  ' "$profile_path"
}

command_name="${1:-}"
if [[ -z "$command_name" ]]; then
  usage
  exit 1
fi

case "$command_name" in
  -h|--help)
    usage
    exit 0
    ;;
esac

shift || true

repo_root=""
repo_name=""
branch_name=""
worker_key=""
base_ref="origin/master"
environment_profile=""
worktree_path=""
cleanup_result=""
expected_path=""
expected_branch=""
actual_pwd=""
actual_top=""
actual_branch=""
review_ready=""
modified_files=""
local_test_status=""
git_status_clean=""
latest_commit_hash=""
publish_complete=""
remote_push_status=""
remote_branch_url=""
pr_number=""
pr_url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      repo_root="${2:-}"
      shift 2
      ;;
    --repo-name)
      repo_name="${2:-}"
      shift 2
      ;;
    --branch)
      branch_name="${2:-}"
      shift 2
      ;;
    --worker-key)
      worker_key="${2:-}"
      shift 2
      ;;
    --base)
      base_ref="${2:-}"
      shift 2
      ;;
    --environment-profile)
      environment_profile="${2:-}"
      shift 2
      ;;
    --path)
      worktree_path="${2:-}"
      shift 2
      ;;
    --result)
      cleanup_result="${2:-}"
      shift 2
      ;;
    --expected-path)
      expected_path="${2:-}"
      shift 2
      ;;
    --expected-branch)
      expected_branch="${2:-}"
      shift 2
      ;;
    --actual-pwd)
      actual_pwd="${2:-}"
      shift 2
      ;;
    --actual-top)
      actual_top="${2:-}"
      shift 2
      ;;
    --actual-branch)
      actual_branch="${2:-}"
      shift 2
      ;;
    --review-ready)
      review_ready="${2:-}"
      shift 2
      ;;
    --modified-files)
      modified_files="${2:-}"
      shift 2
      ;;
    --local-test-status)
      local_test_status="${2:-}"
      shift 2
      ;;
    --git-status-clean)
      git_status_clean="${2:-}"
      shift 2
      ;;
    --latest-commit-hash)
      latest_commit_hash="${2:-}"
      shift 2
      ;;
    --publish-complete)
      publish_complete="${2:-}"
      shift 2
      ;;
    --remote-push-status)
      remote_push_status="${2:-}"
      shift 2
      ;;
    --remote-branch-url)
      remote_branch_url="${2:-}"
      shift 2
      ;;
    --pr-number)
      pr_number="${2:-}"
      shift 2
      ;;
    --pr-url)
      pr_url="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

provision() {
  [[ -n "$repo_root" ]] || die "--repo-root is required"
  [[ -n "$repo_name" ]] || die "--repo-name is required"
  [[ -n "$branch_name" ]] || die "--branch is required"
  [[ -n "$worker_key" ]] || die "--worker-key is required"
  require_abs_path "$repo_root"
  environment_profile="$(resolve_environment_profile "$environment_profile")"
  require_abs_path "$environment_profile"

  local worker_root="$HOME/.codex/worktrees/workers/$repo_name"
  local target_path="$worker_root/$worker_key"
  local setup_script=""

  mkdir -p "$worker_root"

  if [[ -e "$target_path" ]]; then
    die "target worktree path already exists: $target_path"
  fi

  git -C "$repo_root" rev-parse --verify "$base_ref" >/dev/null 2>&1 \
    || die "base ref does not exist: $base_ref"

  if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch_name"; then
    die "local branch already exists: $branch_name"
  fi

  git -C "$repo_root" worktree add "$target_path" -b "$branch_name" "$base_ref"

  if [[ -f "$environment_profile" ]]; then
    setup_script="$(extract_setup_script "$environment_profile")"
  fi

  if [[ -n "$setup_script" ]]; then
    (
      cd "$target_path"
      export CODEX_ENV_SOURCE_ROOT="$repo_root"
      export CODEX_ENV_PROFILE_PATH="$environment_profile"
      export CODEX_WORKER_WORKTREE_PATH="$target_path"
      export CODEX_WORKER_BRANCH_NAME="$branch_name"
      bash -lc "$setup_script"
    )
  fi

  cat <<EOF
PROVISION_OK=1
REPO_ROOT=$repo_root
REPO_NAME=$repo_name
BASE_REF=$base_ref
ENVIRONMENT_PROFILE=$environment_profile
BRANCH_NAME=$branch_name
WORKER_KEY=$worker_key
WORKTREE_PATH=$target_path
SETUP_RAN=$([[ -n "$setup_script" ]] && echo 1 || echo 0)
EOF
}

cleanup() {
  [[ -n "$repo_root" ]] || die "--repo-root is required"
  [[ -n "$worktree_path" ]] || die "--path is required"
  [[ -n "$branch_name" ]] || die "--branch is required"
  [[ -n "$cleanup_result" ]] || die "--result is required"
  require_abs_path "$repo_root"
  require_abs_path "$worktree_path"

  case "$cleanup_result" in
    merged|abandoned)
      if [[ -d "$worktree_path" ]]; then
        git -C "$repo_root" worktree remove --force "$worktree_path"
      fi

      if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch_name"; then
        git -C "$repo_root" branch -D "$branch_name"
      fi

      cat <<EOF
CLEANUP_OK=1
RESULT=$cleanup_result
WORKTREE_PATH=$worktree_path
BRANCH_NAME=$branch_name
ACTION=removed_and_branch_deleted
EOF
      ;;
    failure)
      cat <<EOF
CLEANUP_OK=1
RESULT=failure
WORKTREE_PATH=$worktree_path
BRANCH_NAME=$branch_name
ACTION=preserved
EOF
      ;;
    *)
      die "--result must be merged, abandoned, or failure"
      ;;
  esac
}

startup_gate() {
  [[ -n "$expected_path" ]] || die "--expected-path is required"
  [[ -n "$expected_branch" ]] || die "--expected-branch is required"
  [[ -n "$actual_pwd" ]] || die "--actual-pwd is required"
  [[ -n "$actual_top" ]] || die "--actual-top is required"
  [[ -n "$actual_branch" ]] || die "--actual-branch is required"
  require_abs_path "$expected_path"
  require_abs_path "$actual_pwd"
  require_abs_path "$actual_top"

  local ok=1

  if [[ "$actual_pwd" != "$expected_path" ]]; then
    ok=0
    echo "STARTUP_GATE_ERROR=pwd_mismatch" >&2
  fi

  if [[ "$actual_top" != "$expected_path" ]]; then
    ok=0
    echo "STARTUP_GATE_ERROR=git_top_mismatch" >&2
  fi

  if [[ "$actual_branch" != "$expected_branch" ]]; then
    ok=0
    echo "STARTUP_GATE_ERROR=branch_mismatch" >&2
  fi

  if [[ "$ok" -ne 1 ]]; then
    cat >&2 <<EOF
EXPECTED_PATH=$expected_path
EXPECTED_BRANCH=$expected_branch
ACTUAL_PWD=$actual_pwd
ACTUAL_TOP=$actual_top
ACTUAL_BRANCH=$actual_branch
EOF
    exit 2
  fi

  cat <<EOF
STARTUP_GATE_OK=1
EXPECTED_PATH=$expected_path
EXPECTED_BRANCH=$expected_branch
ACTUAL_PWD=$actual_pwd
ACTUAL_TOP=$actual_top
ACTUAL_BRANCH=$actual_branch
EOF
}

review_gate() {
  [[ -n "$expected_path" ]] || die "--expected-path is required"
  [[ -n "$expected_branch" ]] || die "--expected-branch is required"
  [[ -n "$review_ready" ]] || die "--review-ready is required"
  [[ -n "$modified_files" ]] || die "--modified-files is required"
  [[ -n "$local_test_status" ]] || die "--local-test-status is required"
  [[ -n "$git_status_clean" ]] || die "--git-status-clean is required"
  [[ -n "$latest_commit_hash" ]] || die "--latest-commit-hash is required"
  require_abs_path "$expected_path"

  local actual_branch_now=""
  local actual_head_now=""

  actual_branch_now="$(git -C "$expected_path" branch --show-current)"
  actual_head_now="$(git -C "$expected_path" rev-parse HEAD)"

  [[ "$expected_branch" == "$actual_branch_now" ]] || {
    echo "ERROR_KEY=BRANCH_MISMATCH" >&2
    exit 3
  }

  [[ "$review_ready" == "1" ]] || {
    echo "ERROR_KEY=REVIEW_NOT_READY" >&2
    exit 3
  }

  case "$local_test_status" in
    PASS|FAIL|UNSUPPORTED) ;;
    *)
      echo "ERROR_KEY=INVALID_LOCAL_TEST_STATUS" >&2
      exit 3
      ;;
  esac

  [[ "$git_status_clean" == "1" ]] || {
    echo "ERROR_KEY=GIT_STATUS_DIRTY" >&2
    exit 3
  }

  [[ "$latest_commit_hash" == "$actual_head_now" ]] || {
    echo "ERROR_KEY=HEAD_SHA_MISMATCH" >&2
    exit 3
  }

  python3 - "$expected_path" "$modified_files" "$latest_commit_hash" <<'PY'
import json, re, subprocess, sys

expected_path = sys.argv[1]
modified_files_raw = sys.argv[2]
latest_commit_hash = sys.argv[3]

if not re.fullmatch(r"[0-9a-fA-F]{7,40}", latest_commit_hash):
    print("ERROR_KEY=INVALID_COMMIT_HASH", file=sys.stderr)
    raise SystemExit(4)

try:
    modified_files = json.loads(modified_files_raw)
except Exception:
    print("ERROR_KEY=MODIFIED_FILES_NOT_JSON", file=sys.stderr)
    raise SystemExit(4)

if not isinstance(modified_files, list):
    print("ERROR_KEY=MODIFIED_FILES_NOT_LIST", file=sys.stderr)
    raise SystemExit(4)

for path in modified_files:
    if not isinstance(path, str):
        print("ERROR_KEY=MODIFIED_FILES_NON_STRING", file=sys.stderr)
        raise SystemExit(4)
    if not path.startswith("/"):
        print("ERROR_KEY=MODIFIED_FILES_NOT_ABSOLUTE", file=sys.stderr)
        raise SystemExit(4)
    if not path.startswith(expected_path.rstrip("/") + "/"):
        print("ERROR_KEY=MODIFIED_FILES_OUTSIDE_WORKTREE", file=sys.stderr)
        raise SystemExit(4)

status = subprocess.run(
    ["git", "-C", expected_path, "status", "--short"],
    check=True,
    capture_output=True,
    text=True,
)
if status.stdout.strip():
    print("ERROR_KEY=WORKTREE_NOT_CLEAN", file=sys.stderr)
    raise SystemExit(4)
PY

  cat <<EOF
REVIEW_GATE_OK=1
EXPECTED_PATH=$expected_path
EXPECTED_BRANCH=$expected_branch
LATEST_COMMIT_HASH=$latest_commit_hash
EOF
}

publish_gate() {
  [[ -n "$expected_path" ]] || die "--expected-path is required"
  [[ -n "$expected_branch" ]] || die "--expected-branch is required"
  [[ -n "$publish_complete" ]] || die "--publish-complete is required"
  [[ -n "$remote_push_status" ]] || die "--remote-push-status is required"
  [[ -n "$remote_branch_url" ]] || die "--remote-branch-url is required"
  [[ -n "$latest_commit_hash" ]] || die "--latest-commit-hash is required"
  require_abs_path "$expected_path"

  local actual_branch_now=""
  local actual_head_now=""

  actual_branch_now="$(git -C "$expected_path" branch --show-current)"
  actual_head_now="$(git -C "$expected_path" rev-parse HEAD)"

  [[ "$expected_branch" == "$actual_branch_now" ]] || {
    echo "ERROR_KEY=BRANCH_MISMATCH" >&2
    exit 5
  }

  [[ "$publish_complete" == "1" ]] || {
    echo "ERROR_KEY=PUBLISH_NOT_COMPLETE" >&2
    exit 5
  }

  [[ "$remote_push_status" == "SUCCESS" ]] || {
    echo "ERROR_KEY=REMOTE_PUSH_FAILED" >&2
    exit 5
  }

  [[ "$latest_commit_hash" == "$actual_head_now" ]] || {
    echo "ERROR_KEY=HEAD_SHA_MISMATCH" >&2
    exit 5
  }

  python3 - "$remote_branch_url" "$pr_number" "$pr_url" "$latest_commit_hash" <<'PY'
import re, sys

remote_branch_url = sys.argv[1]
pr_number = sys.argv[2]
pr_url = sys.argv[3]
latest_commit_hash = sys.argv[4]

if not re.fullmatch(r"[0-9a-fA-F]{7,40}", latest_commit_hash):
    print("ERROR_KEY=INVALID_COMMIT_HASH", file=sys.stderr)
    raise SystemExit(6)

branch_ok = (
    remote_branch_url.startswith("origin/")
    or remote_branch_url.startswith("https://github.com/")
)
if not branch_ok:
    print("ERROR_KEY=INVALID_REMOTE_BRANCH_URL", file=sys.stderr)
    raise SystemExit(6)

if pr_number:
    if not re.fullmatch(r"[0-9]+", pr_number):
        print("ERROR_KEY=INVALID_PR_NUMBER", file=sys.stderr)
        raise SystemExit(6)

if pr_url:
    if not re.fullmatch(r"https://github\.com/[^/]+/[^/]+/pull/[0-9]+", pr_url):
        print("ERROR_KEY=INVALID_PR_URL", file=sys.stderr)
        raise SystemExit(6)
PY

  cat <<EOF
PUBLISH_GATE_OK=1
EXPECTED_PATH=$expected_path
EXPECTED_BRANCH=$expected_branch
LATEST_COMMIT_HASH=$latest_commit_hash
REMOTE_BRANCH_URL=$remote_branch_url
PR_NUMBER=$pr_number
PR_URL=$pr_url
EOF
}

case "$command_name" in
  provision)
    provision
    ;;
  cleanup)
    cleanup
    ;;
  startup-gate)
    startup_gate
    ;;
  review-gate)
    review_gate
    ;;
  publish-gate)
    publish_gate
    ;;
  *)
    die "unknown command: $command_name"
    ;;
esac
