// Desired Linear planning topology (MOV-368) and its idempotent reconciler.
//
// The shape is defined in docs/governance/linear-information-architecture.md:
// initiatives are finite, completable outcomes; projects are finite deliverables;
// milestones are project-local phases. This module holds the declarative
// desired state, a pure planner that diffs it against an observed snapshot, and
// a thin executor. The provisioner script owns credentials and the network
// boundary; everything here takes an injected `gql` so tests never touch Linear.

const CORE = "Shared Watchlists Core & API";
const WEB_SHARED = "Web Shared Watchlists";
const IOS_SHARED = "iOS Shared Watchlists";
const IOS_COMPANION = "iOS Companion App";
const LOCAL_DELIVERY = "Autonomous local-agent delivery";
const DEFERRED_CLOUD = "Deferred Linear cloud execution option";

export const SHARED_WATCHLISTS_INITIATIVE = "Deliver Shared Watchlists across Web and iOS";
export const TESTFLIGHT_INITIATIVE = "First iOS TestFlight beta";
export const AUTOMATION_INITIATIVE = "Automate moviecal Development and Delivery";

/**
 * Initiatives are outcomes that can be completed. Feature initiatives and
 * release initiatives intentionally overlap on shared projects, so rollups must
 * not be summed. `historicalProjects` are completed/canceled audit projects that
 * may stay linked; they are never created, updated, or reported as drift.
 */
export const DESIRED_INITIATIVES = [
  {
    name: SHARED_WATCHLISTS_INITIATIVE,
    description:
      "Finite feature outcome: shared watchlists work end to end on web and native iOS, on one shared core and API.",
    projects: [CORE, WEB_SHARED, IOS_SHARED],
    historicalProjects: [],
  },
  {
    name: TESTFLIGHT_INITIATIVE,
    description:
      "Finite release outcome: the first TestFlight build. Requires native Shared Watchlists and the Core & API capability it needs; does not wait for Web Shared Watchlists.",
    projects: [IOS_COMPANION, CORE, IOS_SHARED],
    historicalProjects: [],
  },
  {
    name: AUTOMATION_INITIATIVE,
    description: null,
    projects: [LOCAL_DELIVERY, DEFERRED_CLOUD],
    historicalProjects: [
      "Local development workflow stabilization and governance",
      "Hybrid workflow foundations (completed)",
      "Developer Governance & Agent Infrastructure",
    ],
  },
];

export const PROJECT_LABEL_WEB = "platform:web";
export const PROJECT_LABEL_IOS = "platform:ios";

/** Workspace project labels backing permanent per-platform project views. */
export const DESIRED_PROJECT_LABELS = [
  { name: PROJECT_LABEL_WEB, color: "#4ea7fc" },
  { name: PROJECT_LABEL_IOS, color: "#bec2c8" },
];

/**
 * Active/desired projects. A project with no initiative (documentation) is a
 * bounded task, not an outcome that needs its own initiative. Completed
 * projects (Platform & Infrastructure, the local-stabilization and hybrid
 * projects) are history and are deliberately absent.
 */
export const DESIRED_PROJECTS = [
  {
    name: CORE,
    labels: [PROJECT_LABEL_WEB, PROJECT_LABEL_IOS],
    milestones: ["Access and invitation safety", "Cross-client shared API"],
  },
  { name: WEB_SHARED, labels: [PROJECT_LABEL_WEB], milestones: ["Complete web collaboration"] },
  { name: IOS_SHARED, labels: [PROJECT_LABEL_IOS], milestones: ["Native experience"] },
  {
    name: IOS_COMPANION,
    labels: [PROJECT_LABEL_IOS],
    milestones: ["Skeleton", "Auth + API client", "Navigation shell"],
  },
  { name: "Documentation aligned with shipped product", labels: [], milestones: [] },
  {
    name: LOCAL_DELIVERY,
    labels: [],
    milestones: ["Automated intake & local kickoff", "Local acceptance & controlled autonomy"],
  },
  {
    name: DEFERRED_CLOUD,
    labels: [],
    milestones: ["Cloud environment & kickoff", "Cloud pilots & eligibility"],
  },
];

/**
 * Objects the provisioner must never create, relink, or otherwise touch. The
 * perpetual platform initiatives were replaced by outcome initiatives, and the
 * Calendar Feed project was empty. Existing instances (and their historical
 * links) stay exactly as they are.
 */
export const RETIRED_INITIATIVES = ["Web App", "iOS App"];
export const RETIRED_PROJECTS = ["Calendar Feed"];

