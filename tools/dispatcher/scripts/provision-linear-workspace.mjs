#!/usr/bin/env node
// One-time (idempotent) Linear workspace provisioning script for moviecal.
// Reads LINEAR_API_KEY from ~/.config/moviecal/linear.env.
// See docs/governance/linear-information-architecture.md for the target shape.
//
// Safe to re-run: every step checks current state first and only creates or
// updates what's missing/different.
//
// Deliberately NOT provisioned here (see docs/governance/linear-information-architecture.md):
// - Initiatives: gated behind the Business plan on this workspace (confirmed
//   live via a FEATURE_NOT_ACCESSIBLE error on initiativeCreate). Skipped
//   rather than push a plan upgrade for a marginal nice-to-have at this
//   project's scale (5 projects, 1 team).
// - Custom views: the saved-view filterData JSON shape isn't documented in
//   the public API/schema, and getting it wrong risks shipping a saved view
//   that looks legitimate but silently returns nothing. Build the 7 target
//   views by hand in the Linear UI instead (a few minutes total) using the
//   definitions in the governance doc.
// - GitHub connection / issue import: integrationGithubConnect and
//   issueImportCreateGithub both require an OAuth `code` + `installationId`
//   obtained by clicking through GitHub's App-install consent screen in a
//   real logged-in browser session — not obtainable via this API key alone.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const envPath = path.join(os.homedir(), ".config", "moviecal", "linear.env");
const envText = fs.readFileSync(envPath, "utf8");
const apiKey = envText.match(/^LINEAR_API_KEY=(.*)$/m)?.[1]?.trim();
if (!apiKey) throw new Error("LINEAR_API_KEY not found");

async function gql(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) {
    throw new Error("GraphQL error: " + JSON.stringify(body.errors));
  }
  return body.data;
}

const log = (...args) => console.log(...args);

