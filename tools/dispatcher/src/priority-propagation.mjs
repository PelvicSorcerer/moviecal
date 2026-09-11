import fs from "node:fs";
import path from "node:path";
import { COMPLETED_BLOCKER_STATE_NAMES } from "./dependency-gate.mjs";

export const TERMINAL_PRIORITY_STATE_TYPES = new Set(["completed", "canceled", "duplicate"]);
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
  return TERMINAL_PRIORITY_STATE_TYPES.has(stateType(issue)) || COMPLETED_BLOCKER_STATE_NAMES.has(issue?.stateName || "");
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

function compareStateEntries(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.lastPropagated === b.lastPropagated && a.manualFloor === b.manualFloor;
}

function statesEqual(a, b) {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!compareStateEntries(a[aKeys[i]], b[bKeys[i]])) return false;
  }
  return true;
}

function connectedComponents(adjacency) {
  const ids = Array.from(adjacency.keys());
  const visited = new Set();
  const finishOrder = [];

  for (const startId of ids) {
    if (visited.has(startId)) continue;
    const stack = [{ id: startId, entered: false }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame.entered) {
        if (visited.has(frame.id)) continue;
        visited.add(frame.id);
        stack.push({ id: frame.id, entered: true });
        for (const childId of adjacency.get(frame.id) || []) {
          if (!visited.has(childId)) stack.push({ id: childId, entered: false });
        }
      } else {
        finishOrder.push(frame.id);
      }
    }
  }

  const reverseAdjacency = new Map(ids.map((id) => [id, new Set()]));
  for (const [id, children] of adjacency.entries()) {
    for (const childId of children) {
      if (!reverseAdjacency.has(childId)) reverseAdjacency.set(childId, new Set());
      reverseAdjacency.get(childId).add(id);
    }
  }

  const assigned = new Set();
  const components = [];
  for (let i = finishOrder.length - 1; i >= 0; i--) {
    const startId = finishOrder[i];
    if (assigned.has(startId)) continue;
    const members = [];
    const stack = [startId];
    assigned.add(startId);
    while (stack.length > 0) {
      const id = stack.pop();
      members.push(id);
      for (const parentId of reverseAdjacency.get(id) || []) {
        if (assigned.has(parentId)) continue;
        assigned.add(parentId);
        stack.push(parentId);
      }
    }
    components.push(members);
  }

  return components;
}

function componentBestValues({ components, componentEdges, bestSelfByComponent }) {
  const indegree = new Array(components.length).fill(0);
  for (let from = 0; from < componentEdges.length; from++) {
    for (const to of componentEdges[from]) indegree[to] += 1;
  }

  const queue = [];
  for (let i = 0; i < indegree.length; i++) {
    if (indegree[i] === 0) queue.push(i);
  }

  const topo = [];
  let queueHead = 0;
  while (queueHead < queue.length) {
    const index = queue[queueHead++];
    topo.push(index);
    for (const childIndex of componentEdges[index]) {
      indegree[childIndex] -= 1;
      if (indegree[childIndex] === 0) queue.push(childIndex);
    }
  }

  if (topo.length !== components.length) {
    const seen = new Array(components.length).fill(false);
    for (const idx of topo) seen[idx] = true;
    for (let i = 0; i < components.length; i++) {
      if (!seen[i]) topo.push(i);
    }
  }

  const bestByComponent = bestSelfByComponent.map((x) => ({ ...x }));
  for (let i = topo.length - 1; i >= 0; i--) {
    const index = topo[i];
    let best = bestByComponent[index];
    for (const childIndex of componentEdges[index]) {
      const childBest = bestByComponent[childIndex];
      if (
        moreImportant(childBest.priority, best.priority) ||
        (childBest.priority === best.priority && childBest.driverId !== best.driverId)
      ) {
        best = childBest;
      }
    }
    bestByComponent[index] = best;
  }
  return bestByComponent;
}

