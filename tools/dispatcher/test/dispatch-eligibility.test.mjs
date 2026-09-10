import { describe, it, expect } from "vitest";
import {
  LOCAL_DISPATCHER_DELEGATE,
  confirmStillClaimable,
  describeDelegate,
  evaluateLocalDispatch,
  isLocalDispatcherDelegate,
  normalizeDelegate,
  selectCloudCandidates,
  selectLocalCandidates,
} from "../src/dispatch-eligibility.mjs";

const DISPATCHER = { id: "actor-dispatcher", name: LOCAL_DISPATCHER_DELEGATE, displayName: "moviecal-dispatcher" };
const HUMAN = { id: "user-adam", name: "Adam", displayName: "Adam" };

/** A Mac-routed issue delegated to this dispatcher — the one shape that dispatches. */
function eligibleIssue(overrides = {}) {
  return {
    id: "id-1",
    identifier: "MOV-1",
    title: "Fix the thing",
    description: "Do the fix.",
    project: null,
    labels: ["execution:mac"],
    delegate: DISPATCHER,
    ...overrides,
  };
}

const EXPECTED = { id: "actor-dispatcher", name: LOCAL_DISPATCHER_DELEGATE };

describe("normalizeDelegate", () => {
  it("returns null for every shape Linear uses to mean 'delegated to nobody'", () => {
    expect(normalizeDelegate(null)).toBeNull();
    expect(normalizeDelegate(undefined)).toBeNull();
    // A field the query didn't select, or an all-blank node, must never read as a match.
    expect(normalizeDelegate({})).toBeNull();
    expect(normalizeDelegate({ id: "  ", name: "" })).toBeNull();
  });

  it("normalizes a delegate node to {id, name, displayName} and trims", () => {
    expect(normalizeDelegate({ id: " a1 ", name: " moviecal-dispatcher ", displayName: null })).toEqual({
      id: "a1",
      name: "moviecal-dispatcher",
      displayName: null,
    });
  });

  it("describes a missing delegate as 'nobody'", () => {
    expect(describeDelegate(null)).toBe("nobody");
    expect(describeDelegate(DISPATCHER)).toBe("moviecal-dispatcher");
  });
});

describe("isLocalDispatcherDelegate", () => {
  it("matches by name when no actor id is configured", () => {
    expect(isLocalDispatcherDelegate(DISPATCHER, { name: LOCAL_DISPATCHER_DELEGATE })).toBe(true);
    expect(isLocalDispatcherDelegate(HUMAN, { name: LOCAL_DISPATCHER_DELEGATE })).toBe(false);
    expect(isLocalDispatcherDelegate(null, {})).toBe(false);
  });

  it("matches by name case-insensitively, and via displayName when name is absent", () => {
    expect(isLocalDispatcherDelegate({ id: "x", name: "MovieCal-Dispatcher" }, EXPECTED)).toBe(true);
    expect(isLocalDispatcherDelegate({ id: "x", name: null, displayName: "moviecal-dispatcher" }, EXPECTED)).toBe(true);
  });

  it("matches on the actor id even when the delegate's name differs", () => {
    // Linear's `delegate.id` is a UUID; the configured LINEAR_APP_ACTOR_ID may
    // be either that UUID or the app name. Either identifier qualifies —
    // requiring the id alone rejects every issue when the app name is what is
    // configured, which is what the installed linear-app.env actually holds.
    expect(isLocalDispatcherDelegate({ id: "actor-dispatcher", name: "Renamed App" }, EXPECTED)).toBe(true);
  });

  it("rejects a delegate matching neither identifier", () => {
    expect(isLocalDispatcherDelegate({ id: "actor-someone-else", name: "Someone Else" }, EXPECTED)).toBe(false);
  });
});

