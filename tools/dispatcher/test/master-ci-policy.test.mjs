import { describe, expect, it } from "vitest";
import {
  attributeMasterRun,
  canCompleteMasterIncident,
  classifyMasterFailure,
  decideMasterIncident,
  DEFAULT_MASTER_VERIFICATION_WORKFLOWS,
  evaluateMasterLineage,
  linearReferences,
  masterIncidentKey,
  masterRunEligibility,
  normalizeMasterRun,
} from "../src/master-ci-policy.mjs";

const REPO = "PelvicSorcerer/moviecal";

function run(overrides = {}) {
  return {
    databaseId: 4242,
    attempt: 1,
    workflowName: "verify",
    event: "push",
    status: "completed",
    conclusion: "failure",
    headBranch: "master",
    headSha: "aaaaaaaaaaaa",
    url: "https://github.com/PelvicSorcerer/moviecal/actions/runs/4242",
    createdAt: "2026-09-23T10:00:00Z",
    jobs: [{ name: "lane-unit", conclusion: "failure" }],
    ...overrides,
  };
}

describe("master run eligibility (MOV-305)", () => {
  it("admits a completed failed push run on master from a configured workflow", () => {
    const result = masterRunEligibility(run(), { repo: REPO });
    expect(result.eligible).toBe(true);
    expect(result.run.runId).toBe(4242);
  });

  it("admits a failed ios-verify run exactly as it admits every other master lane", () => {
    const result = masterRunEligibility(run({ workflowName: "ios-verify", jobs: [{ name: "lane-ios", conclusion: "failure" }] }), { repo: REPO });
    expect(result.eligible).toBe(true);
  });

  // Acceptance criterion 2, one clause per refusal.
  it.each([
    ["success", run({ conclusion: "success" }), /not a master failure/],
    ["skipped", run({ conclusion: "skipped" }), /not a master failure/],
    ["cancelled", run({ conclusion: "cancelled" }), /not a master failure/],
    ["still running", run({ status: "in_progress", conclusion: "" }), /not completed/],
    ["manually dispatched", run({ event: "workflow_dispatch" }), /not a push/],
    ["scheduled", run({ event: "schedule" }), /not a push/],
    ["pull request", run({ event: "pull_request", headBranch: "agent/MOV-1-x" }), /not a push/],
    ["non-master branch", run({ headBranch: "agent/MOV-1-x" }), /not master/],
    ["fork head repository", run({ head_repository: { full_name: "someone/moviecal" } }), /head repository/],
    ["unconfigured workflow", run({ workflowName: "smoke-external" }), /not a configured master verification workflow/],
    ["no run id", run({ databaseId: null }), /immutable run id/],
    ["no tested commit", run({ headSha: "" }), /no tested commit/],
  ])("refuses a %s run", (_label, candidate, reason) => {
    const result = masterRunEligibility(candidate, { repo: REPO });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(reason);
  });

  it("reads the REST payload shape as well as the gh one", () => {
    const normalized = normalizeMasterRun({
      id: 77,
      run_attempt: 3,
      head_branch: "master",
      head_sha: "bbbb",
      created_at: "2026-09-23T09:00:00Z",
      html_url: "https://example.test/77",
      name: "ios-verify",
      event: "PUSH",
      status: "Completed",
      conclusion: "Failure",
      repository: { full_name: REPO },
    });
    expect(normalized).toMatchObject({ runId: 77, runAttempt: 3, headBranch: "master", event: "push", conclusion: "failure", repository: REPO });
  });

  it("normalizes idempotently, so re-checking a merged record keeps its run id", () => {
    const once = normalizeMasterRun(run({ attempt: 4 }));
    const twice = normalizeMasterRun(once);
    expect(twice).toEqual(once);
    expect(masterRunEligibility(once, { repo: REPO }).eligible).toBe(true);
  });

  it("names the four push-capable verification workflows by default", () => {
    expect([...DEFAULT_MASTER_VERIFICATION_WORKFLOWS].sort()).toEqual(["browser-verify", "ios-verify", "supabase-verify", "verify"]);
  });
});

describe("master incident idempotency key (MOV-305)", () => {
  it("keys on the run id, the attempt, and the tested SHA together", () => {
    expect(masterIncidentKey({ runId: 1, runAttempt: 1, headSha: "abc" })).toBe("master-ci:1:1:abc");
    expect(masterIncidentKey({ runId: 1, runAttempt: 2, headSha: "abc" })).not.toBe(masterIncidentKey({ runId: 1, runAttempt: 1, headSha: "abc" }));
    expect(masterIncidentKey({ runId: 1, runAttempt: 1, headSha: "def" })).not.toBe(masterIncidentKey({ runId: 1, runAttempt: 1, headSha: "abc" }));
  });

  it("defaults a missing attempt to 1 rather than producing a distinct key each poll", () => {
    expect(masterIncidentKey({ runId: 9, headSha: "abc" })).toBe(masterIncidentKey({ runId: 9, runAttempt: 1, headSha: "abc" }));
  });

  it("refuses to key an incident with no run id or no SHA", () => {
    expect(() => masterIncidentKey({ runId: null, headSha: "abc" })).toThrow(/runId and headSha/);
    expect(() => masterIncidentKey({ runId: 1 })).toThrow(/runId and headSha/);
  });
});

