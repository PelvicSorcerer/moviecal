// Terminal-issue worktree retention and safe cleanup (MOV-417).
//
// `WorktreeManager.gc()` only knows worktrees recorded in worktrees.json. This
// module inventories every MovieCal Git worktree under the configured roots
// (dispatcher, interactive, and Codex-managed layouts), decides -- from current
// Linear state -- which linked checkouts belong to a Done/Canceled issue whose
// seven-day retention has elapsed, and removes only those, after preserving any
// recoverable local work in named local Git refs.
//
// Fail-closed throughout: an unknown or ambiguous identity, a Linear failure, a
// missing timestamp, a live user of the path, or an integrity/preservation
// failure all yield a `skipped` result and never a deletion. A preview result
// never authorizes a removal: every deletion re-reads Linear and re-inspects
// the live worktree immediately beforehand.
//
// All Git work goes through the injectable `runner` (same contract as
// worktree-manager.mjs) so the decision logic is unit-testable.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { defaultRunner } from "./worktree-manager.mjs";

export const DEFAULT_RETENTION_DAYS = 7;
export const RECOVERY_REF_PREFIX = "refs/moviecal/recovery";
const DAY_MS = 24 * 60 * 60 * 1000;
const NULL_SHA = "0".repeat(40);

/** Ignored paths safe to delete because a checkout/build regenerates them. */
const REGENERABLE_BASENAMES = new Set([
  "node_modules", ".next", ".turbo", "coverage", "playwright-report", "test-results",
  "dist", "build", "out", "DerivedData", "next-env.d.ts", ".DS_Store",
]);
const CREDENTIAL_PATTERNS = [
  /^\.env(\..+)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /^id_(rsa|ed25519|ecdsa)/i, /^\.npmrc$/i, /^credentials.*\.json$/i,
];
const CREDENTIAL_ALLOWED = new Set([".env.example"]);

export function isCredentialLikePath(p) {
  const base = path.posix.basename(String(p).replace(/\/+$/, ""));
  return !CREDENTIAL_ALLOWED.has(base) && CREDENTIAL_PATTERNS.some((re) => re.test(base));
}

/**
 * `.env.local` is regenerable only as the dispatcher's own symlink to the
 * shared env file; a real file may hold hand-written credentials.
 */
function isRegenerableIgnored(worktreePath, relPath) {
  const trimmed = relPath.replace(/\/+$/, "");
  const base = path.posix.basename(trimmed);
  if (base === ".env.local") {
    try { return fs.lstatSync(path.join(worktreePath, trimmed)).isSymbolicLink(); } catch { return false; }
  }
  // Ignored files are listed individually, so a regenerable directory anywhere
  // in the path (e.g. node_modules/pkg/index.js) qualifies its contents.
  return trimmed.split("/").some((seg) => REGENERABLE_BASENAMES.has(seg)) || base.endsWith(".tsbuildinfo");
}

// ---- identity -------------------------------------------------------------

const ISSUE_IN_NAME = /(?<![A-Za-z0-9])MOV-(\d+)(?!\d)/gi;
const ISSUE_BRANCH = /^agent\/MOV-(\d+)(?:-[A-Za-z0-9._-]+)?$/;

/**
 * Which Linear issue owns a worktree. A `MOV-NNN` in the directory name wins;
 * without one, an exact issue-scoped branch or the dispatcher registry record
 * for that exact path may decide. Sources that name different issues are
 * ambiguous. Commit messages and a shared HEAD are never consulted.
 */
export function resolveIssueIdentity({ worktreePath, branch = null, registryEntry = null }) {
  const nameIds = [...new Set([...path.basename(worktreePath).matchAll(ISSUE_IN_NAME)].map((m) => `MOV-${Number(m[1])}`))];
  const branchMatch = branch ? ISSUE_BRANCH.exec(branch) : null;
  const branchId = branchMatch ? `MOV-${Number(branchMatch[1])}` : null;
  const registryMatch = registryEntry && /^MOV-(\d+)$/.exec(String(registryEntry.id || ""));
  const registryId = registryMatch ? `MOV-${Number(registryMatch[1])}` : null;

  if (nameIds.length > 1) {
    return { issueId: null, source: null, ambiguous: true, reason: `directory name names several issues (${nameIds.join(", ")})` };
  }
  const named = [
    nameIds[0] && ["directory-name", nameIds[0]],
    branchId && ["branch", branchId],
    registryId && ["registry", registryId],
  ].filter(Boolean);
  const distinct = [...new Set(named.map(([, id]) => id))];
  if (distinct.length > 1) {
    return {
      issueId: null, source: null, ambiguous: true,
      reason: `identity sources disagree (${named.map(([s, id]) => `${s}=${id}`).join(", ")})`,
    };
  }
  if (named.length === 0) return { issueId: null, source: null, ambiguous: false, reason: "no issue identifier in directory name, branch, or registry" };
  return { issueId: named[0][1], source: named[0][0], ambiguous: false, reason: null, evidence: named.map(([s]) => s) };
}

