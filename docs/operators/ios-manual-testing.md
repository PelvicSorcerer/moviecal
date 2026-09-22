# iOS manual testing

Use this procedure to install the iOS app from the checkout you intend to
test. Device Hub does not select a Git branch: it shows the simulator's
currently installed com.moviecal.ios binary. Installing a build from another
checkout replaces that binary, while the simulator's app container and
Keychain state can remain.

## Prepare the checkout and API

Run the command from an interactive worktree outside the dispatcher's managed
worktree root. Do not run it while a local worker, CI runner, or another Xcode
build is using the simulator.

For native API testing, start a separate local API server in the same checkout:

    npm run dev -- --port 3100

The iOS app's manual-test configuration is intentionally kept outside the
repository in ~/.config/moviecal/ios-manual-test.env. The command reads only
MOVIECAL_SUPABASE_URL and MOVIECAL_SUPABASE_ANON_KEY; it never loads, prints,
or passes test email/password values to the build.

## Build and install

With exactly one booted simulator:

    npm run ios:manual-test -- --device booted

To select a particular simulator, substitute its UDID for booted. The command
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