describe("master failure classification (MOV-305)", () => {
  it("classifies a failed code/test lane as code-test, including lane-ios", () => {
    expect(classifyMasterFailure(run({ jobs: [{ name: "lane-unit", conclusion: "failure" }] })).classification).toBe("code-test");
    expect(
      classifyMasterFailure(run({ workflowName: "ios-verify", jobs: [{ name: "lane-ios", conclusion: "failure" }] })).classification,
    ).toBe("code-test");
  });

  it("classifies a startup failure as infrastructure rather than as code", () => {
    const result = classifyMasterFailure(run({ conclusion: "startup_failure", jobs: [{ name: "lane-unit", conclusion: "failure" }] }));
    expect(result.classification).toBe("infrastructure-transient");
  });

  it("classifies a failure with no failed job as infrastructure, not as unknown code", () => {
    const result = classifyMasterFailure(run({ jobs: [{ name: "lane-unit", conclusion: "success" }] }));
    expect(result.classification).toBe("infrastructure-transient");
    expect(result.reason).toMatch(/no failed job/);
  });

  it("classifies a timed-out runner job as infrastructure", () => {
    expect(classifyMasterFailure(run({ jobs: [{ name: "lane-browser", conclusion: "timed_out" }] })).classification).toBe(
      "infrastructure-transient",
    );
  });

  it("always treats a production/migration job as sensitive, never as repairable code", () => {
    const result = classifyMasterFailure(
      run({ workflowName: "supabase-verify", jobs: [{ name: "lane-migrate-prod", conclusion: "failure" }] }),
    );
    expect(result.classification).toBe("sensitive-permission");
    expect(result.reason).toMatch(/production, migration, or credential/);
  });

  it("lets the least automatable failed job decide a mixed run", () => {
    const result = classifyMasterFailure(
      run({ jobs: [{ name: "lane-unit", conclusion: "failure" }, { name: "lane-browser", conclusion: "timed_out" }] }),
    );
    expect(result.classification).toBe("infrastructure-transient");
  });
});