// ---- Linear terminal state ------------------------------------------------

/**
 * Turn a Linear snapshot into a retention verdict. Only the workflow states
 * `Done` (completed) and `Canceled` (canceled) count; the eligibility clock is
 * that state's own current timestamp. Anything missing, invalid, or in the
 * future is `unknown`, never terminal.
 */
export function evaluateTerminalState(snapshot, { expectedId, now = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS }) {
  if (!snapshot) return { verdict: "unknown", reason: "Linear issue not found" };
  if (snapshot.identifier !== expectedId) {
    return { verdict: "unknown", reason: `Linear returned ${snapshot.identifier} for ${expectedId}` };
  }
  const linearStatus = snapshot.stateName || null;
  const kind = linearStatus === "Done" && snapshot.stateType === "completed" ? "completed"
    : linearStatus === "Canceled" && snapshot.stateType === "canceled" ? "canceled" : null;
  if (!kind) return { verdict: "active", linearStatus, reason: `issue is ${linearStatus || "in an unknown state"}, not Done or Canceled` };

  const field = kind === "completed" ? "completedAt" : "canceledAt";
  const other = kind === "completed" ? "canceledAt" : "completedAt";
  const terminalMs = Date.parse(snapshot[field] || "");
  if (!snapshot[field] || !Number.isFinite(terminalMs) || terminalMs > now) {
    return { verdict: "unknown", linearStatus, reason: `missing or invalid Linear ${field}` };
  }
  const otherMs = snapshot[other] ? Date.parse(snapshot[other]) : NaN;
  if (snapshot[other] && (!Number.isFinite(otherMs) || otherMs > terminalMs)) {
    return { verdict: "unknown", linearStatus, reason: `conflicting Linear ${other}` };
  }
  const eligibleMs = terminalMs + retentionDays * DAY_MS;
  return {
    verdict: "terminal",
    linearStatus,
    terminalAt: new Date(terminalMs).toISOString(),
    eligibleAt: new Date(eligibleMs).toISOString(),
    eligible: now >= eligibleMs,
  };
}

// ---- Git helpers ----------------------------------------------------------

const READ_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

function parseWorktreePorcelain(text) {
  const entries = [];
  let cur = null;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), head: null, branch: null, locked: false, prunable: false };
      entries.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch refs/heads/")) cur.branch = line.slice(18);
    else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
    else if (line === "") cur = null;
  }
  return entries;
}

function real(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** Real path of a possibly-missing path: resolve the deepest existing ancestor. */
function realLoose(p) {
  const abs = path.resolve(p);
  let head = abs;
  const tail = [];
  while (!fs.existsSync(head) && path.dirname(head) !== head) { tail.unshift(path.basename(head)); head = path.dirname(head); }
  return path.join(real(head), ...tail);
}

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Parse `git status --porcelain=v1 -z --ignored=traditional --untracked-files=all`. */
export function parseStatusZ(out) {
  const tokens = String(out || "").split("\0");
  const res = { staged: [], unstaged: [], untracked: [], unmerged: [], ignored: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.length < 4) continue;
    const x = t[0];
    const y = t[1];
    const file = t.slice(3);
    if (x === "R" || x === "C") i += 1; // the following token is the rename origin
    if (x === "!" && y === "!") res.ignored.push(file);
    else if (x === "?" && y === "?") res.untracked.push(file);
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) res.unmerged.push(file);
    else {
      if (x !== " ") res.staged.push(file);
      if (y !== " ") res.unstaged.push(file);
    }
  }
  return res;
}