const TERMINAL_PROJECT_TYPES = new Set(["completed", "canceled"]);
const TERMINAL_INITIATIVE_STATUSES = new Set(["Completed", "Canceled"]);

const isTerminalProject = (project) => TERMINAL_PROJECT_TYPES.has(project?.status?.type);
const isTerminalInitiative = (initiative) => TERMINAL_INITIATIVE_STATUSES.has(initiative?.status);

/**
 * Pure diff of desired topology against an observed snapshot.
 *
 * `actual` is `{ initiatives: [{id,name,status,projects:[{id,name}]}],
 * projects: [{id,name,status:{type},labels:[{id,name}],milestones:[{id,name}]}],
 * projectLabels: [{id,name}] }`.
 *
 * Returns `{ actions, warnings }`. Actions are the additive mutations needed;
 * warnings are drift a human must resolve (nothing is ever unlinked or deleted)
 * plus terminal objects that were skipped.
 */
export function planTopology(actual, desired = {}) {
  const initiatives = desired.initiatives ?? DESIRED_INITIATIVES;
  const projects = desired.projects ?? DESIRED_PROJECTS;
  const projectLabels = desired.projectLabels ?? DESIRED_PROJECT_LABELS;
  const actions = [];
  const warnings = [];

  const initByName = new Map(actual.initiatives.map((i) => [i.name, i]));
  const projByName = new Map(actual.projects.map((p) => [p.name, p]));
  const labelNames = new Set(actual.projectLabels.map((l) => l.name));

  for (const label of projectLabels) {
    if (!labelNames.has(label.name)) actions.push({ type: "create-project-label", name: label.name, color: label.color });
  }

  for (const desiredInit of initiatives) {
    const existing = initByName.get(desiredInit.name);
    if (!existing) {
      actions.push({ type: "create-initiative", name: desiredInit.name, description: desiredInit.description });
    } else if (isTerminalInitiative(existing)) {
      warnings.push({ type: "skipped-terminal-initiative", initiative: desiredInit.name });
    }
  }

  const projectMembership = new Map(); // project name -> desired initiative names
  for (const desiredInit of initiatives) {
    for (const projectName of desiredInit.projects) {
      projectMembership.set(projectName, [...(projectMembership.get(projectName) ?? []), desiredInit.name]);
    }
  }

  for (const desiredProject of projects) {
    const existing = projByName.get(desiredProject.name);
    if (existing && isTerminalProject(existing)) {
      warnings.push({ type: "skipped-terminal-project", project: desiredProject.name });
      continue;
    }
    if (!existing) actions.push({ type: "create-project", name: desiredProject.name });

    for (const initiativeName of projectMembership.get(desiredProject.name) ?? []) {
      const initiative = initByName.get(initiativeName);
      if (initiative && isTerminalInitiative(initiative)) continue;
      const linked = initiative?.projects.some((p) => p.name === desiredProject.name);
      if (!linked) actions.push({ type: "link-project", project: desiredProject.name, initiative: initiativeName });
    }

    const haveLabels = new Set((existing?.labels ?? []).map((l) => l.name));
    for (const label of desiredProject.labels) {
      if (!haveLabels.has(label)) actions.push({ type: "label-project", project: desiredProject.name, label });
    }

    const haveMilestones = new Set((existing?.milestones ?? []).map((m) => m.name));
    desiredProject.milestones.forEach((name, index) => {
      if (!haveMilestones.has(name)) {
        actions.push({ type: "create-milestone", project: desiredProject.name, name, sortOrder: index * 10 });
      }
    });
  }

  // Managed initiatives must not silently accumulate unplanned members.
  for (const desiredInit of initiatives) {
    const existing = initByName.get(desiredInit.name);
    if (!existing || isTerminalInitiative(existing)) continue;
    const allowed = new Set([...desiredInit.projects, ...desiredInit.historicalProjects]);
    for (const member of existing.projects) {
      if (!allowed.has(member.name)) {
        warnings.push({ type: "unexpected-link", initiative: desiredInit.name, project: member.name });
      }
    }
  }

  return { actions, warnings };
}

export function describeAction(action) {
  switch (action.type) {
    case "create-project-label":
      return `create project label '${action.name}'`;
    case "create-initiative":
      return `create initiative '${action.name}'`;
    case "create-project":
      return `create project '${action.name}'`;
    case "link-project":
      return `link project '${action.project}' -> initiative '${action.initiative}'`;
    case "label-project":
      return `label project '${action.project}' with '${action.label}'`;
    case "create-milestone":
      return `create milestone '${action.name}' on project '${action.project}'`;
    default:
      return JSON.stringify(action);
  }
}

