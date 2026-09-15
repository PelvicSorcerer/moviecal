import { describe, it, expect } from "vitest";
import { observePullRequest } from "../src/pr-reconcile.mjs";
import { admitRepair, classifyReviewTrigger, partitionRepairEvents, selectRepairEvents } from "../src/repair-policy.mjs";
import { repairJobKey } from "../src/repair-ledger.mjs";
import { DEFAULT_REPAIR_BUDGETS } from "../src/ci-outcomes.mjs";

const REPO = "owner/repo";
const HEAD = "sha-current";
const BRANCH = "agent/MOV-1-widget";

const ENTRY = Object.freeze({
  id: "MOV-1",
  name: "MOV-1-widget",
  branch: BRANCH,
  path: "/worktrees/MOV-1-widget",
  status: "review",
  prNumber: 7,
  prUrl: "https://github.com/owner/repo/pull/7",
  worker: "claude",
  model: "default",
  headSha: HEAD,
  provenance: { executor: "moviecal-dispatcher", repository: REPO },
});

/** Build a realistic observation through the same code path the dispatcher uses. */
function observe({ checks = [], reviews = [], comments = [], reviewDecision = null, state = "OPEN", isDraft = true, headSha = HEAD, headRepository = REPO } = {}) {
  return observePullRequest({
    pr: {
      state,
      isDraft,
      url: "https://github.com/owner/repo/pull/7",
      headRefOid: headSha,
      headRefName: BRANCH,
      headRepository: { nameWithOwner: headRepository },
      reviewDecision,
    },
    checks,
    requiredChecks: checks.filter((check) => check.required !== false).map((check) => check.name),
    reviews,
    comments,
  });
}

const check = ({ name, conclusion = "FAILURE", sha = HEAD, required = true, description } = {}) => ({
  name,
  conclusion,
  sha,
  required,
  ...(description ? { description } : {}),
});

const PASSING = check({ name: "lane-baseline", conclusion: "SUCCESS" });

function admit(overrides = {}) {
  return admitRepair({
    entry: ENTRY,
    repository: REPO,
    localHeadSha: HEAD,
    previousAttempts: { codeRepair: 0, infrastructureRerun: 0, total: 0 },
    reservedKeys: [],
    unfinishedAttempt: null,
    trustedReviewers: ["PelvicSorcerer"],
    enabled: true,
    ...overrides,
  });
}

describe("selectRepairEvents", () => {
  it("keeps only required checks on the current head", () => {
    const observation = observe({
      checks: [
        check({ name: "lane-unit" }),
        check({ name: "optional-lint", required: false }),
        check({ name: "lane-integration", sha: "sha-previous" }),
      ],
    });
    expect(selectRepairEvents(observation).map((event) => event.name)).toEqual(["lane-unit"]);
  });

  it("splits build failures from review verdicts", () => {
    const observation = observe({ checks: [check({ name: "lane-unit" }), check({ name: "lane-review" })] });
    const { ciEvents, reviewChecks } = partitionRepairEvents(observation);
    expect(ciEvents.map((event) => event.name)).toEqual(["lane-unit"]);
    expect(reviewChecks.map((event) => event.name)).toEqual(["lane-review"]);
  });
});

describe("admitRepair — the happy paths", () => {
  // Acceptance criterion: "A supported code failure is repaired on the
  // existing PR without human dispatch."
  it("proposes a code repair for a failing required code lane", () => {
    const result = admit({ observation: observe({ checks: [check({ name: "lane-unit" }), PASSING] }) });
    expect(result.action).toBe("code-repair");
    expect(result.trigger).toBe("ci");
    expect(result.headSha).toBe(HEAD);
    expect(result.key).toBe(repairJobKey({ prNumber: 7, headSha: HEAD, kind: "code-repair", fingerprints: result.fingerprints }));
  });

  // Acceptance criterion: "A recognized transient failure is rerun once and
  // never causes an unnecessary code change."
  it("proposes a rerun — not a code change — for a recognized transient failure", () => {
    const result = admit({ observation: observe({ checks: [check({ name: "lane-browser", conclusion: "TIMED_OUT" })] }) });
    expect(result.action).toBe("infrastructure-rerun");
  });

  it("repairs rather than reruns when code and infrastructure both failed", () => {
    const result = admit({
      observation: observe({
        checks: [check({ name: "lane-unit" }), check({ name: "lane-browser", conclusion: "TIMED_OUT" })],
      }),
    });
    expect(result.action).toBe("code-repair");
  });

  it("repairs a draft PR — a dispatcher PR is a draft until a human promotes it", () => {
    expect(admit({ observation: observe({ checks: [check({ name: "lane-unit" })], isDraft: true }) }).action).toBe("code-repair");
  });

  it("does nothing when every required check is green", () => {
    const result = admit({ observation: observe({ checks: [PASSING, check({ name: "lane-unit", conclusion: "SUCCESS" })] }) });
    expect(result.action).toBe("ignore");
  });
});

