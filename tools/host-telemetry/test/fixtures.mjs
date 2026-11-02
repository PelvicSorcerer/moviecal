export const PS_FIXTURE = `
  1     0   0.5  12000 /sbin/launchd
 100    1  42.0 150000 /Users/a/actions-runner/bin/Runner.Worker
 101  100  80.5 900000 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme X --token=ghp_abcdefghijklmnopqrstuvwxyz0123456789
 102  101  12.0 300000 /Applications/Xcode.app/Contents/Developer/usr/bin/swift-frontend
 103    1  30.0 700000 /Library/Developer/CoreSimulator/Devices/ABC/data/Containers/Bundle/Application/MovieCal
 104    1   2.0 200000 /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator
 105    1  55.0 400000 /Users/a/.local/bin/claude
 106    1  10.0 100000 /usr/local/bin/codex
 107    1   9.0  90000 /usr/local/bin/node sk-live_abcdefghijklmnop1234 SECRET_TOKEN=abc
 108    1   1.0  20000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
`;

export const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               4000.
Pages active:                           100000.
Pages occupied by compressor:           200000.
`;

export const THERM_NONE = `Note: No thermal warning level has been recorded
Note: No performance warning level has been recorded
`;
export const THERM_LIMITED = `CPU_Scheduler_Limit = 100
CPU_Available_CPUs = 8
CPU_Speed_Limit = 70
`;

export const DF = `Filesystem   1024-blocks      Used Available Capacity iused ifree %iused  Mounted on
/dev/disk3s1s1   239362496 100000000  41943040    71%  400000 1000000    1%   /
`;

// Fake runner keyed by executable basename; value is stdout, a function, or "hang".
export function fakeRunner(overrides = {}, calls = []) {
  const defaults = {
    ps: PS_FIXTURE, vm_stat: VM_STAT, sysctl: null, pmset: THERM_NONE, df: DF, sample: "sample output", log: "log output",
  };
  return async (cmd, args, { timeoutMs } = {}) => {
    const name = cmd.split("/").pop();
    calls.push({ name, args, timeoutMs });
    let v = overrides[name] !== undefined ? overrides[name] : defaults[name];
    if (name === "sysctl") {
      v = args.includes("vm.swapusage")
        ? (overrides.swap ?? "total = 3072.00M  used = 2000.00M  free = 1072.00M  (encrypted)")
        : String(overrides.pressure ?? 1);
    }
    if (typeof v === "function") v = v(args);
    if (v === "hang") return { ok: false, stdout: "", timedOut: true };
    return { ok: true, stdout: v ?? "", timedOut: false };
  };
}
