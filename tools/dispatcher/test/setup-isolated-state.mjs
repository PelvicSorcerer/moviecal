// Vitest setup (MOV-382): point every dispatcher state and log location at a
// throwaway directory before any test module loads. config.mjs resolves these
// lazily, so a test that forgets to inject or mock a path (as run-loop-e2e once
// did for the worker-usage ledger) writes here instead of to the live state
// under ~/.config/moviecal or the live run logs. Set unconditionally, even if
// the operator's shell exports its own values.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-test-state-"));
process.env.MOVIECAL_CONFIG_DIR = path.join(root, "config");
process.env.MOVIECAL_LOG_ROOT = path.join(root, "logs");
process.env.MOVIECAL_WORKTREE_ROOT = path.join(root, "worktrees");

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
