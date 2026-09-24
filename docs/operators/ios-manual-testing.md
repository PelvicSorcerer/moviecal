# iOS manual testing

Use this procedure to install the iOS app from the checkout you intend to
test. Device Hub does not select a Git branch: it shows the simulator's
currently installed com.moviecal.ios binary. Installing a build from another
checkout replaces that binary, while the simulator's app container and
Keychain state can remain.

## The simulator lease (MOV-309/MOV-311)

`npm run ios:manual-test` always targets the `moviecal-manual` device and holds
a manual-lane lease (20 minutes, renewable to a 60-minute cap) after install
and launch, so closing the build terminal does not free the simulator mid-test.
It prints the lease id, expiry, and cap. Full semantics and the `ios:sim:*`
commands are in `scripts/ios-sim-lease.mjs`.

**Agent procedure:** if you set up the simulator for a user's manual testing,
run `npm run ios:sim:release` as soon as they say they are finished; an idle
lease blocks CI, the worker lane, and the next manual session.

Claude Code's `.claude/settings.json` runs `scripts/ios-sim-guard.mjs` before
simulator-mutating Bash and iOS Simulator MCP actions. It blocks those actions
and `xcodebuild` until a live lease covers the lane; the message says to run
`npm run ios:sim:acquire`. Read-only commands and `--dry-run` pass.

Codex has an equivalent `.codex/hooks.json` configuration, but Codex CLI
0.153.4 does not discover project hooks in linked Git worktrees: `/hooks` shows
zero installed even after trusting this worktree. This matches the open
[Codex worktree hook issue](https://github.com/openai/codex/issues/27133).
Treat Codex worktree sessions as unguarded: acquire the lease before simulator
work, check `npm run ios:sim:status`, and rely on MOV-309's unmanaged-state
detection when acquiring. When Codex does load the hook (for example, in a
regular checkout), review and trust its definition through `/hooks` before
relying on it. Use the acquire-first procedure for other tool paths too.

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

This acquires the manual lease and builds against `moviecal-manual`
(`--device booted` means that device), validates configuration before invoking
Xcode, writes build settings to a private temporary .xcconfig, verifies the
built app's embedded settings without displaying them, installs, and launches.

Pass `--device <udid-or-name>` to target another simulator (`moviecal-ci`
and `moviecal-worker` are rejected).

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

Run `npm run ios:sim:release` to free the simulator (`ios:sim:status` shows
the current lease).