describe("evaluateLocalDispatch", () => {
  it("dispatches a correctly Mac-routed, correctly delegated issue", () => {
    expect(evaluateLocalDispatch(eligibleIssue(), { expectedDelegate: EXPECTED })).toEqual({
      action: "dispatch",
      eligible: true,
      reason: null,
      route: "mac",
      delegate: DISPATCHER,
    });
  });

  it("skips a cloud-routed issue without writing anything, even when delegated here", () => {
    const issue = eligibleIssue({ project: "Calendar Feed", labels: ["execution:cloud"] });
    expect(evaluateLocalDispatch(issue, { expectedDelegate: EXPECTED })).toMatchObject({
      action: "skip",
      eligible: false,
      route: "cloud",
      reason: expect.stringMatching(/local Mac adapter does not execute/),
    });
  });

  it("skips a coordination-only (execution:none) issue", () => {
    const issue = eligibleIssue({ labels: ["type:coordination", "execution:none"] });
    expect(evaluateLocalDispatch(issue, { expectedDelegate: EXPECTED })).toMatchObject({
      action: "skip",
      eligible: false,
      route: "none",
    });
  });

  it("skips an issue delegated to somebody else, naming who has it", () => {
    const issue = eligibleIssue({ delegate: HUMAN });
    expect(evaluateLocalDispatch(issue, { expectedDelegate: EXPECTED })).toMatchObject({
      action: "skip",
      eligible: false,
      reason: "delegated to Adam (actor user-adam), not moviecal-dispatcher (actor actor-dispatcher)",
    });
  });

  it("skips an undelegated issue — an empty delegate is not an implicit grant", () => {
    const issue = eligibleIssue({ delegate: null });
    expect(evaluateLocalDispatch(issue, { expectedDelegate: EXPECTED })).toMatchObject({
      action: "skip",
      eligible: false,
      reason: "delegated to nobody, not moviecal-dispatcher (actor actor-dispatcher)",
    });
  });

  it("names both actors in a mismatch rather than reporting a name against itself", () => {
    // Found by running `dispatcher dry-run`: the message previously came out
    // as "delegated to moviecal-dispatcher, not moviecal-dispatcher", which
    // reads as a dispatcher bug rather than a misdelegated issue.
    const issue = eligibleIssue({ delegate: { id: "user-adam", name: "Adam" } });
    const reason = evaluateLocalDispatch(issue, { expectedDelegate: EXPECTED }).reason;
    expect(reason).toContain("user-adam");
    expect(reason).toContain("actor-dispatcher");
  });

  it("keeps the plain message when the configured id is just the app name", () => {
    // The installed linear-app.env sets LINEAR_APP_ACTOR_ID to the app name,
    // so id and name are the same string — don't print it twice.
    const issue = eligibleIssue({ delegate: null });
    const expected = { id: LOCAL_DISPATCHER_DELEGATE, name: LOCAL_DISPATCHER_DELEGATE };
    expect(evaluateLocalDispatch(issue, { expectedDelegate: expected }).reason).toBe(
      "delegated to nobody, not moviecal-dispatcher",
    );
  });

  it("escalates an un-routed issue that IS delegated here — this dispatcher is its writer", () => {
    const issue = eligibleIssue({ labels: [] });
    expect(evaluateLocalDispatch(issue, { expectedDelegate: EXPECTED })).toMatchObject({
      action: "escalate",
      eligible: false,
      reason: expect.stringMatching(/missing execution label/),
    });
  });

  it("escalates conflicting execution labels rather than picking one", () => {
    const issue = eligibleIssue({ labels: ["execution:mac", "execution:cloud"] });
    expect(evaluateLocalDispatch(issue, { expectedDelegate: EXPECTED })).toMatchObject({
      action: "escalate",
      eligible: false,
      reason: expect.stringMatching(/multiple execution labels/),
    });
  });

  it("stays silent (skip, not escalate) on an un-routed issue delegated elsewhere", () => {
    // Not our issue, so not our escalation to raise — writing to it would be
    // the same boundary violation MOV-143 exists to close.
    const issue = eligibleIssue({ labels: [], delegate: HUMAN });
    expect(evaluateLocalDispatch(issue, { expectedDelegate: EXPECTED })).toMatchObject({
      action: "skip",
      eligible: false,
    });
  });

  it("rejects an execution:cloud override on iOS work (route validation still applies)", () => {
    const issue = eligibleIssue({ project: "iOS Companion App", labels: ["execution:cloud"] });
    expect(evaluateLocalDispatch(issue, { expectedDelegate: EXPECTED })).toMatchObject({
      action: "escalate",
      reason: expect.stringMatching(/cannot use execution:cloud/),
    });
  });

  it("is deterministic across repeated evaluations of the same snapshot", () => {
    const issue = eligibleIssue();
    const first = evaluateLocalDispatch(issue, { expectedDelegate: EXPECTED });
    const second = evaluateLocalDispatch(issue, { expectedDelegate: EXPECTED });
    const third = evaluateLocalDispatch({ ...issue }, { expectedDelegate: EXPECTED });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});

describe("confirmStillClaimable", () => {
  const fresh = (overrides = {}) => ({ ...eligibleIssue(), stateName: "Ready for Agent", ...overrides });

  it("confirms an unchanged snapshot", () => {
    expect(confirmStillClaimable(fresh(), { expectedDelegate: EXPECTED })).toEqual({ claimable: true, reason: null });
  });

  it("is a no-op when the delegate was removed after the poll snapshot", () => {
    expect(confirmStillClaimable(fresh({ delegate: null }), { expectedDelegate: EXPECTED })).toMatchObject({
      claimable: false,
      reason: expect.stringMatching(/delegated to nobody/),
    });
  });

  it("is a no-op when the route was removed after the poll snapshot", () => {
    expect(confirmStillClaimable(fresh({ labels: [] }), { expectedDelegate: EXPECTED })).toMatchObject({
      claimable: false,
      reason: expect.stringMatching(/missing execution label/),
    });
  });

  it("is a no-op when the route flipped to cloud after the poll snapshot", () => {
    const flipped = fresh({ project: "Calendar Feed", labels: ["execution:cloud"] });
    expect(confirmStillClaimable(flipped, { expectedDelegate: EXPECTED })).toMatchObject({ claimable: false });
  });

  it("is a no-op when somebody already moved the issue out of Ready for Agent", () => {
    expect(confirmStillClaimable(fresh({ stateName: "Agent Working" }), { expectedDelegate: EXPECTED })).toMatchObject({
      claimable: false,
      reason: expect.stringMatching(/moved to "Agent Working"/),
    });
  });

  it("is a no-op when the issue can no longer be read at all", () => {
    expect(confirmStillClaimable(null, { expectedDelegate: EXPECTED })).toMatchObject({ claimable: false });
  });

  it("tolerates a snapshot with no stateName rather than treating it as a mismatch", () => {
    const { stateName, ...noState } = fresh();
    expect(stateName).toBe("Ready for Agent");
    expect(confirmStillClaimable(noState, { expectedDelegate: EXPECTED })).toEqual({ claimable: true, reason: null });
  });
});

describe("adapter selection", () => {
  const issues = [
    eligibleIssue({ identifier: "MOV-mac" }),
    eligibleIssue({ identifier: "MOV-cloud", project: "Calendar Feed", labels: ["execution:cloud"] }),
    eligibleIssue({ identifier: "MOV-none", labels: ["type:coordination", "execution:none"] }),
    eligibleIssue({ identifier: "MOV-unrouted", labels: [] }),
    eligibleIssue({ identifier: "MOV-other-delegate", delegate: HUMAN }),
  ];

  it("selects only Mac-routed, correctly-delegated issues for the local lane", () => {
    expect(selectLocalCandidates(issues, { expectedDelegate: EXPECTED }).map((i) => i.identifier)).toEqual(["MOV-mac"]);
  });

  it("selects only execution:cloud issues for the cloud lane", () => {
    expect(selectCloudCandidates(issues).map((i) => i.identifier)).toEqual(["MOV-cloud"]);
  });

  it("never puts the same issue in both lanes", () => {
    const local = new Set(selectLocalCandidates(issues, { expectedDelegate: EXPECTED }).map((i) => i.identifier));
    const cloud = selectCloudCandidates(issues).map((i) => i.identifier);
    expect(cloud.filter((id) => local.has(id))).toEqual([]);
  });

  it("does not let an un-materialized cloud inference reach the cloud lane", () => {
    // Inference says "cloud"; no label was ever applied. The label is the only
    // routing authority, so this issue executes nowhere until a human acts.
    const inferredOnly = [eligibleIssue({ identifier: "MOV-inferred", project: "Calendar Feed", labels: [] })];
    expect(selectCloudCandidates(inferredOnly)).toEqual([]);
    expect(selectLocalCandidates(inferredOnly, { expectedDelegate: EXPECTED })).toEqual([]);
  });
});
