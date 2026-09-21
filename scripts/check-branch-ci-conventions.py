#!/usr/bin/env python3
"""Cross-check docs/operators/branch-prefixes.json against workflow triggers.

Two independent checks, both wired up as `npm run check:branch-ci`:

1. Static drift check (always runs): fails if a prefix marked
   requiresPathRestrictedPushTrigger=true is missing from any workflow listed in
   pathRestrictedPushWorkflows, or if one of those workflows lists a push-branch
   pattern that isn't documented in branch-prefixes.json at all.

2. Per-PR branch-trust check (only runs inside a `pull_request`-triggered job, via
   $GITHUB_HEAD_REF/$GITHUB_BASE_REF): for every pathRestrictedPushWorkflows entry
   that has *no* `pull_request:` trigger of its own -- meaning a push-branch mismatch
   isn't just weaker coverage, it's zero coverage -- fails if this PR's branch isn't
   in trustedSelfHostedExecutionGlobs (or master) AND the PR touches a path that
   workflow's push trigger guards. This is exactly the MOV-106 near-miss: opening a
   PR from a `claude/**` branch silently skipped `ios-verify` entirely while the
   unrelated Linux `verify.yml` PR check still went green.

See docs/operators/branch-and-ci-conventions.md for the human-readable version of
this table and more context on why both checks exist.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PREFIXES_FILE = REPO_ROOT / "docs" / "operators" / "branch-prefixes.json"

# Branches that are structural (default branch, etc.) rather than platform prefixes,
# and so are never expected to appear in branch-prefixes.json.
IGNORED_BRANCHES = {"master", "main"}


def _extract_on_push_list(workflow_path: Path, key: str) -> list[str]:
    """Best-effort extraction of an `on.push.<key>` list (e.g. `branches` or `paths`).

    This is a small indentation-aware parser rather than a full YAML parser, so it
    only needs to understand the specific shape these workflow files use (top-level
    `on:`, nested `push:`, nested `<key>:` list of `- pattern` items). It avoids a
    PyYAML dependency so this check works the same locally and in CI without an
    extra install step.
    """
    lines = workflow_path.read_text().splitlines()
    items: list[str] = []
    in_on = in_push = in_list = False
    on_indent = push_indent = list_indent = -1

    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))

        if in_list and indent <= list_indent:
            in_list = False
        if in_push and indent <= push_indent and not re.match(r"^push:\s*$", stripped):
            in_push = False
        if in_on and indent <= on_indent and not re.match(r"^on:\s*$", stripped):
            in_on = False

        if re.match(r"^on:\s*$", stripped):
            in_on, on_indent = True, indent
            continue

        if in_on and re.match(r"^push:\s*$", stripped):
            in_push, push_indent = True, indent
            continue

        if in_push and re.match(rf"^{re.escape(key)}:\s*$", stripped):
            in_list, list_indent = True, indent
            continue

        if in_list and stripped.startswith("- "):
            items.append(stripped[2:].strip().strip("'\""))

    return items


def extract_push_branches(workflow_path: Path) -> list[str]:
    return _extract_on_push_list(workflow_path, "branches")


def extract_push_paths(workflow_path: Path) -> list[str]:
    return _extract_on_push_list(workflow_path, "paths")


def has_pull_request_trigger(workflow_path: Path) -> bool:
    """Best-effort check for a top-level `on.pull_request:` key, with or without a body."""
    lines = workflow_path.read_text().splitlines()
    in_on = False
    on_indent = -1

    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))

        if in_on and indent <= on_indent and not re.match(r"^on:\s*$", stripped):
            in_on = False

        if re.match(r"^on:\s*$", stripped):
            in_on, on_indent = True, indent
            continue

        if in_on and re.match(r"^pull_request:", stripped):
            return True

    return False


def check_static_drift(data: dict) -> list[str]:
    prefixes = data["prefixes"]
    workflows = data["pathRestrictedPushWorkflows"]

    required_globs = {p["glob"] for p in prefixes if p.get("requiresPathRestrictedPushTrigger")}
    known_globs = {p["glob"] for p in prefixes}

    problems: list[str] = []

    for workflow_rel in workflows:
        workflow_path = REPO_ROOT / workflow_rel
        if not workflow_path.exists():
            problems.append(f"{workflow_rel}: listed in branch-prefixes.json but does not exist")
            continue

        branch_set = set(extract_push_branches(workflow_path))

        for glob in sorted(required_globs - branch_set):
            problems.append(
                f"{workflow_rel}: missing required push-branch trigger '{glob}' "
                "(required by docs/operators/branch-prefixes.json)"
            )

        for glob in sorted(branch_set - known_globs - IGNORED_BRANCHES):
            problems.append(
                f"{workflow_rel}: push-branch trigger '{glob}' is not documented in "
                "docs/operators/branch-prefixes.json -- add it there (and to "
                "docs/operators/branch-and-ci-conventions.md) or remove it"
            )

    return problems


def changed_paths_in_pr(base_ref: str) -> list[str] | None:
    """Changed file paths between this PR's base and HEAD, or None if it can't be determined.

    Deliberately fails open (returns None) on any git error rather than raising, so a
    shallow-clone or network hiccup can never turn this into a spurious block on an
    unrelated PR -- only a positively-confirmed mismatch should fail the check.
    """
    try:
        subprocess.run(
            ["git", "fetch", "--depth=1", "origin", base_ref],
            check=True,
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        result = subprocess.run(
            ["git", "diff", "--name-only", "FETCH_HEAD", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
    except (subprocess.CalledProcessError, OSError) as exc:
        print(f"warning: could not compute changed paths against '{base_ref}': {exc}", file=sys.stderr)
        return None

    return [line for line in result.stdout.splitlines() if line]


def check_pr_branch_trust(data: dict) -> list[str]:
    """Only meaningful inside a `pull_request`-triggered job; a no-op everywhere else."""
    head_branch = os.environ.get("GITHUB_HEAD_REF")
    base_ref = os.environ.get("GITHUB_BASE_REF")
    if not head_branch or not base_ref:
        return []

    trusted_globs = set(data.get("trustedSelfHostedExecutionGlobs", []))
    if head_branch in IGNORED_BRANCHES or any(fnmatch.fnmatch(head_branch, g) for g in trusted_globs):
        return []

    changed = changed_paths_in_pr(base_ref)
    if changed is None:
        return []

    problems: list[str] = []
    for workflow_rel in data["pathRestrictedPushWorkflows"]:
        workflow_path = REPO_ROOT / workflow_rel
        if not workflow_path.exists():
            continue
        # A workflow that also has its own `pull_request:` trigger already runs on
        # this PR regardless of branch name -- a push-trigger branch mismatch there
        # is weaker coverage (per docs/operators/branch-and-ci-conventions.md), not
        # zero coverage, so it isn't this check's concern.
        if has_pull_request_trigger(workflow_path):
            continue

        guarded_paths = extract_push_paths(workflow_path)
        matched = [p for p in changed if any(fnmatch.fnmatch(p, g) for g in guarded_paths)]
        if matched:
            problems.append(
                f"branch '{head_branch}' touches paths guarded by {workflow_rel} "
                f"(e.g. '{matched[0]}'), but that workflow has no pull_request trigger "
                "and only runs on push to a trusted branch family "
                f"({', '.join(sorted(trusted_globs))}). It will NOT run on this PR at "
                "all. Rename this branch under a trusted prefix and re-push (see "
                "docs/operators/branch-and-ci-conventions.md) before merging -- "
                "otherwise this change merges without that lane's verification."
            )

    return problems


def main() -> int:
    if not PREFIXES_FILE.exists():
        print(f"Cannot find {PREFIXES_FILE}", file=sys.stderr)
        return 1

    data = json.loads(PREFIXES_FILE.read_text())

    problems = check_static_drift(data)
    problems.extend(check_pr_branch_trust(data))

    if problems:
        print("Branch prefix / CI trigger drift detected:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print("Branch prefixes and CI triggers are in sync.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
