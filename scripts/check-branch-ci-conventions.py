#!/usr/bin/env python3
"""Cross-check docs/operators/branch-prefixes.json against workflow push-branch triggers.

Fails (exit 1) if a prefix marked requiresPathRestrictedPushTrigger=true is missing from
any workflow listed in pathRestrictedPushWorkflows, or if one of those workflows lists a
push-branch pattern that isn't documented in branch-prefixes.json at all.

See docs/operators/branch-and-ci-conventions.md for the human-readable version of this
table and more context on why this check exists.
"""

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PREFIXES_FILE = REPO_ROOT / "docs" / "operators" / "branch-prefixes.json"

# Branches that are structural (default branch, etc.) rather than platform prefixes,
# and so are never expected to appear in branch-prefixes.json.
IGNORED_BRANCHES = {"master", "main"}


def extract_push_branches(workflow_path: Path) -> list[str]:
    """Best-effort extraction of `on.push.branches` from a GitHub Actions workflow file.

    This is a small indentation-aware parser rather than a full YAML parser, so it only
    needs to understand the specific shape these workflow files use (top-level `on:`,
    nested `push:`, nested `branches:` list of `- pattern` items). It avoids a PyYAML
    dependency so this check works the same locally and in CI without an extra install
    step.
    """
    lines = workflow_path.read_text().splitlines()
    branches: list[str] = []
    in_on = in_push = in_branches = False
    on_indent = push_indent = branches_indent = -1

    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))

        if in_branches and indent <= branches_indent:
            in_branches = False
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

        if in_push and re.match(r"^branches:\s*$", stripped):
            in_branches, branches_indent = True, indent
            continue

        if in_branches and stripped.startswith("- "):
            branches.append(stripped[2:].strip().strip("'\""))

    return branches


def main() -> int:
    if not PREFIXES_FILE.exists():
        print(f"Cannot find {PREFIXES_FILE}", file=sys.stderr)
        return 1

    data = json.loads(PREFIXES_FILE.read_text())
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

    if problems:
        print("Branch prefix / CI trigger drift detected:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print("Branch prefixes and CI triggers are in sync.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
