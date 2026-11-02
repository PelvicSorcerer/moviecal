// External command runner with a hard timeout. MOV-494.
import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// Resolves (never rejects) with { ok, stdout, timedOut, error? }. On timeout the
// child gets SIGKILL and the promise resolves immediately.
export function runCommand(cmd, args, { timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish({ ok: false, stdout, timedOut: true });
    }, timeoutMs);
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      finish({ ok: false, stdout: "", timedOut: false, error: String(error.message) });
      return;
    }
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    child.on("error", (error) => finish({ ok: false, stdout, timedOut: false, error: String(error.message) }));
    child.on("close", (code) => finish({ ok: code === 0, stdout, timedOut: false }));
  });
}
