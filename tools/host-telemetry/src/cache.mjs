// Per-command refresh schedule and result cache. MOV-498.
//
// Why: each spawn costs CPU (the sampler is budgeted at under 1% of one core including children), and
// a hung command must never delay the next sample. So every command runs on its own cadence, at most one
// call per command is in flight, a sample waits only a short grace for fresh results, and a call that is
// still running (or has failed) is reported as a null field with a note instead of blocking.
export const COMMAND_TIMEOUT_MS = 3000;
export const GRACE_MS = 400;
export const FAIL_BACKOFF_MS = 15_000;

// minimum ms between calls. `busy` is used while a job is running so ps keeps the 1.5 s cadence.
export const SCHEDULE = {
  ps: { idleMs: 5000, busyMs: 1500 },
  vmStat: { idleMs: 15_000, busyMs: 15_000 },
  pressure: { idleMs: 15_000, busyMs: 15_000 },
  swap: { idleMs: 15_000, busyMs: 15_000 },
  therm: { idleMs: 60_000, busyMs: 60_000 },
  df: { idleMs: 60_000, busyMs: 60_000 },
};

export function createCommandCache({ run, commands, schedule = SCHEDULE, timeoutMs = COMMAND_TIMEOUT_MS, graceMs = GRACE_MS }) {
  const state = Object.fromEntries(
    Object.keys(commands).map((n) => [n, { inflight: null, startedAt: -Infinity, result: null, resultAt: null }]),
  );

  const due = (name, nowMs, busy) => {
    const s = state[name];
    if (s.inflight) return false;
    const every = busy ? schedule[name].busyMs : schedule[name].idleMs;
    const wait = s.result && !s.result.ok ? Math.max(every, FAIL_BACKOFF_MS) : every;
    return nowMs - s.startedAt >= wait;
  };

  function start(name, nowMs) {
    const s = state[name];
    s.startedAt = nowMs;
    const [cmd, args] = commands[name];
    s.inflight = Promise.resolve(run(cmd, args, { timeoutMs }))
      .catch((error) => ({ ok: false, stdout: "", timedOut: false, error: String(error?.message ?? error) }))
      .then((result) => {
        s.result = result;
        s.resultAt = nowMs;
        s.inflight = null;
      });
    return s.inflight;
  }

  return {
    // Starts every due command, then waits at most graceMs for them. Never throws.
    async refresh(nowMs, { busy = false, wait = graceMs } = {}) {
      const started = Object.keys(state).filter((n) => due(n, nowMs, busy)).map((n) => start(n, nowMs));
      if (!started.length) return;
      let timer;
      const grace = new Promise((resolve) => {
        timer = setTimeout(resolve, wait);
      });
      await Promise.race([Promise.all(started), grace]);
      clearTimeout(timer);
    },
    // { ok, stdout, timedOut, stale, pending } for the latest known result of a command.
    get(name, nowMs) {
      const s = state[name];
      if (!s.result) return { ok: false, stdout: "", timedOut: false, pending: true };
      const every = schedule[name].idleMs;
      if (s.result.ok && nowMs - s.resultAt > 3 * every) return { ok: false, stdout: "", timedOut: false, stale: true };
      return s.result;
    },
  };
}
