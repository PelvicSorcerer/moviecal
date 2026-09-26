import { describe, it, expect } from "vitest";
import {
  AUTOMATION_INITIATIVE,
  DESIRED_INITIATIVES,
  DESIRED_PROJECTS,
  DESIRED_PROJECT_LABELS,
  RETIRED_INITIATIVES,
  RETIRED_PROJECTS,
  SHARED_WATCHLISTS_INITIATIVE,
  TESTFLIGHT_INITIATIVE,
  planTopology,
  reconcileTopology,
} from "../src/linear-topology.mjs";

const membersOf = (name) => DESIRED_INITIATIVES.find((i) => i.name === name).projects;
const EMPTY = { initiatives: [], projects: [], projectLabels: [] };

/**
 * In-memory Linear that answers only the queries/mutations the reconciler
 * issues, so tests exercise the real GraphQL call sequence deterministically.
 */
function fakeLinear(seed = {}) {
  let seq = 0;
  const id = (kind) => `${kind}-${++seq}`;
  const state = {
    initiatives: seed.initiatives ?? [], // {id,name,status,projectIds}
    projects: seed.projects ?? [], // {id,name,status,labelIds,milestones:[{id,name}]}
    projectLabels: seed.projectLabels ?? [],
  };
  const mutations = [];
  const projectById = (pid) => state.projects.find((p) => p.id === pid);

  async function gql(query, variables = {}) {
    if (/^\s*query/.test(query)) {
      if (query.includes("initiatives(first")) {
        return {
          initiatives: {
            nodes: state.initiatives.map((i) => ({
              id: i.id,
              name: i.name,
              status: i.status,
              projects: { nodes: i.projectIds.map((pid) => ({ id: pid, name: projectById(pid).name })) },
            })),
          },
        };
      }
      if (query.includes("projects(first")) {
        return {
          projects: {
            nodes: state.projects.map((p) => ({
              id: p.id,
              name: p.name,
              status: p.status,
              labels: { nodes: p.labelIds.map((lid) => state.projectLabels.find((l) => l.id === lid)) },
              projectMilestones: { nodes: p.milestones },
            })),
          },
        };
      }
      if (query.includes("projectLabels(first")) return { projectLabels: { nodes: state.projectLabels } };
      throw new Error(`unexpected query: ${query}`);
    }
    mutations.push(query.match(/(\w+)\(/g)?.[1]?.slice(0, -1));
    if (query.includes("projectLabelCreate")) {
      const label = { id: id("label"), name: variables.input.name };
      state.projectLabels.push(label);
      return { projectLabelCreate: { success: true, projectLabel: label } };
    }
    if (query.includes("initiativeCreate")) {
      const initiative = { id: id("init"), name: variables.input.name, status: "Planned", projectIds: [] };
      state.initiatives.push(initiative);
      return { initiativeCreate: { success: true, initiative } };
    }
    if (query.includes("projectCreate")) {
      const project = {
        id: id("proj"),
        name: variables.input.name,
        status: { type: "backlog" },
        labelIds: [],
        milestones: [],
      };
      state.projects.push(project);
      return { projectCreate: { success: true, project } };
    }
    if (query.includes("initiativeToProjectCreate")) {
      state.initiatives.find((i) => i.id === variables.input.initiativeId).projectIds.push(variables.input.projectId);
      return { initiativeToProjectCreate: { success: true } };
    }
    if (query.includes("projectAddLabel")) {
      projectById(variables.id).labelIds.push(variables.labelId);
      return { projectAddLabel: { success: true } };
    }
    if (query.includes("projectMilestoneCreate")) {
      projectById(variables.input.projectId).milestones.push({ id: id("ms"), name: variables.input.name });
      return { projectMilestoneCreate: { success: true } };
    }
    throw new Error(`unexpected mutation: ${query}`);
  }

  return { gql, state, mutations };
}

describe("desired topology", () => {
  it("defines two finite outcome initiatives alongside the automation initiative", () => {
    expect(DESIRED_INITIATIVES.map((i) => i.name)).toEqual([
      "Deliver Shared Watchlists across Web and iOS",
      "First iOS TestFlight beta",
      "Automate moviecal Development and Delivery",
    ]);
  });

  it("gives Shared Watchlists the core, web, and iOS projects", () => {
    expect(new Set(membersOf(SHARED_WATCHLISTS_INITIATIVE))).toEqual(
      new Set(["Shared Watchlists Core & API", "Web Shared Watchlists", "iOS Shared Watchlists"]),
    );
  });

  it("gives TestFlight the companion, core, and native shared projects but not the web project", () => {
    const members = membersOf(TESTFLIGHT_INITIATIVE);
    expect(new Set(members)).toEqual(
      new Set(["iOS Companion App", "Shared Watchlists Core & API", "iOS Shared Watchlists"]),
    );
    expect(members).not.toContain("Web Shared Watchlists");
  });

  it("defines every initiative member as a desired project", () => {
    const projects = new Set(DESIRED_PROJECTS.map((p) => p.name));
    for (const initiative of DESIRED_INITIATIVES) {
      for (const name of initiative.projects) expect(projects.has(name)).toBe(true);
    }
  });

  it("never desires retired initiatives or the Calendar Feed project", () => {
    const initiatives = DESIRED_INITIATIVES.map((i) => i.name);
    const projects = DESIRED_PROJECTS.map((p) => p.name);
    for (const name of RETIRED_INITIATIVES) expect(initiatives).not.toContain(name);
    for (const name of RETIRED_PROJECTS) expect(projects).not.toContain(name);
    for (const initiative of DESIRED_INITIATIVES) {
      for (const name of RETIRED_PROJECTS) expect([...initiative.projects, ...initiative.historicalProjects]).not.toContain(name);
    }
  });

  it("keeps milestones project-local with the documented names", () => {
    const milestones = Object.fromEntries(DESIRED_PROJECTS.map((p) => [p.name, p.milestones]));
    expect(milestones["Shared Watchlists Core & API"]).toEqual(["Access and invitation safety", "Cross-client shared API"]);
    expect(milestones["Web Shared Watchlists"]).toEqual(["Complete web collaboration"]);
    expect(milestones["iOS Shared Watchlists"]).toEqual(["Native experience"]);
    expect(milestones["iOS Companion App"]).toEqual(["Skeleton", "Auth + API client", "Navigation shell"]);
  });

  it("uses only declared project labels", () => {
    const declared = new Set(DESIRED_PROJECT_LABELS.map((l) => l.name));
    for (const project of DESIRED_PROJECTS) for (const label of project.labels) expect(declared.has(label)).toBe(true);
  });
});

describe("planTopology", () => {
  it("plans everything against an empty workspace, without retired objects", () => {
    const { actions, warnings } = planTopology(EMPTY);
    expect(warnings).toEqual([]);
    const created = (type) => actions.filter((a) => a.type === type).map((a) => a.name);
    expect(created("create-initiative")).toEqual(DESIRED_INITIATIVES.map((i) => i.name));
    expect(created("create-project")).toEqual(DESIRED_PROJECTS.map((p) => p.name));
    const serialized = JSON.stringify(actions);
    for (const name of [...RETIRED_INITIATIVES, ...RETIRED_PROJECTS]) expect(serialized).not.toContain(name);
    expect(actions.filter((a) => a.type === "link-project" && a.initiative === TESTFLIGHT_INITIATIVE)).toHaveLength(3);
    expect(
      actions.some((a) => a.type === "link-project" && a.initiative === TESTFLIGHT_INITIATIVE && a.project === "Web Shared Watchlists"),
    ).toBe(false);
  });

  it("does not touch completed or canceled projects and initiatives", () => {
    const actual = {
      initiatives: [{ id: "i1", name: TESTFLIGHT_INITIATIVE, status: "Completed", projects: [] }],
      projects: [
        { id: "p1", name: "iOS Companion App", status: { type: "completed" }, labels: [], milestones: [] },
        { id: "p2", name: "Web Shared Watchlists", status: { type: "canceled" }, labels: [], milestones: [] },
      ],
      projectLabels: [],
    };
    const { actions, warnings } = planTopology(actual);
    expect(warnings).toEqual(
      expect.arrayContaining([
        { type: "skipped-terminal-initiative", initiative: TESTFLIGHT_INITIATIVE },
        { type: "skipped-terminal-project", project: "iOS Companion App" },
        { type: "skipped-terminal-project", project: "Web Shared Watchlists" },
      ]),
    );
    const touched = JSON.stringify(actions.filter((a) => a.type !== "create-project-label"));
    expect(touched).not.toContain('"project":"iOS Companion App"');
    expect(touched).not.toContain('"project":"Web Shared Watchlists"');
    expect(actions.some((a) => a.type === "create-initiative" && a.name === TESTFLIGHT_INITIATIVE)).toBe(false);
    expect(actions.some((a) => a.type === "link-project" && a.initiative === TESTFLIGHT_INITIATIVE)).toBe(false);
  });

  it("reports unplanned members as drift but allows historical automation projects", () => {
    const projects = [
      { id: "p1", name: "Web Shared Watchlists", status: { type: "started" }, labels: [], milestones: [] },
      { id: "p2", name: "Local development workflow stabilization and governance", status: { type: "completed" }, labels: [], milestones: [] },
    ];
    const actual = {
      initiatives: [
        { id: "i1", name: TESTFLIGHT_INITIATIVE, status: "Active", projects: [{ id: "p1", name: "Web Shared Watchlists" }] },
        { id: "i2", name: AUTOMATION_INITIATIVE, status: "Active", projects: [{ id: "p2", name: projects[1].name }] },
      ],
      projects,
      projectLabels: [],
    };
    const { warnings } = planTopology(actual);
    expect(warnings).toContainEqual({
      type: "unexpected-link",
      initiative: TESTFLIGHT_INITIATIVE,
      project: "Web Shared Watchlists",
    });
    expect(warnings.filter((w) => w.initiative === AUTOMATION_INITIATIVE)).toEqual([]);
  });
});

describe("reconcileTopology", () => {
  it("converges to the desired topology and is idempotent on re-run", async () => {
    const linear = fakeLinear();
    const first = await reconcileTopology(linear.gql, { teamId: "team-1" });
    expect(first.actions.length).toBeGreaterThan(0);

    const initiative = (name) => linear.state.initiatives.find((i) => i.name === name);
    const memberNames = (name) => initiative(name).projectIds.map((pid) => linear.state.projects.find((p) => p.id === pid).name);
    expect(memberNames(SHARED_WATCHLISTS_INITIATIVE).sort()).toEqual([...membersOf(SHARED_WATCHLISTS_INITIATIVE)].sort());
    expect(memberNames(TESTFLIGHT_INITIATIVE).sort()).toEqual([...membersOf(TESTFLIGHT_INITIATIVE)].sort());
    expect(linear.state.projects.map((p) => p.name)).not.toContain("Calendar Feed");
    expect(linear.state.initiatives.map((i) => i.name)).not.toContain("Web App");

    const writesAfterFirst = linear.mutations.length;
    const second = await reconcileTopology(linear.gql, { teamId: "team-1" });
    expect(second.actions).toEqual([]);
    expect(second.drift).toBe(false);
    expect(linear.mutations).toHaveLength(writesAfterFirst);
  });

  it("performs no writes in check mode and reports drift", async () => {
    const linear = fakeLinear();
    const result = await reconcileTopology(linear.gql, { teamId: "team-1", check: true });
    expect(result.drift).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(linear.mutations).toEqual([]);
    expect(linear.state.initiatives).toEqual([]);
  });

  it("reports no drift in check mode once applied", async () => {
    const linear = fakeLinear();
    await reconcileTopology(linear.gql, { teamId: "team-1" });
    const result = await reconcileTopology(linear.gql, { teamId: "team-1", check: true });
    expect(result).toMatchObject({ drift: false, actions: [] });
  });

  it("leaves pre-existing retired objects, historical links, and terminal projects exactly as found", async () => {
    const linear = fakeLinear({
      projects: [
        { id: "p-cal", name: "Calendar Feed", status: { type: "backlog" }, labelIds: [], milestones: [] },
        { id: "p-hist", name: "Hybrid workflow foundations (completed)", status: { type: "completed" }, labelIds: [], milestones: [] },
        { id: "p-plat", name: "Platform & Infrastructure", status: { type: "completed" }, labelIds: [], milestones: [] },
      ],
      initiatives: [
        { id: "i-web", name: "Web App", status: "Active", projectIds: ["p-cal", "p-plat"] },
        { id: "i-auto", name: AUTOMATION_INITIATIVE, status: "Active", projectIds: ["p-hist"] },
      ],
    });
    const before = JSON.stringify({
      web: linear.state.initiatives[0],
      cal: linear.state.projects[0],
      hist: linear.state.projects[1],
      plat: linear.state.projects[2],
    });
    await reconcileTopology(linear.gql, { teamId: "team-1" });
    const after = JSON.stringify({
      web: linear.state.initiatives.find((i) => i.name === "Web App"),
      cal: linear.state.projects.find((p) => p.name === "Calendar Feed"),
      hist: linear.state.projects.find((p) => p.name === "Hybrid workflow foundations (completed)"),
      plat: linear.state.projects.find((p) => p.name === "Platform & Infrastructure"),
    });
    expect(after).toBe(before);
    expect(linear.state.initiatives.find((i) => i.name === AUTOMATION_INITIATIVE).projectIds).toContain("p-hist");
  });

  it("only fills gaps in a partially provisioned workspace", async () => {
    const linear = fakeLinear();
    await reconcileTopology(linear.gql, { teamId: "team-1" });
    const testflight = linear.state.initiatives.find((i) => i.name === TESTFLIGHT_INITIATIVE);
    const dropped = testflight.projectIds.pop();
    const milestoneHost = linear.state.projects.find((p) => p.name === "iOS Shared Watchlists");
    milestoneHost.milestones = [];

    const result = await reconcileTopology(linear.gql, { teamId: "team-1" });
    expect(result.actions.map((a) => a.type).sort()).toEqual(["create-milestone", "link-project"]);
    expect(testflight.projectIds).toContain(dropped);
    expect(milestoneHost.milestones.map((m) => m.name)).toEqual(["Native experience"]);
  });
});
