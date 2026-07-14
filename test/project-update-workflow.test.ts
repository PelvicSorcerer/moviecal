/**
 * Unit tests for the project-update workflow logic.
 *
 * These tests exercise the bash script's behaviour through fixture-driven
 * shell invocations so no live GitHub API calls are made.  Each test
 * scenario stubs the `gh` binary with a small shell function that returns
 * pre-canned JSON, then runs the relevant section of the workflow logic
 * extracted into a testable helper script.
 *
 * Because the workflow is a bash script we test it via child-process
 * execution of a helper that re-implements the core decision logic in an
 * environment-variable-driven, mockable form.
 */

import { execSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ScenarioResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the workflow item-lookup + auto-link logic in a controlled shell
 * environment.  The caller provides fixture JSON that the fake `gh` binary
 * returns for each GraphQL call, and the function returns the posted reply
 * text captured from `post_reply`.
 */
function runScenario(opts: {
  /** JSON string returned for the project fields query */
  projectFieldsJson: string;
  /** JSON string returned for the items page query, or an array of pages */
  itemsPagesJson: string | string[];
  /** JSON for the issue node lookup (used only when issueNotLinked=true) */
  issueNodeJson?: string;
  /** JSON returned by the addProjectV2ItemById mutation */
  addItemJson?: string;
  /** Simulate the add mutation failing (non-zero exit) */
  addItemFails?: boolean;
  /** JSON returned for a field mutation (all mutations share the same stub) */
  mutationJson?: string;
  /** Simulate the field mutation failing (non-zero exit) */
  mutationFails?: boolean;
  /** The Key=Value pairs string (e.g. "Status=Backlog") */
  pairsStr: string;
  /** Issue number */
  issueNumber?: number;
}): ScenarioResult {
  const dir = mkdtempSync(join(tmpdir(), 'project-update-test-'));

  try {
    const issueNumber = opts.issueNumber ?? 42;
    const itemsPagesJson = Array.isArray(opts.itemsPagesJson)
      ? opts.itemsPagesJson
      : [opts.itemsPagesJson];

    // Write page fixtures as numbered files so the fake gh can serve them in order.
    const pagesDir = join(dir, 'pages');
    mkdirSync(pagesDir);
    itemsPagesJson.forEach((page, i) => {
      writeFileSync(join(pagesDir, `page${i}.json`), page);
    });

    // Write other fixtures
    writeFileSync(join(dir, 'project_fields.json'), opts.projectFieldsJson);
    writeFileSync(join(dir, 'issue_node.json'), opts.issueNodeJson ?? '{"data":{"repository":{"issue":{"id":"I_NODE_ID"}}}}');
    writeFileSync(join(dir, 'add_item.json'), opts.addItemJson ?? '{"data":{"addProjectV2ItemById":{"item":{"id":"PVTI_NEW_ITEM"}}}}');
    writeFileSync(join(dir, 'mutation.json'), opts.mutationJson ?? '{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"PVTI_ITEM"}}}}');

    // Build a fake `gh` binary that reads the fixture files.
    // It increments a page counter file each time it's called for items.
    const pageCounterFile = join(dir, 'page_counter');
    writeFileSync(pageCounterFile, '0');

    const addItemFails = opts.addItemFails ? 'true' : 'false';
    const mutationFails = opts.mutationFails ? 'true' : 'false';

    const fakeGh = `#!/usr/bin/env bash
set -uo pipefail
ARGS=("$@")
DIR="${dir}"
PAGES_DIR="${pagesDir}"
COUNTER_FILE="${pageCounterFile}"
ADD_FAILS="${addItemFails}"
MUT_FAILS="${mutationFails}"

query_arg=""
for arg in "\${ARGS[@]}"; do
  query_arg="$arg"
done

# Detect which query is being made by inspecting the -f query= argument
combined="\${ARGS[*]}"

if echo "$combined" | grep -q 'projectsV2'; then
  cat "$DIR/project_fields.json"
elif echo "$combined" | grep -q 'addProjectV2ItemById'; then
  if [ "$ADD_FAILS" = "true" ]; then
    echo "add mutation failed" >&2
    exit 1
  fi
  cat "$DIR/add_item.json"
elif echo "$combined" | grep -q 'updateProjectV2ItemFieldValue'; then
  if [ "$MUT_FAILS" = "true" ]; then
    echo "mutation failed" >&2
    exit 1
  fi
  cat "$DIR/mutation.json"
elif echo "$combined" | grep -q 'repository.*issue'; then
  cat "$DIR/issue_node.json"
elif echo "$combined" | grep -q 'node.*items'; then
  count=\$(cat "$COUNTER_FILE")
  total_pages=\$(ls "$PAGES_DIR"/*.json | wc -l | tr -d ' ')
  if [ "\$count" -ge "\$total_pages" ]; then
    count=\$((total_pages - 1))
  fi
  cat "$PAGES_DIR/page\${count}.json"
  new_count=\$((count + 1))
  echo -n "\$new_count" > "$COUNTER_FILE"
elif echo "$combined" | grep -q 'collaborators'; then
  echo '{"permission":"admin"}'
else
  echo '{}'
fi
`;

    const fakeBin = join(dir, 'bin');
    mkdirSync(fakeBin);
    const fakeGhPath = join(fakeBin, 'gh');
    writeFileSync(fakeGhPath, fakeGh, { mode: 0o755 });

    // Capture replies posted by post_reply
    const repliesFile = join(dir, 'replies.txt');

    // Minimal shell that runs just the project-update logic we care about
    const script = `#!/usr/bin/env bash
set -uo pipefail
export PATH="${fakeBin}:$PATH"
export GH_TOKEN="fake-token"

ISSUES_TOKEN="fake-issues-token"
PROJECT_TOKEN="fake-project-token"
ISSUE_NUMBER="${issueNumber}"
REPO_OWNER="PelvicSorcerer"
REPO_NAME="moviecal"
PROJECT_OWNER="$REPO_OWNER"
PROJECT_TITLE="moviecal Delivery"
pairs_str="${opts.pairsStr}"
REPLIES_FILE="${repliesFile}"

post_reply() {
  printf '%s\\n---REPLY_BOUNDARY---\\n' "$1" >> "$REPLIES_FILE"
  echo "POST_REPLY: $1"
}

# ── Field map ────────────────────────────────────────────────────────────────
declare -A FIELD_MAP=(
  [Status]="Status"
  [AgentDispatch]="Agent Dispatch"
  [Track]="Track"
  [QueueOrder]="Queue Order"
  [Priority]="Priority"
  [Risk]="Risk"
  [ExecutionMode]="Execution Mode"
  [TargetPRSize]="Target PR Size"
)

declare -A PROJ_KEYS
parse_errors=""

read -ra pairs_arr <<< "$pairs_str"
for pair in "\${pairs_arr[@]}"; do
  if [[ "$pair" != *=* ]]; then
    parse_errors+="- \\$pair is not in Key=Value format.\\n"
    continue
  fi
  key="\${pair%%=*}"
  value="\${pair#*=}"
  value="\${value//_/ }"
  if [[ -v FIELD_MAP[$key] ]]; then
    PROJ_KEYS["\${FIELD_MAP[$key]}"]="$value"
  else
    parse_errors+="- Unknown field $key.\\n"
  fi
done

if [ -n "$parse_errors" ]; then
  post_reply "failed — parse errors: $parse_errors"
  exit 0
fi

# ── Query project fields ─────────────────────────────────────────────────────
projects_raw=$(GH_TOKEN="$PROJECT_TOKEN" gh api graphql -f query="query { organization(login:\\"$PROJECT_OWNER\\") { projectsV2(first:20) { nodes { id title fields(first:50) { nodes { ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name options { id name } } } } } } } }" 2>&1) || projects_raw=""

project_json=$(printf '%s' "$projects_raw" \\
  | jq --arg t "$PROJECT_TITLE" \\
    '{"data":{"user":{"projectV2":((.data.organization.projectsV2.nodes // .data.user.projectsV2.nodes) | map(select(.title == $t)) | .[0])}}}' \\
  2>/dev/null) || {
  post_reply "failed: Could not parse the GitHub Projects API response."
  exit 1
}

proj_id=$(printf '%s' "$project_json" | jq -r '.data.user.projectV2.id // empty' 2>/dev/null || true)
if [ -z "$proj_id" ]; then
  post_reply "failed: Could not find project."
  exit 1
fi

# ── Build field/option tables ────────────────────────────────────────────────
declare -A F_IDS F_TYPES O_IDS

while IFS=$'\\t' read -r fname fid ftype; do
  [ -z "$fname" ] && continue
  F_IDS["$fname"]="$fid"
  F_TYPES["$fname"]="$ftype"
done < <(printf '%s' "$project_json" | jq -r '
  .data.user.projectV2.fields.nodes[] |
  if has("options") then "\\(.name)\\t\\(.id)\\tsingleSelect"
  elif (.dataType // "") == "NUMBER" then "\\(.name)\\t\\(.id)\\tnumber"
  else "\\(.name)\\t\\(.id)\\tother" end
' 2>/dev/null || true)

while IFS=$'\\t' read -r fname oname oid; do
  [ -z "$fname" ] && continue
  lower_oname=$(printf '%s' "$oname" | tr '[:upper:]' '[:lower:]')
  O_IDS["\${fname}@@\${lower_oname}"]="$oid"
done < <(printf '%s' "$project_json" | jq -r '
  .data.user.projectV2.fields.nodes[] |
  if has("options") then . as $f | $f.options[] | "\\($f.name)\\t\\(.name)\\t\\(.id)" else empty end
' 2>/dev/null || true)

# ── Validate fields BEFORE any item lookup or mutation ───────────────────────
declare -A UPD_TYPE UPD_VAL
val_errors=""

for proj_name in "\${!PROJ_KEYS[@]}"; do
  value="\${PROJ_KEYS[$proj_name]}"
  if ! [[ -v F_IDS[$proj_name] ]]; then
    val_errors+="- Field $proj_name not found.\\n"
    continue
  fi
  ftype="\${F_TYPES[$proj_name]}"
  if [[ "$ftype" == "singleSelect" ]]; then
    lower_val=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')
    okey="\${proj_name}@@\${lower_val}"
    if ! [[ -v O_IDS[$okey] ]]; then
      valid_opts=$(printf '%s' "$project_json" | jq -r --arg fn "$proj_name" '[.data.user.projectV2.fields.nodes[] | select(.name == $fn) | .options[]?.name] | join(", ")' 2>/dev/null || true)
      val_errors+="- Invalid value $value for $proj_name. Valid: $valid_opts.\\n"
    else
      UPD_TYPE["$proj_name"]="singleSelect"
      UPD_VAL["$proj_name"]="\${O_IDS[$okey]}"
    fi
  elif [[ "$ftype" == "number" ]]; then
    if ! [[ "$value" =~ ^-?[0-9]+(\\.[0-9]+)?$ ]]; then
      val_errors+="- $proj_name requires numeric; got $value.\\n"
    else
      UPD_TYPE["$proj_name"]="number"
      UPD_VAL["$proj_name"]="$value"
    fi
  else
    val_errors+="- Field $proj_name type $ftype not supported.\\n"
  fi
done

if [ -n "$val_errors" ]; then
  post_reply "failed — validation errors (no changes made): $val_errors"
  exit 0
fi

# ── Look up item with pagination ─────────────────────────────────────────────
item_id=""
has_next_page="true"
cursor=""

while [[ "$has_next_page" == "true" && -z "$item_id" ]]; do
  if [ -z "$cursor" ]; then
    items_page=$(GH_TOKEN="$PROJECT_TOKEN" gh api graphql -f query="query { node(id:\\"$proj_id\\") { ... on ProjectV2 { items(first:100) { pageInfo { hasNextPage endCursor } nodes { id content { ... on Issue { number } ... on PullRequest { number } } } } } } }" 2>/dev/null) || {
      post_reply "failed: Could not query project items."
      exit 1
    }
  else
    items_page=$(GH_TOKEN="$PROJECT_TOKEN" gh api graphql -f query="query { node(id:\\"$proj_id\\") { ... on ProjectV2 { items(first:100,after:\\"$cursor\\") { pageInfo { hasNextPage endCursor } nodes { id content { ... on Issue { number } ... on PullRequest { number } } } } } } }" 2>/dev/null) || {
      post_reply "failed: Could not query project items (pagination)."
      exit 1
    }
  fi

  item_id=$(printf '%s' "$items_page" | jq -r --argjson n "$ISSUE_NUMBER" '[.data.node.items.nodes[] | select(.content.number == $n)] | .[0].id // empty' 2>/dev/null || true)
  has_next_page=$(printf '%s' "$items_page" | jq -r '.data.node.items.pageInfo.hasNextPage // false' 2>/dev/null || echo "false")
  cursor=$(printf '%s' "$items_page" | jq -r '.data.node.items.pageInfo.endCursor // empty' 2>/dev/null || true)
done

# ── Auto-link if absent ──────────────────────────────────────────────────────
issue_was_added="false"
if [ -z "$item_id" ]; then
  echo "SCENARIO: issue not in project, will auto-link"

  issue_node_raw=$(GH_TOKEN="$PROJECT_TOKEN" gh api graphql -f query="query { repository(owner:\\"$REPO_OWNER\\",name:\\"$REPO_NAME\\") { issue(number:$ISSUE_NUMBER) { id } } }" 2>/dev/null) || {
    post_reply "failed: Could not look up node ID for issue #$ISSUE_NUMBER."
    exit 1
  }

  issue_node_id=$(printf '%s' "$issue_node_raw" | jq -r '.data.repository.issue.id // empty' 2>/dev/null || true)
  if [ -z "$issue_node_id" ]; then
    post_reply "failed: Issue #$ISSUE_NUMBER not found in repository."
    exit 1
  fi

  add_result=$(GH_TOKEN="$PROJECT_TOKEN" gh api graphql -f query="mutation { addProjectV2ItemById(input:{projectId:\\"$proj_id\\",contentId:\\"$issue_node_id\\"}) { item { id } } }" 2>/dev/null) || {
    post_reply "failed: Could not add issue #$ISSUE_NUMBER to project. Field updates were not applied."
    exit 1
  }

  add_errs=$(printf '%s' "$add_result" | jq -r '[.errors[]?.message] | select(length > 0) | join("; ")' 2>/dev/null || true)
  if [ -n "$add_errs" ]; then
    post_reply "failed: Add error: $add_errs. Field updates were not applied."
    exit 1
  fi

  item_id=$(printf '%s' "$add_result" | jq -r '.data.addProjectV2ItemById.item.id // empty' 2>/dev/null || true)
  if [ -z "$item_id" ]; then
    post_reply "failed: Add mutation returned no item ID."
    exit 1
  fi
  issue_was_added="true"
  echo "AUTO_LINKED: $item_id"
fi

# ── Apply mutations ───────────────────────────────────────────────────────────
confirm_lines=""
for proj_name in "\${!UPD_TYPE[@]}"; do
  upd_type="\${UPD_TYPE[$proj_name]}"
  upd_val="\${UPD_VAL[$proj_name]}"
  fid="\${F_IDS[$proj_name]}"
  display_val="\${PROJ_KEYS[$proj_name]}"

  if [[ "$upd_type" == "singleSelect" ]]; then
    mut_result=$(GH_TOKEN="$PROJECT_TOKEN" gh api graphql -f query="mutation { updateProjectV2ItemFieldValue(input:{projectId:\\"$proj_id\\",itemId:\\"$item_id\\",fieldId:\\"$fid\\",value:{singleSelectOptionId:\\"$upd_val\\"}}) { projectV2Item { id } } }" 2>/dev/null) || {
      added_note=""
      [[ "$issue_was_added" == "true" ]] && added_note=" Issue #$ISSUE_NUMBER was added but field update failed."
      post_reply "mutation error on $proj_name.$added_note"
      exit 1
    }
  else
    mut_result=$(GH_TOKEN="$PROJECT_TOKEN" gh api graphql -f query="mutation { updateProjectV2ItemFieldValue(input:{projectId:\\"$proj_id\\",itemId:\\"$item_id\\",fieldId:\\"$fid\\",value:{number:$upd_val}}) { projectV2Item { id } } }" 2>/dev/null) || {
      added_note=""
      [[ "$issue_was_added" == "true" ]] && added_note=" Issue #$ISSUE_NUMBER was added but field update failed."
      post_reply "mutation error on $proj_name.$added_note"
      exit 1
    }
  fi

  mut_errs=$(printf '%s' "$mut_result" | jq -r '[.errors[]?.message] | select(length > 0) | join("; ")' 2>/dev/null) || mut_errs="parse error"
  if [ -n "$mut_errs" ]; then
    post_reply "failed on $proj_name: $mut_errs"
    exit 1
  fi
  confirm_lines+="- $proj_name → $display_val\\n"
done

if [[ "$issue_was_added" == "true" ]]; then
  post_reply "$(printf '%b' "succeeded.\\n\\nAdded issue #$ISSUE_NUMBER to $PROJECT_TITLE.\\nUpdated:\\n$confirm_lines")"
else
  post_reply "$(printf '%b' "applied to #$ISSUE_NUMBER:\\n\\n$confirm_lines")"
fi
echo "DONE"
`;

    writeFileSync(join(dir, 'run.sh'), script, { mode: 0o755 });

    const result = spawnSync('bash', [join(dir, 'run.sh')], {
      encoding: 'utf8',
      timeout: 15000,
    });

    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeProjectFieldsJson(projectId = 'PVT_PROJECT_ID'): string {
  return JSON.stringify({
    data: {
      organization: {
        projectsV2: {
          nodes: [
            {
              id: projectId,
              title: 'moviecal Delivery',
              fields: {
                nodes: [
                  {
                    id: 'F_STATUS',
                    name: 'Status',
                    options: [
                      { id: 'OPT_BACKLOG', name: 'Backlog' },
                      { id: 'OPT_READY', name: 'Ready' },
                      { id: 'OPT_IN_PROGRESS', name: 'In Progress' },
                      { id: 'OPT_DONE', name: 'Done' },
                    ],
                  },
                  {
                    id: 'F_TRACK',
                    name: 'Track',
                    options: [
                      { id: 'OPT_PLATFORM', name: 'Platform' },
                      { id: 'OPT_FUTURE', name: 'Future' },
                    ],
                  },
                  {
                    id: 'F_QUEUE_ORDER',
                    name: 'Queue Order',
                    dataType: 'NUMBER',
                  },
                ],
              },
            },
          ],
        },
      },
    },
  });
}

function makeItemsPage(
  issueNumbers: number[],
  hasNextPage = false,
  endCursor = 'CURSOR_END',
): string {
  return JSON.stringify({
    data: {
      node: {
        items: {
          pageInfo: { hasNextPage, endCursor },
          nodes: issueNumbers.map((n, i) => ({
            id: `PVTI_ITEM_${n}`,
            content: { number: n },
          })),
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('project-update workflow: auto-link logic', () => {
  it('scenario 1: existing linked issue — fields update normally', () => {
    const result = runScenario({
      projectFieldsJson: makeProjectFieldsJson(),
      // Issue 42 is already in the project
      itemsPagesJson: makeItemsPage([10, 42, 99]),
      pairsStr: 'Status=Backlog',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('AUTO_LINKED');
    expect(result.stdout).toContain('applied to #42');
    expect(result.stdout).toContain('Status');
  });

  it('scenario 2: unlinked issue — issue is added, then fields update', () => {
    const result = runScenario({
      projectFieldsJson: makeProjectFieldsJson(),
      // Issue 42 is NOT in the project
      itemsPagesJson: makeItemsPage([10, 99]),
      issueNodeJson: JSON.stringify({
        data: { repository: { issue: { id: 'I_NODE_42' } } },
      }),
      addItemJson: JSON.stringify({
        data: { addProjectV2ItemById: { item: { id: 'PVTI_NEW_42' } } },
      }),
      pairsStr: 'Status=Backlog',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AUTO_LINKED');
    expect(result.stdout).toContain('succeeded.');
    expect(result.stdout).toContain('Added issue #42');
    expect(result.stdout).toContain('Updated:');
  });

  it('scenario 3: invalid field on unlinked issue — issue is NOT added', () => {
    const result = runScenario({
      projectFieldsJson: makeProjectFieldsJson(),
      // Issue 42 not in project
      itemsPagesJson: makeItemsPage([10, 99]),
      // bogus field name
      pairsStr: 'BogusField=Whatever',
    });

    // Validation should fail before any item lookup matters, so no AUTO_LINKED
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('AUTO_LINKED');
    expect(result.stdout).toContain('failed');
  });

  it('scenario 3b: invalid option value on unlinked issue — issue is NOT added', () => {
    const result = runScenario({
      projectFieldsJson: makeProjectFieldsJson(),
      itemsPagesJson: makeItemsPage([10, 99]),
      // Status is a valid field but "InvalidOption" is not a valid value
      pairsStr: 'Status=InvalidOption',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('AUTO_LINKED');
    expect(result.stdout).toContain('failed');
    expect(result.stdout).toContain('Invalid value');
  });

  it('scenario 4: add mutation failure — clear failure response, fields not applied', () => {
    const result = runScenario({
      projectFieldsJson: makeProjectFieldsJson(),
      itemsPagesJson: makeItemsPage([10, 99]),
      issueNodeJson: JSON.stringify({
        data: { repository: { issue: { id: 'I_NODE_42' } } },
      }),
      addItemFails: true,
      pairsStr: 'Status=Backlog',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('failed');
    expect(result.stdout).toContain('Field updates were not applied');
    expect(result.stdout).not.toContain('succeeded');
  });

  it('scenario 5: existing item beyond first page is not duplicated', () => {
    // Page 1: hasNextPage=true, does not contain issue 42
    // Page 2: hasNextPage=false, contains issue 42
    const page1 = makeItemsPage([10, 20, 30], true, 'CURSOR_1');
    const page2 = makeItemsPage([42, 99], false);

    const result = runScenario({
      projectFieldsJson: makeProjectFieldsJson(),
      itemsPagesJson: [page1, page2],
      pairsStr: 'Status=Backlog',
    });

    expect(result.exitCode).toBe(0);
    // Must NOT auto-link (would duplicate the already-existing item)
    expect(result.stdout).not.toContain('AUTO_LINKED');
    // Must update the item found on page 2
    expect(result.stdout).toContain('applied to #42');
  });

  it('scenario 5b: item on page 2 — field update succeeds without auto-link', () => {
    const page1 = makeItemsPage([10, 20], true, 'CURSOR_1');
    const page2 = makeItemsPage([42], false);

    const result = runScenario({
      projectFieldsJson: makeProjectFieldsJson(),
      itemsPagesJson: [page1, page2],
      pairsStr: 'Status=Ready',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('AUTO_LINKED');
    expect(result.stdout).toContain('applied to #42');
    expect(result.stdout).toContain('Status');
  });

  it('field mutation failure after auto-link reports both events', () => {
    const result = runScenario({
      projectFieldsJson: makeProjectFieldsJson(),
      itemsPagesJson: makeItemsPage([10, 99]),
      issueNodeJson: JSON.stringify({
        data: { repository: { issue: { id: 'I_NODE_42' } } },
      }),
      addItemJson: JSON.stringify({
        data: { addProjectV2ItemById: { item: { id: 'PVTI_NEW_42' } } },
      }),
      mutationFails: true,
      pairsStr: 'Status=Backlog',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('AUTO_LINKED');
    expect(result.stdout).toContain('was added but field update failed');
  });
});
