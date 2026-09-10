import fs from "node:fs";
import path from "node:path";

export const TERMINAL_PRIORITY_STATE_TYPES = new Set(["completed", "canceled", "duplicate"]);
export const TERMINAL_PRIORITY_STATE_NAMES = new Set(["Done", "Released", "Canceled", "Duplicate"]);
export const NON_WRITABLE_PRIORITY_STATE_NAMES = new Set(["Icebox", "Triage"]);
export const WRITABLE_PRIORITY_STATE_NAMES = new Set([
  "Backlog",
  "Blocked",
  "Spec Ready",
  "Ready for Agent",
  "Agent Working",
  "In Review",
  "Needs Input",
  "Needs Human Decision",
]);

export function rank(priority) {
  return priority === 0 ? Number.POSITIVE_INFINITY : priority;
}

function normalizePriority(priority) {
  return Number.isInteger(priority) && priority >= 0 && priority <= 4 ? priority : 0;
}

function stateType(issue) {
  return typeof issue?.stateType === "string" ? issue.stateType.toLowerCase() : "";
}

function isTerminalIssue(issue) {
  return TERMINAL_PRIORITY_STATE_TYPES.has(stateType(issue)) || TERMINAL_PRIORITY_STATE_NAMES.has(issue?.stateName || "");
}

function isWritableIssue(issue) {
  return WRITABLE_PRIORITY_STATE_NAMES.has(issue?.stateName || "");
}

function moreImportant(a, b) {
  return rank(a) < rank(b);
}

function describeCycle(memberIds, issueById) {
  return memberIds.map((id) => issueById.get(id)?.identifier || id).sort();
}

function analyzePriorityGraph(issues) {
  const issueById = new Map();
  for (const issue of issues) issueById.set(issue.id, issue);

  const nonTerminalIssues = issues.filter((issue) => !isTerminalIssue(issue));
  const nonTerminalById = new Map(nonTerminalIssues.map((issue) => [issue.id, issue]));
  const adjacency = new Map(nonTerminalIssues.map((issue) => [issue.id, new Set()]));

  for (const issue of nonTerminalIssues) {
    for (const relation of issue.relations || []) {
      if (relation?.type !== "blocks") continue;
      const downstreamId = relation?.relatedIssue?.id;
      if (!downstreamId) continue;
      if (!nonTerminalById.has(downstreamId)) continue;
      adjacency.get(issue.id).add(downstreamId);
    }
  }

  const indexById = new Map();
  const lowlinkById = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let index = 0;

  function strongConnect(id) {
    indexById.set(id, index);
    lowlinkById.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);

    for (const downstreamId of adjacency.get(id)) {
      if (!indexById.has(downstreamId)) {
        strongConnect(downstreamId);
        lowlinkById.set(id, Math.min(lowlinkById.get(id), lowlinkById.get(downstreamId)));
      } else if (onStack.has(downstreamId)) {
        lowlinkById.set(id, Math.min(lowlinkById.get(id), indexById.get(downstreamId)));
      }
    }

    if (lowlinkById.get(id) === indexById.get(id)) {
      const members = [];
      let popped;
      do {
        popped = stack.pop();
        onStack.delete(popped);
        members.push(popped);
      } while (popped !== id);
      components.push(members);
    }
  }

  for (const issue of nonTerminalIssues) {
    if (!indexById.has(issue.id)) strongConnect(issue.id);
  }

  const componentIndexById = new Map();
  components.forEach((members, componentIndex) => {
    for (const member of members) componentIndexById.set(member, componentIndex);
  });

  const componentEdges = components.map(() => new Set());
  components.forEach((members, fromComponent) => {
    for (const member of members) {
      for (const downstreamId of adjacency.get(member)) {
        const toComponent = componentIndexById.get(downstreamId);
        if (toComponent !== fromComponent) componentEdges[fromComponent].add(toComponent);
      }
    }
  });

  const cycles = [];
  components.forEach((members) => {
    if (members.length > 1) {
      cycles.push(describeCycle(members, issueById));
      return;
    }
    const [id] = members;
    if (adjacency.get(id)?.has(id)) cycles.push(describeCycle(members, issueById));
  });

  const bestSelfByComponent = components.map((members) => {
    let bestPriority = 0;
    let driverId = members[0];
    for (const memberId of members) {
      const currentPriority = normalizePriority(nonTerminalById.get(memberId)?.priority);
      if (moreImportant(currentPriority, bestPriority)) {
        bestPriority = currentPriority;
        driverId = memberId;
      }
    }
    return { priority: bestPriority, driverId };
  });

  const memo = new Map();
  function bestForComponent(componentIndex) {
    if (memo.has(componentIndex)) return memo.get(componentIndex);
    let best = bestSelfByComponent[componentIndex];
    for (const childIndex of componentEdges[componentIndex]) {
      const childBest = bestForComponent(childIndex);
      if (moreImportant(childBest.priority, best.priority)) best = childBest;
    }
    memo.set(componentIndex, best);
    return best;
  }

  const effectiveById = new Map();
  const driverById = new Map();

  for (const issue of issues) {
    const currentPriority = normalizePriority(issue.priority);
    if (isTerminalIssue(issue) || !nonTerminalById.has(issue.id)) {
      effectiveById.set(issue.id, currentPriority);
      driverById.set(issue.id, issue.id);
      continue;
    }
    const best = bestForComponent(componentIndexById.get(issue.id));
    effectiveById.set(issue.id, best.priority);
    driverById.set(issue.id, best.driverId);
  }

  return { effectiveById, driverById, cycles };
}

