# iOS manual testing

Use this procedure to install the iOS app from the checkout you intend to
test. Device Hub does not select a Git branch: it shows the simulator's
currently installed com.moviecal.ios binary. Installing a build from another
checkout replaces that binary, while the simulator's app container and
Keychain state can remain.

## Take the simulator lease first

CI, dispatcher workers, and manual testing each have their own simulator device
(moviecal-ci, moviecal-worker, moviecal-manual), and a machine-wide lease keeps
at most one of them booted — with 8 GB of RAM, a second booted simulator or a
cold Xcode build beside one puts the Mac into heavy swap. See
[local execution](./local-execution.md) §Resource contention policy for the
whole policy. Create the three devices once (idempotent; the shared iPhone 17
is never touched), then take the lease before any simulator or Xcode work:

    npm run ios:sim:setup      # once per machine
    npm run ios:sim:acquire    # before testing
    npm run ios:sim:release    # when testing is finished

Your lane comes from the environment, never a flag: a terminal session —
including an interactive Claude or Codex session working for you — is always the
manual lane. A manual lease runs 20 minutes, renewable with
npm run ios:sim:extend and never past a 60-minute hard cap. It has no pid tie,
so closing the terminal does not free the simulator. Release shuts the device
down to return RAM (--keep-booted leaves it up); the installed app and its data
survive, so the next session on that device keeps its binary and Keychain state.

npm run ios:sim:status shows the holder, the FIFO waiters and how long each has
waited, every booted simulator, any running xcodebuild, and a memory/swap line.
Run it before any global simulator command: never run xcrun simctl shutdown all,
xcrun simctl erase all, or kill the CoreSimulator services while a live lease or
a running xcodebuild exists. A simulator booted without a lease is reported as
unmanaged use and waited on, never shut down for you — record your own with
npm run ios:sim:adopt. A waiter that gives up exits 75 with
SIMULATOR_LEASE_UNAVAILABLE: an infrastructure wait, safe to re-run.

### Agent procedure

If you are an agent setting the simulator up for a human's manual testing:

1. Run npm run ios:sim:acquire. It prints a guidance block with the lease id,
   its 20-minute expiry, and its 60-minute hard cap.
2. Install and launch the build (below) and hand the session to the user.
3. Near the expiry, if testing is still going, run npm run ios:sim:extend.
4. **Run npm run ios:sim:release as soon as the user says they are finished
   testing.** A forgotten manual lease blocks CI, the dispatcher, and the next
   human for up to an hour.

## Prepare the checkout and API

Run the command from an interactive worktree outside the dispatcher's managed
worktree root. Hold the simulator lease (above) while you do; do not run it
while a local worker, CI runner, or another Xcode build is using the simulator.

For native API testing, start a separate local API server in the same checkout:

    npm run dev -- --port 3100

The iOS app's manual-test configuration is intentionally kept outside the
repository in ~/.config/moviecal/ios-manual-test.env. The command reads only
MOVIECAL_SUPABASE_URL and MOVIECAL_SUPABASE_ANON_KEY; it never loads, prints,
or passes test email/password values to the build.

## Build and install

With exactly one booted simulator — which, while you hold the lease, is the
moviecal-manual device it booted for you:

    npm run ios:manual-test -- --device booted

To select a particular simulator, substitute its UDID for booted. ios:manual-test
does not take the lease itself yet (that adoption is its own follow-up issue), so
acquire it yourself first. The command
validates its configuration before invoking Xcode, writes the required
build settings to a private temporary .xcconfig, verifies the built app's
embedded settings without displaying them, installs the app, and launches it.

Use --dry-run to confirm configuration and identify the current branch and
commit without running simulator or build commands:

    npm run ios:manual-test -- --device booted --dry-run

For an intentionally separate disposable configuration file, add
--env-file /absolute/path/to/ios-manual-test.env. The file is parsed as data,
not sourced as shell code.

## Switching sources and resetting state

Before each manual test, run the command in the exact checkout and branch under
review and confirm its printed branch and short SHA. That is the source of the
binary currently in Device Hub; Device Hub itself cannot change branches.

Switching source checkouts replaces the installed binary but does not
guarantee a clean session. Signing out, erasing app data, or erasing the
simulator are destructive manual actions. Do them only when the test case calls
for a clean state, and record that reset in the issue's manual-verification
evidence.
