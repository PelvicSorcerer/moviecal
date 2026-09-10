// Adapter-claim eligibility (MOV-143).
//
// MOV-142 provisioned the `execution:{cloud,mac,none}` label group plus its
// inference and validation, but wired it into exactly one behaviour (the
// promoter skipping coordination issues). This module turns it into the gate
// the local Mac dispatcher actually claims work through, and adds the second
// half of the boundary `AGENTS.md` and `docs/operators/local-execution.md`
// have always described but nothing enforced: the issue must also be
// **delegated** to `moviecal-dispatcher`.
//
// Two independent conditions, both required, deliberately not collapsed:
//
//   route     — WHICH adapter may execute an issue. The single routing
//               authority is the materialized `execution:*` label on the
//               Linear issue; inference (`inferExecutionRoute`) is advisory
//               and never satisfies the gate on its own.
//   delegate  — WHO may write to that issue's lifecycle. The single local
//               dispatcher writer is the `moviecal-dispatcher` actor named in
//               Linear's `delegate` field.
//
// **A workflow-state change is not a claim.** Moving an issue to `Agent
// Working` is a *report* that work started, not a lock that says it may:
// Linear's API offers no compare-and-set on workflow state, so two pollers can
// both "win" that transition and neither learns it lost. Exclusivity comes
// from exactly one route and one delegate naming exactly one executor, and —
// within the Mac lane — from the worktree path already being taken
// (`preflight.mjs`). Never add logic that infers exclusivity from a state
// transition having succeeded.
//
// Pure decision logic only; all I/O is the caller's (run-loop.mjs,
// bin/dispatcher.mjs), so every rule here is unit-testable with plain objects.

import { resolveExecutionRoute } from "./execution-routing.mjs";

/** The one identity permitted to drive an issue through the local Mac adapter. */
export const LOCAL_DISPATCHER_DELEGATE = "moviecal-dispatcher";
export const MAC_ROUTE = "mac";
export const CLOUD_ROUTE = "cloud";
/** The only workflow state the dispatcher dispatches from. */
export const DISPATCH_STATE = "Ready for Agent";

function trimmed(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Normalize Linear's `delegate` (a `User`/agent node, or null when the issue
 * is delegated to nobody) into `{ id, name, displayName }`, or `null`. Linear
 * returns `delegate: null` for the overwhelmingly common undelegated case, and
 * omits the field entirely on any snapshot fetched before MOV-143 added it to
 * the selection — both must read as "no delegate", never as a match.
 */
export function normalizeDelegate(node) {
  if (!node || typeof node !== "object") return null;
  const id = trimmed(node.id);
  const name = trimmed(node.name);
  const displayName = trimmed(node.displayName);
  if (!id && !name && !displayName) return null;
  return { id, name, displayName };
}

/** Human-readable delegate label for Linear comments and dry-run output. */
export function describeDelegate(delegate) {
  if (!delegate) return "nobody";
  return delegate.name || delegate.displayName || delegate.id;
}

/**
 * Does `delegate` identify this dispatcher?
 *
 * The dispatcher's identity is a *set* of acceptable identifiers — the
 * configured actor id (`LINEAR_APP_ACTOR_ID`, MOV-122) and the app's workspace
 * name — and a delegate matching any of them qualifies. Requiring the id alone
 * looked stricter and is wrong in practice: the installed `linear-app.env`
 * records `LINEAR_APP_ACTOR_ID` as the app *name*, not the UUID Linear returns
 * in `delegate.id`, so an id-only rule would reject every correctly delegated
 * issue and silently stop all dispatch. (Confirmed by running `dispatcher
 * dry-run` against a routing fixture.)
 *
 * The residual looseness — a workspace member could create a user literally
 * named `moviecal-dispatcher` — is accepted deliberately. This gate exists to
 * stop two *adapters* claiming the same issue, not to defend against a hostile
 * workspace admin, who could re-delegate any issue to the real dispatcher
 * anyway. Setting `LINEAR_APP_ACTOR_ID` to the actual actor UUID tightens it:
 * the id then matches on its own and the name is only a fallback.
 *
 * @param {{id: string|null, name: string|null, displayName: string|null}|null} delegate
 * @param {{id?: string|null, name?: string|null}} [expected]
 */
export function isLocalDispatcherDelegate(delegate, expected = {}) {
  if (!delegate) return false;
  const expectedId = trimmed(expected && expected.id);
  if (expectedId && delegate.id === expectedId) return true;
  const expectedName = (trimmed(expected && expected.name) || LOCAL_DISPATCHER_DELEGATE).toLowerCase();
  return [delegate.name, delegate.displayName]
    .filter(Boolean)
    .some((candidate) => candidate.toLowerCase() === expectedName);
}

function verdict(action, reason, route, delegate) {
  return { action, eligible: action === "dispatch", reason, route, delegate };
}

/**
 * Why a delegate isn't this dispatcher, naming every identifier that would
 * have qualified. The identifiers matter in the message: without them, an
 * issue delegated to a *different* actor sharing the name would report
 * "delegated to moviecal-dispatcher, not moviecal-dispatcher" — which reads as
 * a bug in the dispatcher rather than a misdelegated issue.
 */