export function computeEffectivePriorities(issues) {
  return analyzePriorityGraph(issues).effectiveById;
}

function loadPropagationState(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const clean = {};
  for (const [issueId, value] of Object.entries(parsed)) {
    const normalized = normalizePriority(value);
    clean[issueId] = normalized;
  }
  return clean;
}

function savePropagationState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tempPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
}

function priorityLabel(priority) {
  return (
    {
      1: "Urgent",
      2: "High",
      3: "Medium",
      4: "Low",
      0: "No priority",
    }[priority] || "No priority"
  );
}

/**
 * @param {object[]} issues
 * @param {object} ctx
 * @param {object} ctx.linearClient
 * @param {string} ctx.stateFilePath
 * @param {boolean} [ctx.dryRun]
 * @param {{log?: Function, warn?: Function}} [ctx.logger]
 */
export async function propagatePriorities(issues, ctx) {
  const { linearClient, stateFilePath, dryRun = false, logger = console } = ctx;
  const { effectiveById, driverById, cycles } = analyzePriorityGraph(issues);
  const previousState = loadPropagationState(stateFilePath);
  const nextState = {};
  const updates = [];
  const skipped = [];

  for (const cycle of cycles) {
    (logger.warn || logger.log || (() => {})).call(logger, `Priority propagation cycle detected: ${cycle.join(" -> ")}`);
  }

  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  for (const issue of issues) {
    if (isTerminalIssue(issue) || !isWritableIssue(issue)) continue;

    const current = normalizePriority(issue.priority);
    const effective = normalizePriority(effectiveById.get(issue.id));
    const recorded = Object.prototype.hasOwnProperty.call(previousState, issue.id)
      ? normalizePriority(previousState[issue.id])
      : null;

    const bootstrapOwned = recorded === null && current === effective;
    const ownedByPropagation = (recorded !== null && current === recorded) || bootstrapOwned;
    const desired = ownedByPropagation ? effective : (moreImportant(effective, current) ? effective : current);

    const manualMismatch = recorded !== null && current !== recorded;
    if (manualMismatch) nextState[issue.id] = current;
    else nextState[issue.id] = desired;

    if (desired === current) continue;

    const action = moreImportant(desired, current) ? "raised" : "relaxed";
    const driverId = driverById.get(issue.id) || issue.id;
    const driverIssue = issueById.get(driverId);
    updates.push({
      issueId: issue.id,
      identifier: issue.identifier,
      from: current,
      to: desired,
      action,
      driverIdentifier: driverIssue?.identifier || driverId,
    });
  }

  for (const issue of issues) {
    if (isTerminalIssue(issue)) continue;
    if (!NON_WRITABLE_PRIORITY_STATE_NAMES.has(issue.stateName || "")) continue;
    const current = normalizePriority(issue.priority);
    const effective = normalizePriority(effectiveById.get(issue.id));
    if (!moreImportant(effective, current)) continue;
    const driverId = driverById.get(issue.id) || issue.id;
    const driverIssue = issueById.get(driverId);
    const detail = `${issue.identifier} (${issue.stateName}) blocks ${priorityLabel(effective)} ${driverIssue?.identifier || driverId} — not auto-raising, review`;
    skipped.push({
      issueId: issue.id,
      identifier: issue.identifier,
      stateName: issue.stateName,
      from: current,
      to: effective,
      driverIdentifier: driverIssue?.identifier || driverId,
      message: detail,
    });
    (logger.log || (() => {})).call(logger, detail);
  }

  if (!dryRun) {
    for (const update of updates) {
      await linearClient.updateIssuePriority(update.issueId, update.to);
    }
    savePropagationState(stateFilePath, nextState);
  }

  return {
    updates,
    skipped,
    cycles,
    wrote: !dryRun ? updates.length : 0,
  };
}