describe("master run attribution (MOV-305)", () => {
  it("attributes one PR and its single Linear reference", () => {
    const result = attributeMasterRun({
      pullRequests: [{ number: 602, url: "https://example.test/602", body: "Linear: MOV-293\n\nFixes MOV-293" }],
    });
    expect(result).toMatchObject({ prNumber: 602, sourceIssue: "MOV-293", ambiguous: false });
  });

  it("records an absent Linear reference without escalating", () => {
    const result = attributeMasterRun({ pullRequests: [{ number: 7, body: "no reference here" }] });
    expect(result.ambiguous).toBe(false);
    expect(result.sourceIssue).toBeNull();
    expect(result.reason).toMatch(/recorded as absent/);
  });

  it("is ambiguous when GitHub attributes no pull request", () => {
    expect(attributeMasterRun({ pullRequests: [] })).toMatchObject({ ambiguous: true, prNumber: null });
  });

  it("is ambiguous when GitHub attributes several pull requests", () => {
    const result = attributeMasterRun({ pullRequests: [{ number: 1 }, { number: 2 }] });
    expect(result.ambiguous).toBe(true);
    expect(result.reason).toMatch(/#1, #2/);
  });

  it("is ambiguous when one PR references several Linear issues", () => {
    const result = attributeMasterRun({ pullRequests: [{ number: 3, body: "Fixes MOV-1 and also MOV-2" }] });
    expect(result).toMatchObject({ ambiguous: true, prNumber: 3, sourceIssue: null });
  });

  it("de-duplicates repeated references to the same issue", () => {
    expect(linearReferences("Linear: MOV-9\nFixes MOV-9\nmov-9")).toEqual(["MOV-9"]);
  });
});

describe("master lineage (MOV-305)", () => {
  const shas = ["c3", "c2", "c1", "c0"];

  it("treats the current tip as current lineage", () => {
    expect(evaluateMasterLineage({ headSha: "c3", masterShas: shas })).toMatchObject({ current: true, distance: 0 });
  });

  it("treats a recent ancestor as current lineage", () => {
    expect(evaluateMasterLineage({ headSha: "c1", masterShas: shas })).toMatchObject({ current: true, distance: 2 });
  });

  it("refuses a commit that is no longer on master", () => {
    const result = evaluateMasterLineage({ headSha: "gone", masterShas: shas });
    expect(result.current).toBe(false);
    expect(result.reason).toMatch(/stale or rewritten/);
  });

  it("refuses a commit further behind than the configured window", () => {
    expect(evaluateMasterLineage({ headSha: "c0", masterShas: shas, maxDistance: 1 })).toMatchObject({ current: false, distance: 3 });
  });

  it("refuses when the lineage could not be read at all", () => {
    expect(evaluateMasterLineage({ headSha: "c3", masterShas: [] }).current).toBe(false);
  });
});

describe("master incident decision (MOV-305)", () => {
  const safe = {
    classification: "code-test",
    classificationReason: "lane-unit failed",
    attribution: { ambiguous: false, prNumber: 602 },
    lineage: { current: true, distance: 0, reason: "tip" },
    budget: { used: 0, limit: 1 },
  };

  it("routes a deterministic, attributed, current-lineage failure to a fix PR", () => {
    const decision = decideMasterIncident(safe);
    expect(decision.action).toBe("route-fix-pr");
    expect(decision.humanDecision).toBeNull();
  });

  it.each([
    // classificationReason: null exercises this module's own fallback wording
    // rather than echoing whatever the classifier happened to say.
    ["a sensitive failure", { classification: "sensitive-permission", classificationReason: null }, /credentials, permissions, production, or governance/],
    ["an infrastructure failure", { classification: "infrastructure-transient", classificationReason: null }, /runner, network, or environment/],
    ["an unknown failure", { classification: "unknown", classificationReason: null }, /classified as "unknown"/],
    ["ambiguous attribution", { attribution: { ambiguous: true, reason: "two PRs" } }, /two PRs/],
    ["stale lineage", { lineage: { current: false, reason: "commit is gone" } }, /commit is gone/],
    ["an exhausted budget", { budget: { used: 1, limit: 1 } }, /budget is exhausted/],
    ["a failed incident creation", { incidentCreated: false }, /could not be created/],
  ])("stops for a human on %s", (_label, override, reason) => {
    const decision = decideMasterIncident({ ...safe, ...override });
    expect(decision.action).toBe("needs-human-decision");
    expect(decision.reason).toMatch(reason);
    expect(decision.humanDecision).toBeTruthy();
  });

  it("never produces an action that touches master", () => {
    const actions = new Set();
    for (const classification of ["code-test", "infrastructure-transient", "sensitive-permission", "unknown"]) {
      for (const ambiguous of [true, false]) {
        for (const current of [true, false]) {
          actions.add(
            decideMasterIncident({ ...safe, classification, attribution: { ambiguous, prNumber: 1 }, lineage: { current } }).action,
          );
        }
      }
    }
    expect([...actions].sort()).toEqual(["needs-human-decision", "route-fix-pr"]);
  });
});

describe("master incident completion (MOV-305)", () => {
  const masterShas = ["new", "mid", "bad", "old"];
  const mergedFixPr = { number: 700 };

  it("completes only once the fix merged and the lane passed on a newer commit", () => {
    const result = canCompleteMasterIncident({
      incidentSha: "bad",
      lane: "lane-unit",
      mergedFixPr,
      successfulRun: { headSha: "new" },
      masterShas,
    });
    expect(result.complete).toBe(true);
  });

  it("refuses while no fix PR has merged", () => {
    expect(canCompleteMasterIncident({ incidentSha: "bad", masterShas, successfulRun: { headSha: "new" } }).complete).toBe(false);
  });

  it("refuses a green re-run of the original SHA", () => {
    const result = canCompleteMasterIncident({ incidentSha: "bad", mergedFixPr, successfulRun: { headSha: "bad" }, masterShas });
    expect(result.complete).toBe(false);
    expect(result.reason).toMatch(/green re-run on the original SHA/);
  });

  it("refuses a green run on an older commit", () => {
    const result = canCompleteMasterIncident({ incidentSha: "bad", mergedFixPr, successfulRun: { headSha: "old" }, masterShas });
    expect(result.complete).toBe(false);
    expect(result.reason).toMatch(/not newer/);
  });

  it("refuses when either commit cannot be placed on current lineage", () => {
    expect(
      canCompleteMasterIncident({ incidentSha: "bad", mergedFixPr, successfulRun: { headSha: "elsewhere" }, masterShas }).complete,
    ).toBe(false);
  });

  it("refuses when the lane has not reported a success at all", () => {
    expect(canCompleteMasterIncident({ incidentSha: "bad", mergedFixPr, successfulRun: null, masterShas }).complete).toBe(false);
  });
});