export function describeWarning(warning) {
  switch (warning.type) {
    case "unexpected-link":
      return `initiative '${warning.initiative}' contains unplanned project '${warning.project}' (resolve by hand; never auto-unlinked)`;
    case "skipped-terminal-project":
      return `project '${warning.project}' is completed/canceled; left untouched`;
    case "skipped-terminal-initiative":
      return `initiative '${warning.initiative}' is completed/canceled; left untouched`;
    default:
      return JSON.stringify(warning);
  }
}

/** Read the live topology. Read-only. */
export async function readTopology(gql) {
  const initiativesData = await gql(
    `query { initiatives(first: 250) { nodes { id name status projects(first: 250) { nodes { id name } } } } }`,
  );
  const projectsData = await gql(
    `query { projects(first: 250) { nodes { id name status { type } labels { nodes { id name } } projectMilestones { nodes { id name } } } } }`,
  );
  const labelsData = await gql(`query { projectLabels(first: 250) { nodes { id name } } }`);
  return {
    initiatives: initiativesData.initiatives.nodes.map((i) => ({
      id: i.id,
      name: i.name,
      status: i.status,
      projects: i.projects.nodes,
    })),
    projects: projectsData.projects.nodes.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      labels: p.labels.nodes,
      milestones: p.projectMilestones.nodes,
    })),
    projectLabels: labelsData.projectLabels.nodes,
  };
}

/** Execute a plan. Resolves ids of objects created earlier in the same plan. */
export async function applyPlan(gql, actions, { teamId, log = () => {} } = {}) {
  const initiativeIds = new Map();
  const projectIds = new Map();
  const labelIds = new Map();
  const snapshot = await readTopology(gql);
  for (const i of snapshot.initiatives) initiativeIds.set(i.name, i.id);
  for (const p of snapshot.projects) projectIds.set(p.name, p.id);
  for (const l of snapshot.projectLabels) labelIds.set(l.name, l.id);

  for (const action of actions) {
    switch (action.type) {
      case "create-project-label": {
        const data = await gql(
          `mutation($input: ProjectLabelCreateInput!) { projectLabelCreate(input: $input) { success projectLabel { id name } } }`,
          { input: { name: action.name, color: action.color } },
        );
        labelIds.set(action.name, data.projectLabelCreate.projectLabel.id);
        break;
      }
      case "create-initiative": {
        const input = { name: action.name };
        if (action.description) input.description = action.description;
        const data = await gql(
          `mutation($input: InitiativeCreateInput!) { initiativeCreate(input: $input) { success initiative { id name } } }`,
          { input },
        );
        initiativeIds.set(action.name, data.initiativeCreate.initiative.id);
        break;
      }
      case "create-project": {
        const data = await gql(
          `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name } } }`,
          { input: { name: action.name, teamIds: [teamId] } },
        );
        projectIds.set(action.name, data.projectCreate.project.id);
        break;
      }
      case "link-project":
        await gql(
          `mutation($input: InitiativeToProjectCreateInput!) { initiativeToProjectCreate(input: $input) { success } }`,
          { input: { projectId: projectIds.get(action.project), initiativeId: initiativeIds.get(action.initiative) } },
        );
        break;
      case "label-project":
        await gql(
          `mutation($id: String!, $labelId: String!) { projectAddLabel(id: $id, labelId: $labelId) { success } }`,
          { id: projectIds.get(action.project), labelId: labelIds.get(action.label) },
        );
        break;
      case "create-milestone":
        await gql(
          `mutation($input: ProjectMilestoneCreateInput!) { projectMilestoneCreate(input: $input) { success } }`,
          { input: { name: action.name, projectId: projectIds.get(action.project), sortOrder: action.sortOrder } },
        );
        break;
      default:
        throw new Error(`Unknown topology action: ${action.type}`);
    }
    log(`  ${describeAction(action)}`);
  }
}

/**
 * Reconcile the live topology. With `check: true` nothing is written; the
 * result's `drift` says whether an apply run would change anything.
 */
export async function reconcileTopology(gql, { teamId, check = false, log = () => {} } = {}) {
  const actual = await readTopology(gql);
  const { actions, warnings } = planTopology(actual);
  for (const warning of warnings) log(`  [warn] ${describeWarning(warning)}`);
  if (check) {
    for (const action of actions) log(`  [drift] would ${describeAction(action)}`);
  } else {
    await applyPlan(gql, actions, { teamId, log });
  }
  return { actions, warnings, drift: actions.length > 0 || warnings.some((w) => w.type === "unexpected-link") };
}
