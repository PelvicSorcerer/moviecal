# MOV-401 Codex containment proof

Human-led implementation evidence, collected on macOS arm64 with installed
`codex-cli 0.157.1` on 2026-09-27 local time (2026-09-28 UTC). Operator sign-off
is pending. This record does not authorize daemon deployment or a MOV-399 retry.

## Authority arrangement

The trusted dispatcher creates two closed-by-default Seatbelt profiles before
launching a protected supervisor. The supervisor starts the native Codex client
and native `exec-server` as separately guarded siblings. Routing continues to
request `workspace-write`; the effective native `danger-full-access` command
mode avoids a second Seatbelt application only after the external profiles
exist. A setup failure has no local or unguarded fallback.

The client has provider transport and read-only access to its existing login.
It can execute only the installed client and stock V8 code-mode host. Native
probes establish that code-mode has no OS/network globals or module imports;
its commands and patch operations delegate to the external executor. Plugins,
apps, web search, shell snapshots, login shells and in-process code-mode
fallback are disabled. Its immutable environment config excludes a local
executor. Unproved CLI versions fail setup.

The executor has no provider/dispatcher credentials, client cache access,
outbound networking or client TLS/network Mach brokers. Each sibling has its
own home and scratch directories. The executor permits assigned-worktree
build/test writes while denying unrelated, sibling/main-checkout, Git metadata,
protected governance and repair-protected writes. Protected ancestor moves
are denied. Run policies and logs remain outside either worker's authority.

The sole listener is a per-attempt IPv4 TCP endpoint bound to `127.0.0.1`.
Its port is reserved before guard application; a bind race fails setup.
Command code cannot bind another TCP port, IPv6 or UDP listener, or connect
outbound. This is local executor IPC; Agent Session delivery remains
outbound-only. The existing detached process-group lifecycle owns both siblings.

## Native and live evidence

The native fixture uses temporary repositories, fake credentials and a local
SSE provider. It drives the installed CLI's stock command, patch and code-mode
paths; it does not call a live provider.

| Check | Observed result |
| --- | --- |
| Installed `codex sandbox` outside / inside the legacy guard | Exit 0 / exit 71 with `sandbox_apply: Operation not permitted` |
| Guidance, `pwd`, own writes, patch and fixture `npm run verify` | Passed through guarded spawn; durable verification evidence passed |
| Implementation and repair filesystem/credential/exec/network probes | All denied as expected; allowed own writes passed |
| TCP/IPv6/UDP listener probes | Denied; outbound probe used a listening negative control |
| Missing and invalid executor profiles | No client requests or command activity; nonzero worker exit |
| Stock code-mode API and delegation probes | Restricted APIs/imports rejected; delegated own write passed |
| Existing worker-guard regressions plus new native suite | 16 tests passed outside this session's sandbox |

Native evidence is preserved locally at
`/private/tmp/MOV-401-native-evidence-final`: installation record,
`native-collision.json`, profiles, manifests, fake-provider tool results and
structured transcripts. These paths are local review artifacts, not CI proof;
Linux skips cannot replace them.

The bounded live fixture ran from `00:17:48` to `00:18:09 UTC` on 2026-09-28.
It completed four commands: guidance read, `pwd`, harmless own-file creation
and exact fixture `npm run verify`. Worker exit, transcript audit and
verification evidence all passed; no nested sandbox error occurred. Its
sanitized evidence is preserved locally at
`/private/tmp/MOV-401-live-evidence-final`, including `proof.json`, the run
manifest, launch descriptor, transport record and both profiles. Credentials
were neither copied into evidence nor persisted as environment values.

Live manifest SHA-256 evidence:

- Executor profile: `27366eccb1302bf2a4ff236ea23574e378850f60e695312584de1d6d022dc35b`
- Client profile: `75b62f727298d73f2438eb737db53b95a0e40972116fe811bc2e61b8d2c2c81d`
- Launch descriptor: `80c6704458e138feaa938828683904f99adb6a873fee7b0c2c4c3eba57c24603`

## Operator review

On the pushed issue branch, follow MOV-401's Manual Verification checklist
and the [local containment gates](../operators/local-execution.md#security-model).
Inspect both profiles, immutable environment routing, version pin, successful
and denied tool results, and manifest hashes. Record tester/date and explicit
sign-off in the issue/PR before ready promotion, daemon deployment or retrying
MOV-399. A restart alone does not repair the original policy collision.

`exec-server` is experimental in installed CLI help. Re-prove this arrangement
after a CLI/OS upgrade before updating the version allowlist. Reference:
[official CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