describe("admitRepair — what must never trigger a repair", () => {
  it("ignores an old-SHA failure", () => {
    const result = admit({ observation: observe({ checks: [check({ name: "lane-unit", sha: "sha-previous" }), PASSING] }) });
    expect(result.action).toBe("ignore");
  });

  it("ignores a failing optional check", () => {
    const result = admit({ observation: observe({ checks: [check({ name: "optional-lint", required: false }), PASSING] }) });
    expect(result.action).toBe("ignore");
  });

  it("ignores ordinary advisory comments", () => {
    const result = admit({
      observation: observe({
        checks: [PASSING],
        comments: [{ body: "nit: rename this variable", author: { login: "PelvicSorcerer" } }],
      }),
    });
    expect(result.action).toBe("ignore");
  });

  it("is switched off by default", () => {
    const result = admit({ observation: observe({ checks: [check({ name: "lane-unit" })] }), enabled: false });
    expect(result.action).toBe("ignore");
    expect(result.reason).toMatch(/MOVIECAL_AUTO_REPAIR/);
  });

  it("leaves a merged or closed PR to pr-reconcile", () => {
    for (const state of ["MERGED", "CLOSED"]) {
      const result = admit({ observation: observe({ checks: [check({ name: "lane-unit" })], state }) });
      expect(result.action).toBe("ignore");
    }
  });

  it("ignores a PR it could not observe", () => {
    const result = admit({ observation: { observationError: { message: "gh exploded" }, state: "UNAVAILABLE" } });
    expect(result.action).toBe("ignore");
    expect(result.reason).toMatch(/gh exploded/);
  });
});

describe("admitRepair — review triggers", () => {
  const requestChanges = (login) => ({ state: "REQUEST_CHANGES", author: { login }, body: "please fix the null check" });

  it("repairs on a trusted human REQUEST_CHANGES", () => {
    const result = admit({
      observation: observe({
        checks: [PASSING],
        reviews: [requestChanges("PelvicSorcerer")],
        reviewDecision: "CHANGES_REQUESTED",
      }),
    });
    expect(result.action).toBe("code-repair");
    expect(result.trigger).toBe("review");
    expect(result.reason).toMatch(/PelvicSorcerer/);
  });

  it("escalates a REQUEST_CHANGES from an untrusted reviewer", () => {
    const result = admit({
      observation: observe({
        checks: [PASSING],
        reviews: [requestChanges("drive-by-stranger")],
        reviewDecision: "CHANGES_REQUESTED",
      }),
    });
    expect(result.action).toBe("escalate");
    expect(result.reason).toMatch(/not on the trusted-reviewer list/);
  });

  it("ignores a REQUEST_CHANGES that GitHub no longer reports as blocking", () => {
    const result = admit({
      observation: observe({ checks: [PASSING], reviews: [requestChanges("PelvicSorcerer")], reviewDecision: "APPROVED" }),
    });
    expect(result.action).toBe("ignore");
  });

  it("repairs on a machine-readable blocking review finding", () => {
    const result = admit({
      observation: observe({ checks: [check({ name: "lane-review", description: "AI review: unused variable in src/lib/ical.ts" })] }),
    });
    expect(result.action).toBe("code-repair");
    expect(result.trigger).toBe("review");
  });

  // Acceptance criterion / manual check: "Verify a sensitive-path failure
  // stops for human action." A repair worker cannot give itself the
  // `sensitive-path-ack` label, and must not try to edit around the gate.
  it.each([
    ["a sensitive path", "sensitive-path change to .github/workflows/verify.yml requires explicit sign-off"],
    ["a detected secret", "secret-shaped string detected in src/config.ts"],
    ["an oversized diff", "diff size exceeds the review threshold"],
  ])("escalates a blocking review finding about %s", (_label, description) => {
    const result = admit({ observation: observe({ checks: [check({ name: "lane-review", description })] }) });
    expect(result.action).toBe("escalate");
    expect(result.reason).toMatch(/human sign-off/);
  });

  it("escalates a credential/permission CI failure rather than repairing it", () => {
    const result = admit({
      observation: observe({ checks: [check({ name: "supabase-verify", description: "403 forbidden: token expired" })] }),
    });
    expect(result.action).toBe("escalate");
  });

  it("escalates an unrecognized failure rather than guessing", () => {
    const result = admit({ observation: observe({ checks: [check({ name: "mystery-gate", description: "something went wrong" })] }) });
    expect(result.action).toBe("escalate");
  });
});

