import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareCodexContainment, resolveCodexExecutable } from "../src/codex-containment.mjs";
import { workerInvocation } from "../src/worker-routing.mjs";

let root;
let containment;
afterEach(() => { containment?.cleanup(); if (root) fs.rmSync(root, { recursive: true, force: true }); containment = null; });
function options() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mov401-unit-"));
  const cwd = path.join(root, "worktree"); const home = path.join(root, "home"); const logDir = path.join(root, "logs");
  for (const dir of [cwd, home, logDir]) fs.mkdirSync(dir);
  return { invocation: workerInvocation("codex", "default"), cwd, home, logDir, repositoryPaths: { protectedRepositoryPaths: ["/repo/sibling"], gitMetadataPaths: ["/repo/.git"] },
    sourceEnvironment: { PATH: "/usr/bin", HOME: home, GH_TOKEN: "fixture-secret", NODE_OPTIONS: "loader", DYLD_INSERT_LIBRARIES: "loader", CODEX_EXEC_SERVER_URL: "untrusted", HTTPS_PROXY: "untrusted" },
    resolveExecutable: (command) => command === "codex" ? "/installed/codex" : command, verifyVersion: () => "codex-cli 0.157.1", mode: "implementation" };
}
describe("Codex containment policy", () => {
  it.each(["implementation", "repair"])("prepares separate closed guards with no provider credentials or local fallback in %s", (mode) => {
    const opts = options(); containment = prepareCodexContainment({ ...opts, mode });
    const launch = JSON.parse(fs.readFileSync(containment.invocation.args[1], "utf8"));
    expect(opts.invocation.args).toContain("workspace-write");
    expect(launch.args).toContain("danger-full-access");
    expect(launch.args).toContain("never");
    expect(containment.invocation.command).toBe(process.execPath);
    for (const key of ["GH_TOKEN", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "CODEX_EXEC_SERVER_URL", "HTTPS_PROXY"]) expect(containment.environment).not.toHaveProperty(key);
    const executor = fs.readFileSync(launch.executorProfile, "utf8");
    const harness = fs.readFileSync(launch.harnessProfile, "utf8");
    expect(executor).toContain("(deny default)");
    expect(executor).not.toContain("(allow network-outbound)");
    expect(executor).toContain('(deny process-exec (literal "/usr/bin/security"))');
    expect(executor).toContain(`(deny file-read* (subpath "${launch.harnessHome}"))`);
    expect(executor).toContain(`(deny file-read* (subpath "${containment.environment.TMPDIR}"))`);
    expect(harness).toContain(`(deny file-read* (subpath "${launch.executorScratch}"))`);
    expect(launch.executorScratch).not.toBe(containment.environment.TMPDIR);
    expect(executor).toContain('(deny file-write* (subpath "/repo/.git"))');
    expect(harness).toContain("(allow network-outbound)");
    expect(harness).toContain('(deny process-exec (require-not (require-any (literal "/installed/codex") (literal "/installed/codex-code-mode-host"))))');
    expect(harness).toContain(`(deny file-write* (subpath "${launch.harnessHome}/environments.toml"))`);
    expect(harness).toContain(`(deny file-write-unlink (literal "${launch.harnessHome}"))`);
    if (mode === "repair") expect(executor).toContain(`(deny file-write* (literal "${opts.cwd}/package.json"))`);
    expect(containment.evidence.executorProfileSha256).toMatch(/^[a-f0-9]{64}$/);
    const runtime = containment.runtime;
    containment.cleanup(); expect(fs.existsSync(runtime)).toBe(false);
  });
  it("rejects a broader routing invocation rather than accepting an external bypass", () => {
    const opts = options(); opts.invocation.args[1] = "danger-full-access";
    expect(() => prepareCodexContainment(opts)).toThrow(/workspace-write routing contract/);
  });
  it("refuses a native executable in the editable checkout", () => {
    const opts = options(); opts.resolveExecutable = () => path.join(fs.realpathSync(opts.cwd), "codex");
    expect(() => prepareCodexContainment(opts)).toThrow(/outside repository checkouts/);
  });
  it("fails closed before runtime preparation for an unproved CLI version", () => {
    const opts = options(); opts.verifyVersion = () => { throw new Error("unproved Codex containment version"); };
    expect(() => prepareCodexContainment(opts)).toThrow(/unproved/);
    expect(fs.readdirSync(opts.logDir)).toEqual([]);
  });
  it("rejects a missing executable and an arbitrary script", () => {
    const opts = options();
    expect(() => resolveCodexExecutable("codex", { PATH: opts.home })).toThrow(/unavailable/);
    const file = path.join(opts.home, "codex"); fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o700 });
    expect(() => resolveCodexExecutable(file)).toThrow(/Mach-O/);
  });
});