export class WorktreeRetention {
  /**
   * @param {object} o
   * @param {string} o.repoRoot        primary checkout (never removed)
   * @param {string[]} o.roots         configured worktree roots
   * @param {string[]} [o.excludedPaths] extra never-delete checkouts (dispatcher daemon)
   * @param {object} o.registry        WorktreeManager (loadState/saveState) for ownership + records
   * @param {(id:string)=>Promise<object|null>} o.fetchIssue  Linear terminal snapshot; may throw
   * @param {string} o.recoveryDir     where recovery records are written
   * @param {number} [o.retentionDays]
   * @param {()=>number} [o.now]
   * @param {(pid:number)=>boolean} [o.isPidAlive]
   * @param {(p:string)=>boolean|null} [o.pathInUse]  true=in use, false=free, null=unknown
   * @param {(id:string)=>boolean} [o.hasPendingContinuation]
   */
  constructor({
    repoRoot, roots, excludedPaths = [], registry, fetchIssue, recoveryDir,
    retentionDays = DEFAULT_RETENTION_DAYS, now = () => Date.now(), runner = defaultRunner,
    isPidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } },
    pathInUse = defaultPathInUse, hasPendingContinuation = () => false, selfPaths = [process.cwd()],
  } = {}) {
    if (!repoRoot || !registry || !fetchIssue || !recoveryDir) throw new Error("repoRoot, registry, fetchIssue and recoveryDir are required");
    if (!(retentionDays > 0) || !Number.isFinite(retentionDays)) throw new Error("retentionDays must be a positive number");
    Object.assign(this, { repoRoot, registry, fetchIssue, recoveryDir, retentionDays, now, runner, isPidAlive, pathInUse, hasPendingContinuation });
    this.roots = roots.map(real);
    this.excluded = excludedPaths.map(realLoose);
    this.selfPaths = selfPaths.map(real);
  }

  _git(cwd, args, { env, input } = {}) {
    return String(this.runner("git", args, { cwd, env: env ? { ...process.env, ...env } : READ_ENV, ...(input ? { input } : {}) }));
  }

  /** Every Git-registered worktree of this repository, primary first. */
  listWorktrees() {
    return parseWorktreePorcelain(this._git(this.repoRoot, ["worktree", "list", "--porcelain"]));
  }

  // ---- inventory ----------------------------------------------------------

  /**
   * Candidate list: every linked worktree Git knows, plus registry records
   * whose checkout is gone and which Git no longer lists.
   */
  inventory() {
    const listed = this.listWorktrees();
    const primary = listed.length ? real(listed[0].path) : real(this.repoRoot);
    const state = this.registry.loadState();
    const items = listed.slice(1).map((w) => ({ ...w, path: realLoose(w.path), isPrimary: false }));
    const seen = new Set(items.map((w) => w.path));
    if (listed[0]) items.unshift({ ...listed[0], path: primary, isPrimary: true });
    for (const entry of Object.values(state)) {
      if (!entry.path) continue;
      const p = realLoose(entry.path);
      if (!seen.has(p) && p !== primary && !fs.existsSync(p)) {
        items.push({ path: p, head: null, branch: entry.branch || null, locked: false, prunable: false, isPrimary: false, registryOnly: true });
      }
    }
    return { items, state, primary };
  }

  _registryFor(state, wtPath, issueId) {
    const atPath = Object.values(state).find((e) => e.path && realLoose(e.path) === wtPath) || null;
    const others = issueId ? Object.values(state).filter((e) => e.id === issueId && e !== atPath) : [];
    return { atPath, others };
  }

  /**
   * Evaluate one candidate against current Git, registry and Linear state.
   * Read-only. `action` is one of: remove, prune-registration, already-absent,
   * retain, skip.
   */
  async evaluate(wt, { state, primary }) {
    const rec = {
      path: wt.path, branch: wt.branch, issueId: null, identity: null, linearStatus: null,
      terminalAt: null, eligibleAt: null, localChanges: null, action: "skip", code: null, reason: null,
    };
    const skip = (code, reason) => Object.assign(rec, { action: "skip", code, reason });

    if (wt.isPrimary || wt.path === primary) return skip("primary-checkout", "primary repository checkout is never removed");
    if (this.excluded.includes(wt.path)) return skip("excluded-checkout", "dispatcher daemon checkout is never removed");
    if (this.selfPaths.some((s) => s === wt.path || within(s, wt.path))) return skip("self-checkout", "the running dispatcher is inside this checkout");
    if (!this.roots.some((r) => within(wt.path, r))) return skip("outside-roots", "path is outside the configured worktree roots");
    if (wt.locked) return skip("git-locked", "worktree is locked in Git");

    const { atPath } = this._registryFor(state, wt.path, null);
    const ident = resolveIssueIdentity({ worktreePath: wt.path, branch: wt.branch, registryEntry: atPath });
    if (!ident.issueId) return skip(ident.ambiguous ? "ambiguous-identity" : "unknown-identity", ident.reason);
    rec.issueId = ident.issueId;
    rec.identity = ident.source;
    const { others } = this._registryFor(state, wt.path, ident.issueId);

    let verdict;
    try {
      verdict = evaluateTerminalState(await this.fetchIssue(ident.issueId), {
        expectedId: ident.issueId, now: this.now(), retentionDays: this.retentionDays,
      });
    } catch (error) {
      return skip("linear-unavailable", `Linear lookup failed: ${error.message}`);
    }
    rec.linearStatus = verdict.linearStatus || null;
    if (verdict.verdict === "unknown") return skip("linear-unknown", verdict.reason);
    if (verdict.verdict === "active") return skip("not-terminal", verdict.reason);
    rec.terminalAt = verdict.terminalAt;
    rec.eligibleAt = verdict.eligibleAt;

    const missing = !fs.existsSync(wt.path);
    if (!missing) rec.localChanges = this._inspect(wt);
    else rec.localChanges = { state: "absent" };

    // Active work is refused even after the retention window.
    const busy = this._busyReason(state, ident.issueId, wt.path, atPath, others);
    if (busy) return skip(busy.code, busy.reason);

    if (!verdict.eligible) {
      return Object.assign(rec, { action: "retain", code: "retained", reason: `retained until ${verdict.eligibleAt}` });
    }
    if (missing) {
      if (wt.registryOnly) {
        return Object.assign(rec, { action: "already-absent", code: "already-absent", reason: "checkout already absent; only a stale registry record remains" });
      }
      return Object.assign(rec, { action: "prune-registration", code: "stale-registration", reason: "checkout missing; Git registration is stale" });
    }
    if (!this.isLinkedWorktree(wt.path)) return skip("not-linked-worktree", "path is not an intact linked worktree of this repository");
    if (rec.localChanges.state === "unreadable") return skip("git-unreadable", rec.localChanges.reason);
    if (rec.localChanges.blockers.length) return skip(rec.localChanges.blockers[0].code, rec.localChanges.blockers[0].reason);

    const use = this.pathInUse(wt.path);
    if (use !== false) return skip("in-use", use === true ? "a live process is using the checkout" : "could not determine whether a process is using the checkout");

    const dirty = rec.localChanges.state !== "clean";
    return Object.assign(rec, {
      action: "remove", code: "eligible",
      reason: dirty ? "eligible; local work will be preserved in recovery refs before removal" : "eligible; checkout is clean",
    });
  }

  _busyReason(state, issueId, wtPath, atPath, others) {
    const live = (e) => ["active", "review"].includes(e.status);
    if (atPath && live(atPath)) return { code: "active-registry", reason: `registry marks ${atPath.id} ${atPath.status}` };
    if (others.some(live)) return { code: "active-registry", reason: `another registry entry for ${issueId} is active` };
    if (Object.values(state).some((e) => e.path && realLoose(e.path) === wtPath && live(e))) {
      return { code: "active-registry", reason: "registry has an active entry for this path" };
    }
    for (const e of [atPath, ...others].filter(Boolean)) {
      for (const pid of [e.pid, e.workerPid]) {
        if (Number.isInteger(pid) && pid > 0 && this.isPidAlive(pid)) return { code: "live-process", reason: `recorded process ${pid} is alive` };
      }
      if (e.workerSpawnPending || e.usageLimitResumeAt || e.retainedForResume) {
        return { code: "pending-continuation", reason: "registry records a pending worker continuation" };
      }
    }
    if (this.hasPendingContinuation(issueId)) return { code: "pending-continuation", reason: "a usage-limit continuation is pending for this issue" };
    return null;
  }

  isLinkedWorktree(wtPath) {
    try {
      if (!fs.lstatSync(path.join(wtPath, ".git")).isFile()) return false;
      const common = (cwd) => real(this._git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
      return common(wtPath) === common(this.repoRoot);
    } catch { return false; }
  }

  /** Read-only local-change classification. */
  _inspect(wt) {
    let status;
    try {
      status = parseStatusZ(this._git(wt.path, ["status", "--porcelain=v1", "-z", "--ignored=traditional", "--untracked-files=all"]));
    } catch (error) {
      return { state: "unreadable", reason: `git status failed: ${error.message}`, blockers: [] };
    }
    let unpushed = null;
    try { unpushed = Number(this._git(wt.path, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).trim()); } catch { unpushed = null; }
    const blockers = [];
    if (status.unmerged.length) blockers.push({ code: "unmerged-paths", reason: "index has unmerged (conflicted) paths" });
    if (unpushed === null || !Number.isFinite(unpushed)) blockers.push({ code: "unpushed-unknown", reason: "could not determine unpushed commits" });
    const cred = [...status.staged, ...status.unstaged, ...status.untracked].find(isCredentialLikePath);
    if (cred) blockers.push({ code: "credential-file", reason: "a credential-like file has local changes; it is never snapshotted, so the checkout is kept" });
    const nonRegen = status.ignored.filter((f) => !isRegenerableIgnored(wt.path, f));
    if (nonRegen.length) blockers.push({ code: "ignored-files", reason: `ignored non-regenerable files remain (${nonRegen.length}, e.g. ${nonRegen[0]})` });
    const counts = {
      staged: status.staged.length, unstaged: status.unstaged.length, untracked: status.untracked.length,
      unpushedCommits: unpushed, regenerableIgnored: status.ignored.length - nonRegen.length, nonRegenerableIgnored: nonRegen.length,
    };
    const dirty = counts.staged + counts.unstaged + counts.untracked > 0 || counts.unpushedCommits > 0;
    return { state: dirty ? "dirty" : "clean", ...counts, blockers };
  }

  // ---- preservation and removal (live only) --------------------------------

  /** Content fingerprint of everything recoverable. Writes only Git objects. */
  _snapshotTrees(wtPath) {
    const gitDir = this._git(wtPath, ["rev-parse", "--path-format=absolute", "--git-dir"]).trim();
    const head = this._git(wtPath, ["rev-parse", "--verify", "HEAD"]).trim();
    const indexTree = this._git(wtPath, ["write-tree"]).trim();
    const tmpIndex = path.join(os.tmpdir(), `moviecal-retention-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
    try {
      fs.copyFileSync(path.join(gitDir, "index"), tmpIndex);
      fs.chmodSync(tmpIndex, 0o600);
      this._git(wtPath, ["add", "-A", "--", "."], { env: { GIT_INDEX_FILE: tmpIndex } });
      const workTree = this._git(wtPath, ["write-tree"], { env: { GIT_INDEX_FILE: tmpIndex } }).trim();
      const ignored = crypto.createHash("sha256")
        .update(this._git(wtPath, ["status", "--porcelain=v1", "-z", "--ignored=traditional", "--untracked-files=all"])).digest("hex");
      return { head, indexTree, workTree, ignored };
    } finally { fs.rmSync(tmpIndex, { force: true }); }
  }

  _commitTree(wtPath, tree, parent, message) {
    const env = {
      GIT_AUTHOR_NAME: "moviecal-dispatcher", GIT_AUTHOR_EMAIL: "dispatcher@moviecal.invalid",
      GIT_COMMITTER_NAME: "moviecal-dispatcher", GIT_COMMITTER_EMAIL: "dispatcher@moviecal.invalid",
    };
    return this._git(wtPath, ["commit-tree", tree, "-p", parent, "-m", message], { env }).trim();
  }

  _ensureRef(wtPath, ref, sha, expectedTree) {
    let existing = null;
    try { existing = this._git(wtPath, ["rev-parse", "--verify", "--quiet", ref]).trim(); } catch { existing = null; }
    if (existing) {
      const tree = this._git(wtPath, ["rev-parse", `${existing}^{tree}`]).trim();
      if (tree !== expectedTree) throw new Error(`recovery ref ${ref} already exists with different content`);
      return existing;
    }
    this._git(wtPath, ["update-ref", ref, sha, NULL_SHA]);
    const got = this._git(wtPath, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
    if (got !== sha || this._git(wtPath, ["rev-parse", `${got}^{tree}`]).trim() !== expectedTree) {
      throw new Error(`recovery ref ${ref} failed verification`);
    }
    return got;
  }

  /** Preserve recoverable work in local refs and write a recovery record. */
  _preserve(rec, wtPath, snap) {
    const headTree = this._git(wtPath, ["rev-parse", `${snap.head}^{tree}`]).trim();
    const base = `${RECOVERY_REF_PREFIX}/${rec.issueId}/${snap.head.slice(0, 12)}-${snap.workTree.slice(0, 12)}`;
    const refs = { head: `${base}/head` };
    const shas = {};
    // HEAD ref keeps every local commit (including branch-only or detached ones) reachable.
    shas.head = this._ensureRef(wtPath, refs.head, snap.head, headTree);
    let parent = snap.head;
    if (snap.indexTree !== headTree) {
      refs.index = `${base}/index`;
      shas.index = this._ensureRef(wtPath, refs.index, this._commitTree(wtPath, snap.indexTree, parent, `moviecal recovery: staged state of ${rec.issueId}`), snap.indexTree);
      parent = shas.index;
    }
    if (snap.workTree !== snap.indexTree) {
      refs.worktree = `${base}/worktree`;
      shas.worktree = this._ensureRef(wtPath, refs.worktree, this._commitTree(wtPath, snap.workTree, parent, `moviecal recovery: working tree of ${rec.issueId}`), snap.workTree);
    }
    fs.mkdirSync(this.recoveryDir, { recursive: true, mode: 0o700 });
    const recordPath = path.join(this.recoveryDir, `${rec.issueId}-${snap.head.slice(0, 12)}-${snap.workTree.slice(0, 12)}.json`);
    const record = {
      issueId: rec.issueId, worktreePath: wtPath, branch: rec.branch, preservedAt: new Date(this.now()).toISOString(),
      repository: this.repoRoot, refs, shas, trees: { head: headTree, index: snap.indexTree, worktree: snap.workTree },
      localChanges: { ...rec.localChanges, blockers: undefined },
      recovery: [
        `git -C <repo> log ${refs.head}`,
        refs.worktree ? `git -C <repo> worktree add <new-path> ${refs.worktree}   # working tree (staged+unstaged+untracked)` : null,
        refs.index ? `git -C <repo> diff ${refs.head} ${refs.index}   # staged changes` : null,
      ].filter(Boolean),
      notes: "Local refs only; never pushed. Credential files and ignored files are not included.",
    };
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    if (JSON.parse(fs.readFileSync(recordPath, "utf8")).issueId !== rec.issueId) throw new Error("recovery record failed verification");
    return { refs, recordPath };
  }

  /** Remove one candidate. Always returns a result record; never throws. */
  async _execute(wt, ctx) {
    const rec = await this.evaluate(wt, ctx);
    const revalidated = rec.action;
    if (revalidated === "retain" || revalidated === "skip" || revalidated === "already-absent") {
      return this._final(rec, revalidated === "retain" ? "retained" : revalidated === "already-absent" ? "already-absent" : "skipped");
    }
    try {
      if (revalidated === "prune-registration") {
        this._git(this.repoRoot, ["worktree", "remove", wt.path]);
        if (this.listWorktrees().some((w) => realLoose(w.path) === wt.path)) throw new Error("registration still present after removal");
        this._dropRegistry(rec, wt.path);
        return this._final(rec, "removed", "stale Git registration removed (checkout was already absent)");
      }
      const snap = this._snapshotTrees(wt.path);
      const dirty = rec.localChanges.state !== "clean";
      let preserved = null;
      if (dirty) {
        preserved = this._preserve(rec, wt.path, snap);
        rec.preserved = preserved;
      }
      // Last checks at the destructive boundary: Linear may have changed and a
      // writer may have touched the checkout while we were preserving.
      const recheck = evaluateTerminalState(await this.fetchIssue(rec.issueId), { expectedId: rec.issueId, now: this.now(), retentionDays: this.retentionDays });
      if (recheck.verdict !== "terminal" || !recheck.eligible || recheck.terminalAt !== rec.terminalAt) {
        return this._final(rec, "skipped", "Linear state changed before removal", "status-changed");
      }
      const finalSnap = this._snapshotTrees(wt.path);
      if (JSON.stringify(finalSnap) !== JSON.stringify(snap)) {
        return this._final(rec, "skipped", "checkout changed during cleanup; nothing was removed", "changed-during-cleanup");
      }
      if (this.pathInUse(wt.path) !== false) return this._final(rec, "skipped", "a process started using the checkout", "in-use");
      const again = this._inspect(wt);
      if (again.state === "unreadable" || again.blockers.length) return this._final(rec, "skipped", "checkout no longer passes integrity checks", "integrity-failed");
      // A clean checkout is removed without --force so Git itself re-checks for
      // races; a dirty one has been preserved and needs --force.
      const args = ["worktree", "remove", ...(dirty || again.regenerableIgnored ? ["--force"] : []), wt.path];
      this._git(this.repoRoot, args);
      if (fs.existsSync(wt.path) || this.listWorktrees().some((w) => realLoose(w.path) === wt.path)) {
        throw new Error("checkout or registration still present after git worktree remove");
      }
      this._dropRegistry(rec, wt.path);
      return this._final(rec, "removed", preserved ? `removed; work preserved in ${Object.values(preserved.refs).join(", ")}` : "removed clean checkout");
    } catch (error) {
      return this._final(rec, "failed", `cleanup failed: ${error.message}`, "failed");
    }
  }

  _dropRegistry(rec, wtPath) {
    const state = this.registry.loadState();
    let changed = false;
    for (const [id, e] of Object.entries(state)) {
      if (e.path && realLoose(e.path) === wtPath && !["active", "review"].includes(e.status)) { delete state[id]; changed = true; }
    }
    if (changed) this.registry.saveState(state);
  }

  _final(rec, outcome, reason = null, code = null) {
    return { ...rec, outcome, code: code || (outcome === "removed" ? "removed" : rec.code), reason: reason || rec.reason };
  }

  // ---- public entry points ---------------------------------------------------

  /** Read-only preview: never mutates Git, Linear, the registry, files, or locks. */
  async preview() {
    const ctx = this.inventory();
    const results = [];
    for (const wt of ctx.items) {
      const rec = await this.evaluate(wt, ctx);
      const outcome = { remove: "would-remove", "prune-registration": "would-remove", "already-absent": "already-absent", retain: "retained", skip: "skipped" }[rec.action];
      results.push({ ...rec, outcome });
    }
    return results;
  }

  /** Live cleanup. The caller must hold the dispatcher singleton lock. */
  async run() {
    const ctx = this.inventory();
    const results = [];
    for (const wt of ctx.items) {
      // Re-list state per candidate so an earlier removal or a concurrent
      // registry write is never evaluated from a stale snapshot.
      results.push(await this._execute(wt, { state: this.registry.loadState(), primary: ctx.primary }));
    }
    return results;
  }
}

