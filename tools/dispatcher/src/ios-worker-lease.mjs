// Dispatcher-side adapter onto the machine-wide iOS simulator lease
// (scripts/ios-sim-lease.mjs, MOV-309) for "iOS Companion App" project issues
// (MOV-311). The dispatcher holds one `worker`-lane lease for the whole
// worker run and hands its id to the worker as MOVIECAL_IOS_SIM_LEASE_ID
// (worker-guard.mjs/worker-spawn.mjs) so a nested `ios:sim:run` inside that
// worker's own, different process renews it instead of deadlocking on its
// own dispatcher.
//
// Acquisition never waits: a lease unavailable right now -- held by another
// lane, queued behind another waiter, or an unmanaged simulator state MOV-309
// never tears down automatically -- is ordinary infrastructure contention
// here, not a dispatch failure. The caller (run-loop.mjs) defers the issue
// silently and a later poll cycle retries once it frees, exactly like the
// usage-limit deferral (MOV-151).

import { commandAcquire, commandRelease, createEnvironment } from "../../../scripts/ios-sim-lease.mjs";

function workerLeaseEnvironment() {
  // MOVIECAL_WORKER_SANDBOX is what scripts/lib/ios-sim-lease-core.mjs's
  // detectLane() reads to resolve the `worker` lane -- the dispatcher itself
  // is never sandboxed, so this is set only on the environment object used
  // for this one lease call, never on the dispatcher's real process env.
  return createEnvironment({
    env: { ...process.env, MOVIECAL_WORKER_SANDBOX: "1" },
    log: () => {},
    warn: () => {},
    notify: () => ({ status: 0, stdout: "", stderr: "" }),
  });
}

/** @returns {Promise<{acquired: true, lease: object} | {acquired: false, reason: string}>} */
export async function acquireIosWorkerLease(issue) {
  try {
    const lease = commandAcquire(
      { purpose: `dispatcher worker run for ${issue.identifier}`, ref: issue.identifier, waitMs: 0 },
      workerLeaseEnvironment(),
    );
    return { acquired: true, lease };
  } catch (error) {
    return { acquired: false, reason: error.message };
  }
}

/** Best-effort: a lease that is already gone (expired, taken over) is not an error to release again. */
export async function releaseIosWorkerLease(leaseId) {
  try {
    commandRelease({ id: leaseId, force: true }, workerLeaseEnvironment());
  } catch (error) {
    console.error(`Could not release iOS simulator worker lease ${leaseId}: ${error.message}`);
  }
}
