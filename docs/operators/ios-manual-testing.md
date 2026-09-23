# iOS manual testing

Use this procedure to install the iOS app from the checkout you intend to
test. Device Hub does not select a Git branch: it shows the simulator's
currently installed com.moviecal.ios binary. Installing a build from another
checkout replaces that binary, while the simulator's app container and
Keychain state can remain.

## The simulator lease (MOV-309/MOV-311)

The iOS simulator is a machine-wide shared resource with three lane devices:
`moviecal-ci`, `moviecal-worker`, and `moviecal-manual`. `npm run
ios:manual-test` always targets `moviecal-manual` and acquires a manual-lane
lease before it builds, holding it after install and launch so a human can
keep testing. The lease is time-based (20 minutes by default, renewable up to
a 60-minute hard cap from first acquisition) rather than tied to the command's
own process, because closing the terminal that ran the build must not free the
simulator out from under whoever is still testing on it.

On success the command prints an agent-guidance block naming the lease id,
its expiry, and its hard cap. Full lease semantics -- lane detection, lazy
takeover of a stale lease, unmanaged-state detection, and the complete
`ios:sim:*` command surface (`setup`, `acquire`, `release`, `extend`,
`status`, `adopt`, `run`) -- are specified in `scripts/ios-sim-lease.mjs` and
the MOV-309 issue; this document only covers what a human or agent running
manual tests needs day to day.

**Agent procedure:** if you (an agent) set the simulator up for a user's
manual testing -- ran `npm run ios:manual-test` or otherwise acquired a
manual-lane lease on their behalf -- run `npm run ios:sim:release` as soon as
the user says they are finished testing. Do not leave a live lease sitting
idle after that point: it blocks CI, the dispatcher's worker lane, and the
next person's manual session until it expires on its own.

If your session is guarded by the `scripts/ios-sim-guard.mjs` hook (wiring it
into `.claude/settings.json` is a separate, human-only step), any Bash command
or iOS Simulator MCP action that boots, installs to, launches on, shuts down,
or erases a simulator -- or runs `xcodebuild`, or opens Simulator.app -- is
blocked until a live lease covers your lane. The block message tells you to
run `npm run ios:sim:acquire`. Read-only commands (`simctl list`,
`npm run ios:sim:status`, anything with `--dry-run`) always pass regardless of
lease state.

## Prepare the checkout and API

Run the command from an interactive worktree outside the dispatcher's managed
worktree root. Do not run it while a local worker, CI runner, or another Xcode
build is using the simulator -- the lease above is exactly what prevents that
collision if you try anyway.

For native API testing, start a separate local API server in the same checkout:

    npm run dev -- --port 3100

The iOS app's manual-test configuration is intentionally kept outside the
repository in ~/.config/moviecal/ios-manual-test.env. The command reads only
MOVIECAL_SUPABASE_URL and MOVIECAL_SUPABASE_ANON_KEY; it never loads, prints,
or passes test email/password values to the build.

## Build and install

    npm run ios:manual-test

This acquires the manual lease, builds against the `moviecal-manual` device
(`--device booted` means this device, not "whatever single simulator happens
to be booted"), validates its configuration before invoking Xcode, writes the
required build settings to a private temporary .xcconfig, verifies the built
app's embedded settings without displaying them, installs the app, launches
it, and prints the agent-guidance block.

To target a different simulator instead, pass an explicit UDID or name:

    npm run ios:manual-test -- --device <udid-or-name>

An explicit device is rejected if it names `moviecal-ci` or `moviecal-worker`
-- those are the CI and dispatcher-worker lanes' own devices and are never
valid manual-test targets. The manual lease is still acquired even when
targeting a different device, since the lease is what reserves the lane, not
the device itself.

Use --dry-run to confirm configuration and identify the current branch and
commit without running simulator or build commands, and without acquiring a
lease or writing anything:

    npm run ios:manual-test -- --dry-run

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

## When you are finished

Release the lease so the next lane -- CI, a dispatcher worker, or another
human -- can take the simulator:

    npm run ios:sim:release

This shuts the `moviecal-manual` device down. `npm run ios:sim:status` shows
the current lease, its expiry, and anyone waiting on it.