async function main() {
  // --- Team ---
  const teamData = await gql(`query { teams(filter: { key: { eq: "MOV" } }) { nodes { id key name } } }`);
  const team = teamData.teams.nodes[0];
  if (!team) throw new Error("Team MOV not found");
  log(`Team: ${team.name} (${team.key}) id=${team.id}`);

  // Enable triage
  await gql(
    `mutation($id: String!) { teamUpdate(id: $id, input: { triageEnabled: true }) { success } }`,
    { id: team.id },
  );
  log("  triageEnabled = true");

  // --- Workflow states ---
  const statesData = await gql(
    `query($teamId: ID) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type position } } }`,
    { teamId: team.id },
  );
  const states = statesData.workflowStates.nodes;
  const byName = (n) => states.find((s) => s.name === n);

  async function renameState(name, newName, position) {
    const s = byName(name);
    if (!s) {
      log(`  [skip rename] '${name}' not found`);
      return;
    }
    if (s.name === newName && s.position === position) return;
    await gql(
      `mutation($id: String!, $input: WorkflowStateUpdateInput!) { workflowStateUpdate(id: $id, input: $input) { success } }`,
      { id: s.id, input: { name: newName, position } },
    );
    log(`  renamed '${name}' -> '${newName}' (position ${position})`);
  }

  async function repositionState(name, position) {
    const s = byName(name);
    if (!s) return;
    if (s.position === position) return;
    await gql(
      `mutation($id: String!, $input: WorkflowStateUpdateInput!) { workflowStateUpdate(id: $id, input: $input) { success } }`,
      { id: s.id, input: { position } },
    );
    log(`  repositioned '${name}' -> ${position}`);
  }

  async function createState(name, type, position, color) {
    if (byName(name)) {
      log(`  [exists] '${name}'`);
      return;
    }
    await gql(
      `mutation($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success workflowState { id name } } }`,
      { input: { teamId: team.id, name, type, position, color } },
    );
    log(`  created '${name}' (${type}, position ${position})`);
  }

  await renameState("Todo", "Spec Ready", 1);
  await renameState("In Progress", "Agent Working", 2);
  await repositionState("Backlog", 0);
  await repositionState("Done", 3);
  await repositionState("Canceled", 4);
  await repositionState("Duplicate", 5);
  await repositionState("In Review", 2.6);

  await createState("Icebox", "backlog", 0.5, "#95a5a6");
  await createState("Ready for Agent", "unstarted", 1.5, "#4ea7fc");
  await createState("Needs Input", "started", 2.2, "#f2994a");
  await createState("Blocked", "started", 2.4, "#eb5757");
  await createState("Needs Human Decision", "started", 2.8, "#eb5757");
  await createState("Released", "completed", 3.5, "#5e6ad2");

  // --- Labels ---
  const labelsData = await gql(
    `query($teamId: ID) { issueLabels(filter: { team: { id: { eq: $teamId } } }) { nodes { id name } } }`,
    { teamId: team.id },
  );
  const existingLabels = new Set(labelsData.issueLabels.nodes.map((l) => l.name));

  const labelPlan = [
    ...["watchlist", "calendar", "auth", "database", "tests", "deployment", "docs", "process"].map((a) => `area:${a}`),
    ...["low", "medium", "high"].map((r) => `risk:${r}`),
    ...["claude", "codex", "any"].map((w) => `worker:${w}`),
    ...["cheap", "default", "strong"].map((m) => `model:${m}`),
    "human-only",
    "needs-secrets",
    ...["feat", "fix", "chore", "docs", "test"].map((t) => `type:${t}`),
    // Deliberately no "migration" label: Linear's own GitHub Issues import
    // wizard auto-creates and applies a "Migrated" label to every imported
    // issue, making a separate hand-rolled label redundant. One was created
    // here originally and then deleted once confirmed unused (0 issues) --
    // see docs/governance/linear-information-architecture.md.
    ...["multi-system", "ambiguous-spec", "security-critical", "prior-failure", "architecture"].map(
      (c) => `upgrade:${c}`,
    ),
  ];

  for (const name of labelPlan) {
    if (existingLabels.has(name)) continue;
    await gql(
      `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success } }`,
      { input: { teamId: team.id, name, color: "#bec2c8" } },
    );
    log(`  label created: ${name}`);
  }

  // --- Initiatives: SKIPPED. Live API confirms "Initiatives" are gated behind
  // the Business plan on this workspace ("Not allowed to access feature
  // 'teamInitiatives'" / "Subscribe to the Business plan"). Projects are
  // created standalone (no initiative grouping) rather than pushing a plan
  // upgrade for what was already a marginal nice-to-have at this project's
  // scale (5 projects, 1 team). Revisit if the plan is upgraded later.

  // --- Projects ---
  const projectsData = await gql(`query { projects { nodes { id name } } }`);
  const projByName = (n) => projectsData.projects.nodes.find((p) => p.name === n);

  async function ensureProject(name) {
    let proj = projByName(name);
    if (!proj) {
      const data = await gql(
        `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name } } }`,
        { input: { name, teamIds: [team.id] } },
      );
      proj = data.projectCreate.project;
      log(`  created project '${name}'`);
    } else {
      log(`  [exists] project '${name}'`);
    }
    return proj;
  }

  await ensureProject("Shared Watchlists");
  await ensureProject("Calendar Feed");
  await ensureProject("Platform & Infrastructure");
  await ensureProject("Developer Governance & Agent Infrastructure");
  const iosProject = await ensureProject("iOS Companion App");

  // --- Project milestones (iOS Companion App only) ---
  const milestonesData = await gql(
    `query($projId: String!) { project(id: $projId) { projectMilestones { nodes { id name } } } }`,
    { projId: iosProject.id },
  );
  const existingMilestones = new Set(milestonesData.project.projectMilestones.nodes.map((m) => m.name));

  let sortOrder = 0;
  for (const name of ["Skeleton", "Auth + API client", "Navigation shell"]) {
    if (existingMilestones.has(name)) {
      log(`  [exists] milestone '${name}'`);
    } else {
      await gql(
        `mutation($input: ProjectMilestoneCreateInput!) { projectMilestoneCreate(input: $input) { success } }`,
        { input: { name, projectId: iosProject.id, sortOrder } },
      );
      log(`  created milestone '${name}'`);
    }
    sortOrder += 10;
  }

  log("\nDone. Re-run this script any time — it's idempotent.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