describe("classifyReviewTrigger", () => {
  it("reports no verdict when there is nothing blocking", () => {
    expect(classifyReviewTrigger(observe({ checks: [PASSING] }), { trustedReviewers: ["PelvicSorcerer"] })).toMatchObject({
      verdict: "none",
    });
  });

  it("treats a reviewer with no resolvable login as untrusted", () => {
    const result = classifyReviewTrigger(
      observe({ checks: [PASSING], reviews: [{ state: "REQUEST_CHANGES" }], reviewDecision: "CHANGES_REQUESTED" }),
      { trustedReviewers: ["PelvicSorcerer"] },
    );
    expect(result.verdict).toBe("escalate");
  });
});

describe("admitRepair — bounding the same failure", () => {
  const failing = () => observe({ checks: [check({ name: "lane-unit" })] });

  // Acceptance criterion: "Create at most one repair job per current head SHA
  // and failure fingerprint."
  it("refuses a second job for the same head SHA and failure fingerprint", () => {
    const first = admit({ observation: failing() });
    const second = admit({ observation: failing(), reservedKeys: [first.key] });
    expect(second.action).toBe("ignore");
    expect(second.reason).toMatch(/already exists for this head SHA/);
  });

  it("admits a *changed* failure on the same head SHA as genuinely new work", () => {
    const first = admit({ observation: failing() });
    const changed = admit({
      observation: observe({ checks: [check({ name: "lane-integration" })] }),
      reservedKeys: [first.key],
      previousAttempts: { codeRepair: 1, infrastructureRerun: 0, total: 1 },
    });
    expect(changed.action).toBe("code-repair");
    expect(changed.key).not.toBe(first.key);
  });

  // Acceptance criterion / manual check: "Verify a third repair attempt is
  // refused under the default budget."
  it("allows two code repairs by default and refuses the third", () => {
    expect(admit({ observation: failing(), previousAttempts: { codeRepair: 1, infrastructureRerun: 0, total: 1 } }).action)
      .toBe("code-repair");
    const third = admit({ observation: failing(), previousAttempts: { codeRepair: 2, infrastructureRerun: 0, total: 2 } });
    expect(third.action).toBe("escalate");
    expect(third.reason).toMatch(/budget exhausted/);
    expect(DEFAULT_REPAIR_BUDGETS.codeRepair).toBe(2);
  });

  it("allows one infrastructure rerun by default and refuses the second", () => {
    const transient = () => observe({ checks: [check({ name: "lane-browser", conclusion: "TIMED_OUT" })] });
    expect(admit({ observation: transient() }).action).toBe("infrastructure-rerun");
    expect(admit({ observation: transient(), previousAttempts: { codeRepair: 0, infrastructureRerun: 1, total: 1 } }).action)
      .toBe("escalate");
  });

  it("refuses once the total budget is spent, whatever the mix was", () => {
    const result = admit({ observation: failing(), previousAttempts: { codeRepair: 1, infrastructureRerun: 1, total: 3 } });
    expect(result.action).toBe("escalate");
  });
});

describe("admitRepair — target admission", () => {
  it("escalates when a previous attempt never recorded an outcome", () => {
    const result = admit({
      observation: observe({ checks: [check({ name: "lane-unit" })] }),
      unfinishedAttempt: { key: "repair:7:sha-old:code-repair:abc", kind: "code-repair", startedAt: "2026-09-14T10:00:00Z" },
    });
    expect(result.action).toBe("escalate");
    expect(result.reason).toMatch(/never recorded an outcome/);
  });

  // The security-meaningful staleness check: repair only ever edits the exact
  // code GitHub tested.
  it("escalates when the dispatcher-owned checkout is behind the PR head", () => {
    const result = admit({ observation: observe({ checks: [check({ name: "lane-unit" })] }), localHeadSha: "sha-older" });
    expect(result.action).toBe("escalate");
    expect(result.reason).toMatch(/but the PR head is/);
  });

  it.each([
    ["a fork PR", { observation: observe({ checks: [check({ name: "lane-unit" })], headRepository: "stranger/repo" }) }],
    ["an unprovenanced worktree", { entry: { ...ENTRY, provenance: undefined } }],
    ["a worktree no longer retained for review", { entry: { ...ENTRY, status: "abandoned" } }],
    ["a branch outside the issue namespace", { entry: { ...ENTRY, branch: "agent/something-else" } }],
  ])("escalates for %s", (_label, overrides) => {
    const result = admit({ observation: observe({ checks: [check({ name: "lane-unit" })] }), ...overrides });
    expect(result.action).toBe("escalate");
    expect(result.reason).toMatch(/not admissible|does not match|human sign-off/);
  });
});