/** True when any process has a file open under the path (lsof). null when unknown. */
export function defaultPathInUse(wtPath) {
  try {
    const out = defaultRunner("lsof", ["-w", "-t", "+D", wtPath], { stdio: ["ignore", "pipe", "ignore"] });
    return String(out).trim().length > 0;
  } catch (error) {
    // lsof exits 1 with no output when nothing matches.
    if (error.status === 1 && !String(error.stdout || "").trim()) return false;
    return null;
  }
}

/** Human-readable line for one result. */
export function formatResult(r) {
  const lc = r.localChanges && r.localChanges.state !== "absent"
    ? `${r.localChanges.state}${r.localChanges.state === "dirty" ? ` (staged ${r.localChanges.staged}, unstaged ${r.localChanges.unstaged}, untracked ${r.localChanges.untracked}, unpushed ${r.localChanges.unpushedCommits})` : ""}`
    : r.localChanges?.state || "n/a";
  return [
    `${r.outcome.toUpperCase()}: ${r.path}`,
    `  issue: ${r.issueId || "unknown"}${r.identity ? ` (from ${r.identity})` : ""}  linear: ${r.linearStatus || "n/a"}  terminal: ${r.terminalAt || "n/a"}  eligible: ${r.eligibleAt || "n/a"}`,
    `  local changes: ${lc}`,
    `  ${r.code}: ${r.reason}`,
    ...(r.preserved ? [`  recovery record: ${r.preserved.recordPath}`] : []),
  ].join("\n");
}
