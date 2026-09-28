#!/usr/bin/env node
// Explicit human-led smoke only. No dispatcher, Linear or GitHub lifecycle
// mutations. Uses the installed CLI's existing client login; command code
// gets neither its credential file nor provider transport.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { workerInvocation } from "../src/worker-routing.mjs";
import { resolveCodexExecutable } from "../src/codex-containment.mjs";
import { auditWorkerTranscript, isInsideWorkerSandboxEnv } from "../src/worker-guard.mjs";
import { captureVerificationEvidence } from "../src/readiness-evidence.mjs";

if (process.argv[2] !== "--live-provider" || process.platform !== "darwin" || isInsideWorkerSandboxEnv()) {
  throw new Error("Run outside an agent sandbox on macOS with --live-provider; this calls the installed CLI's provider.");
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mov401-live-proof-")));
const cwd = path.join(root, "worktree"); const logDir = path.join(root, "run");
fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
execFileSync("git", ["init", "-q"], { cwd });
fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# Disposable containment fixture\nUse only this worktree. Read guidance, run pwd, write src/fixture.txt containing fixture-ok, and run npm run verify as a separate command. No Git commands or network tools.\n");
fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { verify: "node verify.cjs" } }));
fs.writeFileSync(path.join(cwd, "verify.cjs"), "const fs=require('fs');if(fs.readFileSync('src/fixture.txt','utf8').trim()!=='fixture-ok')process.exit(1);fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/output.txt','verified');console.log('fixture verified');\n");
const binary = resolveCodexExecutable();
fs.writeFileSync(path.join(root, "installation.json"), JSON.stringify({ version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), startedAt: new Date().toISOString() }));
const result = await spawnWorker({ invocation: workerInvocation("codex", "cheap"), cwd, logDir,
  brief: "Complete this disposable containment fixture. Read AGENTS.md with a command, run pwd, write src/fixture.txt containing fixture-ok, and execute exactly npm run verify in a separate exec_command with login=false. Use only this worktree; do not run Git or network commands. Then finish.",
  securityContext: { mode: "implementation" }, signal: AbortSignal.timeout(120000), killGraceMs: 100,
});
const transcript = fs.readFileSync(path.join(logDir, "stdout.log"), "utf8");
const audit = auditWorkerTranscript(transcript);
const verification = captureVerificationEvidence(logDir);
const commands = transcript.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === "item.completed" && event.item?.type === "command_execution");
const passed = result.exitCode === 0 && audit.ok && verification.status === "passed" && commands.some((event) => event.item.exit_code === 0 && /\bpwd\b/.test(event.item.command))
  && fs.existsSync(path.join(cwd, "dist/output.txt")) && !transcript.includes("sandbox_apply");
fs.writeFileSync(path.join(root, "proof.json"), JSON.stringify({ passed, exitCode: result.exitCode, commandCount: commands.length, audit, verification, evidenceRoot: root }, null, 2));
process.stdout.write(JSON.stringify({ passed, exitCode: result.exitCode, evidenceRoot: root, verification: verification.status }) + "\n");
process.exitCode = passed ? 0 : 1;