function explainDelegateMismatch(delegate, expected = {}) {
  const expectedId = trimmed(expected && expected.id);
  const expectedName = trimmed(expected && expected.name) || LOCAL_DISPATCHER_DELEGATE;
  const wanted =
    expectedId && expectedId !== expectedName ? `${expectedName} (actor ${expectedId})` : expectedName;
  if (!delegate) {
    return `delegated to nobody, not ${wanted}`;
  }
  const actual = delegate.id ? `${describeDelegate(delegate)} (actor ${delegate.id})` : describeDelegate(delegate);
  return `delegated to ${actual}, not ${wanted}`;
}

/**
 * May the local Mac dispatcher claim this issue?
 *
 * Three outcomes, and the difference between the two rejections matters:
 *
 * - `dispatch` — Mac-routed and delegated here. Proceed to preflight.
 * - `skip`     — someone else's issue (cloud-routed, coordination-only, or
 *                delegated elsewhere). The dispatcher writes **nothing**: it
 *                is not this issue's writer, and commenting on every poll
 *                cycle would be both noise and a boundary violation.
 * - `escalate` — delegated here, so this dispatcher *is* the writer, but the
 *                route is missing/conflicting/self-contradictory and no
 *                adapter can safely run it. A human decides; the escalating
 *                state change also takes it out of `Ready for Agent`, so the
 *                next poll does not see it again.
 *
 * @param {{labels?: string[], project?: string|null, title?: string, description?: string, delegate?: object|null}} issue
 * @param {{expectedDelegate?: {id?: string|null, name?: string|null}}} [opts]
 */
export function evaluateLocalDispatch(issue = {}, { expectedDelegate = {} } = {}) {
  const delegate = normalizeDelegate(issue.delegate);
  const delegated = isLocalDispatcherDelegate(delegate, expectedDelegate);
  const execution = resolveExecutionRoute(issue);

  if (!execution.ok) {
    const reason = `unusable execution route — ${execution.reason}`;
    return verdict(delegated ? "escalate" : "skip", reason, execution.route, delegate);
  }
  if (execution.route !== MAC_ROUTE) {
    return verdict(
      "skip",
      `routed to execution:${execution.route}, which the local Mac adapter does not execute`,
      execution.route,
      delegate,
    );
  }
  if (!delegated) {
    return verdict("skip", explainDelegateMismatch(delegate, expectedDelegate), execution.route, delegate);
  }
  return verdict("dispatch", null, execution.route, delegate);
}

/**
 * Re-check a **freshly read** snapshot immediately before the dispatcher
 * commits to an issue (creates the worktree, moves it to `Agent Working`).
 *
 * Routing and delegation are ordinary Linear fields a human can change at any
 * moment, including between the poll that produced the batch and this point.
 * Losing that race must be a safe no-op — no worktree, no state change, no
 * comment — not a half-claim, and the issue simply reappears in the next poll
 * if it becomes eligible again. This is also why the dispatcher re-reads
 * rather than trusting that its own earlier state move implied a claim.
 *
 * @param {object|null|undefined} fresh - re-read snapshot, or null if the
 *   issue is gone/unreadable
 * @param {{expectedDelegate?: object, expectedState?: string|null}} [opts]
 * @returns {{claimable: boolean, reason: string|null}}
 */
export function confirmStillClaimable(fresh, { expectedDelegate = {}, expectedState = DISPATCH_STATE } = {}) {
  if (!fresh) {
    return { claimable: false, reason: "issue is no longer readable from Linear" };
  }
  if (expectedState && fresh.stateName && fresh.stateName !== expectedState) {
    return { claimable: false, reason: `issue moved to "${fresh.stateName}" before the worker started` };
  }
  const result = evaluateLocalDispatch(fresh, { expectedDelegate });
  if (!result.eligible) {
    return { claimable: false, reason: result.reason };
  }
  return { claimable: true, reason: null };
}

/** Issues the local Mac adapter may claim, in input order. */
export function selectLocalCandidates(issues = [], opts = {}) {
  return issues.filter((issue) => evaluateLocalDispatch(issue, opts).eligible);
}

/**
 * Issues the cloud adapter may claim: a valid, **materialized**
 * `execution:cloud` route and nothing else. Deliberately symmetric with
 * `selectLocalCandidates` and deliberately not delegation-aware — the cloud
 * lane is not built yet (`docs/governance/hybrid-execution-architecture.md`
 * §Rollout gates, stage 7), and this exists so that when it is, it cannot
 * quietly inherit the Mac lane's "claim anything in Ready for Agent"
 * behaviour that MOV-143 removed. A cloud lane must add its own writer
 * identity check on top of this.
 */
export function selectCloudCandidates(issues = []) {
  return issues.filter((issue) => {
    const execution = resolveExecutionRoute(issue);
    return execution.ok && execution.route === CLOUD_ROUTE;
  });
}