function analyzePriorityGraph(issues, priorityById = null) {
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

  const components = connectedComponents(adjacency);

  const componentIndexById = new Map();
  components.forEach((members, componentIndex) => {
    for (const member of members) componentIndexById.set(member, componentIndex);
  });

  const componentEdges = components.map(() => new Set());
  components.forEach((members, fromComponent) => {
    for (const member of members) {
      for (const downstreamId of adjacency.get(member) || []) {
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
      const currentPriority = normalizePriority(
        priorityById && priorityById.has(memberId)
          ? priorityById.get(memberId)
          : nonTerminalById.get(memberId)?.priority,
      );
      if (moreImportant(currentPriority, bestPriority)) {
        bestPriority = currentPriority;
        driverId = memberId;
      }
    }
    return { priority: bestPriority, driverId };
  });

  const bestByComponent = componentBestValues({ components, componentEdges, bestSelfByComponent });

  const effectiveById = new Map();
  const driverById = new Map();

  for (const issue of issues) {
    const currentPriority = normalizePriority(issue.priority);
    if (isTerminalIssue(issue) || !nonTerminalById.has(issue.id)) {
      effectiveById.set(issue.id, currentPriority);
      driverById.set(issue.id, issue.id);
      continue;
    }
    const best = bestByComponent[componentIndexById.get(issue.id)];
    effectiveById.set(issue.id, best.priority);
    driverById.set(issue.id, best.driverId);
  }

  return { effectiveById, driverById, cycles };
}

export function computeEffectivePriorities(issues) {
  return analyzePriorityGraph(issues).effectiveById;
}

function defaultStateEntry(priority) {
  const normalized = normalizePriority(priority);
  return { lastPropagated: normalized, manualFloor: normalized };
}

function parseStateEntry(value) {
  if (typeof value === "number") return defaultStateEntry(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lastPropagated = normalizePriority(value.lastPropagated);
  const manualFloor = normalizePriority(value.manualFloor);
  return { lastPropagated, manualFloor };
}

function statOrNull(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function repairPermissions(filePath) {
  const dirPath = path.dirname(filePath);
  const dirStat = statOrNull(dirPath);
  if (dirStat && (dirStat.mode & 0o077)) {
    fs.chmodSync(dirPath, 0o700);
    if (fs.statSync(dirPath).mode & 0o077) {
      throw new Error(`priority propagation state directory must be mode 700: ${dirPath}`);
    }
  }
  const fileStat = statOrNull(filePath);
  if (fileStat && (fileStat.mode & 0o077)) {
    fs.chmodSync(filePath, 0o600);
    if (fs.statSync(filePath).mode & 0o077) {
      throw new Error(`priority propagation state file must be mode 600: ${filePath}`);
    }
  }
}

function loadPropagationState(filePath, { repair = true } = {}) {
  if (!filePath) return {};
  if (repair) repairPermissions(filePath);
  if (!filePath || !fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const clean = {};
  for (const [issueId, value] of Object.entries(parsed)) {
    const entry = parseStateEntry(value);
    if (!entry) continue;
    clean[issueId] = entry;
  }
  return clean;
}

function savePropagationState(filePath, state) {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
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
  repairPermissions(filePath);
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

function orderUpdates(updates) {
  const byId = new Map(updates.map((u) => [u.issueId, u]));
  const dependents = new Map(updates.map((u) => [u.issueId, new Set()]));
  const indegree = new Map(updates.map((u) => [u.issueId, 0]));

  for (const update of updates) {
    if (!update.driverId || update.driverId === update.issueId) continue;
    if (!byId.has(update.driverId)) continue;
    dependents.get(update.driverId).add(update.issueId);
    indegree.set(update.issueId, (indegree.get(update.issueId) || 0) + 1);
  }

  const queue = updates.filter((u) => (indegree.get(u.issueId) || 0) === 0);

  const ordered = [];
  let queueHead = 0;
  while (queueHead < queue.length) {
    const current = queue[queueHead++];
    ordered.push(current);
    for (const childId of dependents.get(current.issueId) || []) {
      indegree.set(childId, (indegree.get(childId) || 0) - 1);
      if ((indegree.get(childId) || 0) === 0) queue.push(byId.get(childId));
    }
  }

  if (ordered.length === updates.length) return ordered;
  const seen = new Set(ordered.map((u) => u.issueId));
  return [...ordered, ...updates.filter((u) => !seen.has(u.issueId))];
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
  const previousState = loadPropagationState(stateFilePath, { repair: !dryRun });

  const baselinePriorityById = new Map();
  for (const issue of issues) {
    const entry = previousState[issue.id];
    const current = normalizePriority(issue.priority);
    const owns = entry && current === entry.lastPropagated;
    baselinePriorityById.set(issue.id, owns ? entry.manualFloor : current);
  }

  const { effectiveById, driverById, cycles } = analyzePriorityGraph(issues, baselinePriorityById);
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
    const recorded = previousState[issue.id] || null;

    const ownedByPropagation = Boolean(recorded) && current === recorded.lastPropagated;
    const manualFloor = ownedByPropagation ? recorded.manualFloor : current;
    const desired = ownedByPropagation
      ? effective
      : (moreImportant(effective, current) ? effective : current);

    const stateOnSuccess = ownedByPropagation
      ? { lastPropagated: desired, manualFloor }
      : { lastPropagated: desired, manualFloor: current };
    const stateOnFailure = ownedByPropagation
      ? recorded
      : { lastPropagated: current, manualFloor: current };
    nextState[issue.id] = desired === current ? stateOnSuccess : stateOnFailure;

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
      driverId,
      driverIdentifier: driverIssue?.identifier || driverId,
      stateOnSuccess,
      stateOnFailure,
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
    let wrote = 0;
    const failedIssueIds = new Set();
    const orderedUpdates = orderUpdates(updates);

    for (const update of orderedUpdates) {
      if (update.driverId && update.driverId !== update.issueId && failedIssueIds.has(update.driverId)) {
        nextState[update.issueId] = update.stateOnFailure;
        (logger.warn || logger.log || (() => {})).call(
          logger,
          `${update.identifier}: skipped priority update ${update.from} -> ${update.to} because driver ${update.driverIdentifier} failed to update`,
        );
        continue;
      }

      try {
        const ok = await linearClient.updateIssuePriority(update.issueId, update.to);
        if (!ok) {
          nextState[update.issueId] = update.stateOnFailure;
          failedIssueIds.add(update.issueId);
          (logger.warn || logger.log || (() => {})).call(
            logger,
            `${update.identifier}: failed to apply priority update ${update.from} -> ${update.to}; preserving previous ownership state`,
          );
        } else {
          nextState[update.issueId] = update.stateOnSuccess;
          wrote += 1;
        }
      } catch (err) {
        nextState[update.issueId] = update.stateOnFailure;
        failedIssueIds.add(update.issueId);
        (logger.warn || logger.log || (() => {})).call(
          logger,
          `${update.identifier}: failed to apply priority update ${update.from} -> ${update.to} (${err.message}); preserving previous ownership state`,
        );
      }
    }

    if (!statesEqual(previousState, nextState)) savePropagationState(stateFilePath, nextState);

    return {
      updates,
      skipped,
      cycles,
      wrote,
    };
  }

  return {
    updates,
    skipped,
    cycles,
    wrote: 0,
  };
}
