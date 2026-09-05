// Pre-trusts a freshly-created worktree in Claude Code's global config so a
// headless `claude -p` worker doesn't hit the interactive workspace-trust
// dialog (which has no non-interactive answer and would leave the worker
// unable to use its .claude/settings.json permissions at all).
//
// This is safe specifically because the dispatcher only ever calls it on a
// path it just created itself via `git worktree add` from this same trusted
// repository -- never on an arbitrary or externally-supplied path. It is not
// a general-purpose "trust anything" helper.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultClaudeJsonPath() {
  return path.join(os.homedir(), ".claude.json");
}

/**
 * Mark `worktreePath` as trusted in `~/.claude.json`, preserving every other
 * key in the file (and every other project entry) untouched. Writes via a
 * temp-file-plus-rename so a crash mid-write can't leave a corrupt file.
 *
 * Returns { ok: true } on success, or { ok: false, reason } if the file is
 * missing, unparseable, or unwritable -- callers should treat this as
 * degraded-but-non-fatal: a headless worker in an untrusted workspace will
 * still fail cleanly (its .claude/settings.json permissions.allow rules get
 * ignored, and `--permission-mode dontAsk` denies the rest), which the
 * dispatcher already reports as a normal worker-failure outcome.
 */
export function trustWorkspace(worktreePath, claudeJsonPath = defaultClaudeJsonPath()) {
  if (!fs.existsSync(claudeJsonPath)) {
    return { ok: false, reason: `${claudeJsonPath} does not exist` };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
  } catch (err) {
    return { ok: false, reason: `failed to parse ${claudeJsonPath}: ${err.message}` };
  }

  if (typeof config !== "object" || config === null) {
    return { ok: false, reason: `${claudeJsonPath} does not contain a JSON object` };
  }

  config.projects = config.projects || {};
  config.projects[worktreePath] = {
    ...(config.projects[worktreePath] || {}),
    hasTrustDialogAccepted: true,
  };

  const tmpPath = `${claudeJsonPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(tmpPath, claudeJsonPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup only
    }
    return { ok: false, reason: `failed to write ${claudeJsonPath}: ${err.message}` };
  }

  return { ok: true };
}

/** Read-only check: is `worktreePath` currently trusted? */
export function isWorkspaceTrusted(worktreePath, claudeJsonPath = defaultClaudeJsonPath()) {
  if (!fs.existsSync(claudeJsonPath)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    return Boolean(config?.projects?.[worktreePath]?.hasTrustDialogAccepted);
  } catch {
    return false;
  }
}
