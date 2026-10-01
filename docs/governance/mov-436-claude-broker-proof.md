# MOV-436: separately guarded Claude command broker proof

**Decision: no go for production.** A disposable native Mac run on 2026-09-30 proved that installed Claude can use a local MCP command tool backed by a separate strict Seatbelt executor. It did not prove the full security or startup contract. MOV-425 remains blocked; this PR changes no dispatcher adapter, worker profile, credential source, queue, or rollout setting. This is an addendum to [MOV-415's decision in draft PR #819](https://github.com/PelvicSorcerer/moviecal/pull/819).

## Installed interface and threat model

The fixture used macOS 27.0, Claude Code 2.1.282, the installed Node runtime, `/usr/bin/sandbox-exec`, and Claude's documented [remote HTTP MCP tool interface](https://code.claude.com/docs/en/mcp). A trusted local Node supervisor launched three separate components: an installed Claude client under the current file-protecting worker profile, an HTTP MCP server outside that client sandbox, and a per-command `sandbox-exec` child under the strict `networkRole: "executor"` profile. The fake Anthropic SSE endpoint listened on localhost. All data, Git worktrees, home files, credentials, and listeners were disposable.

The adversary controls model tool arguments, repository instructions and package scripts. It may ask for arbitrary commands, spawn children or attempt socket, file, Keychain and system-broker access. The local supervisor and exact profile file are trusted for this *fixture only*. The MCP contract accepts `tools/call` with `name: "run"` and a single string `command`; it returns a JSON object with a generated invocation ID, command, numeric exit code, bounded stdout/stderr and spawn error. Each request executes through a fresh strict native profile. The fixture does not authenticate the HTTP MCP caller or prove an immutable supervisor lifecycle. An actual implementation would require both.

The CLI was invoked with `--bare`, `--strict-mcp-config`, an explicit `--mcp-config`, `--tools Read,Edit,mcp__broker__run`, `--allowedTools` of the same set, `--permission-prompts none`, `--disable-slash-commands`, and no session persistence. Its `system/init` tools were exactly `Edit`, `Read` and `mcp__broker__run`. A forced `Bash` call failed with “No such tool available: Bash.” The installed CLI's `--safe-mode` removes the explicit MCP tool in a separate exploratory test, so this fixture cannot claim compatibility with the present production safe-mode setting. `--bare` skips the normal Keychain/subscription startup and used only a fake API key against the localhost provider. Hooks, plugins, project MCP, slash commands and Task were constrained by these flags and the observed tool list; their behavior with subscription-backed startup remains unproved.

## Native result

Run `node tools/dispatcher/bin/mov436-claude-broker-proof.mjs` on a Mac outside an existing worker sandbox. It asserts both modes and deletes the disposable fixture on completion. `MOV436_KEEP_EVIDENCE=1` retains raw transcripts only for local diagnosis; never commit those. The portable, path-free [native proof summary](evidence/mov-436-native-proof.json) is the review artifact.

| Control | Implementation | Repair |
| --- | --- | --- |
| Fake provider and MCP tool loop | 16 provider POSTs; native Read/Edit and broker tool used | Same |
| Allowed broker write and literal `npm run verify` | Completed, numeric exit 0 | Completed, numeric exit 0 |
| Occupied TCP and Unix listeners from trusted supervisor | Connected before the sandboxed run | Same listeners remained occupied |
| Command TCP, UDP, Unix socket and spawned-child TCP | `EPERM` for each | `EPERM` for each |
| Sibling checkout, main checkout, fake credential read | `EPERM` for each | `EPERM` for each |
| `AGENTS.md`, linked `.git`, shared Git metadata write | `EPERM` for each | `EPERM` for each |
| `docs/operators/` write | Allowed by current implementation policy | `EPERM`, matching repair policy |
| `/usr/bin/security` | Process execution denied | Process execution denied |
| `osascript -e 'return 1'` | Ran and returned 1 | Ran and returned 1 |
| Executor provider key environment | `ABSENT` | `ABSENT` |
| Missing / malformed command profile | No command ran / native exit 65 | Mode-independent setup control |

The `osascript` result proves that a system scripting tool is still executable under this strict command profile. The harmless `return 1` probe did not test Apple Events to another process or any Mach service escape. Until system-broker mediation is independently proved or that route is blocked, zero broker-assisted egress is **not established**. The successful native Read/Edit calls exercised allowed paths; the command executor's read/write probes exercised denied paths. Native client file-tool denials should be tested again in any real supervisor implementation.

The literal `npm run verify` returned a broker-generated UUID and numeric exit 0 in a tool result linked to its specific Claude tool-use ID. The fixture matched that ID to the trusted server ledger and checked the command string and exit value. The production `captureVerificationEvidence()` still returned `incomplete`, correctly refusing to treat custom MCP output as a Bash completion. It needs a new trusted custom-tool event and tests that reject missing, malformed, duplicate, forged Bash and uncorrelated completions before any production rollout. The fixture's correlation is proof code, not a production readiness parser change.

## Constraint decision

| MOV-415 constraint | Finding |
| --- | --- |
| Provider client works while command sockets are denied | **Passed only with fake provider and key.** Local provider POSTs and command socket denials were observed in both modes. |
| No general command path in network-capable client | **Passed for this CLI invocation.** Init exposed only Read, Edit and the MCP broker; attempted Bash was rejected. No subscription-backed invocation was tested. |
| Command descendants, worktree and repair boundaries | **Passed for sampled native probes.** Child TCP, sibling/main/credential reads and Git metadata writes were denied; repair-specific write denial held. |
| No alternate broker escape | **Unproved.** `security` was denied, but `osascript` launched; Apple Events and all Mach routes were not exhausted. |
| Trusted transport and fail-closed startup | **Partial.** Missing/invalid profile denied execution. MCP server loss, IPC spoofing, provider loss, immutable config, process-group cleanup and supervisor crash were not proved. The fixture HTTP endpoint has no authentication. |
| Current subscription/Keychain startup | **Unproved.** `--bare` and a fake key bypassed it; `--safe-mode` removed the custom MCP tool in exploratory testing. |
| Exact verification evidence | **Proof-only pass.** Correlated trusted numeric status was available in the fixture; production parser remains incomplete. |

## MOV-425 recommendation

Keep both MOV-415 and MOV-436 as substantive blockers of MOV-425. A human owner should review this no-go proof. The next decision is whether to fund a separately scoped follow-up that proves subscription-compatible startup, system-broker confinement, authenticated local IPC, supervisor failure behavior and production-grade readiness correlation, or switch to a whole-process VM/proxy architecture. Do not turn on OpenRouter routing, alter the production worker, or activate the Jev trial from this result.

There are no new production unit or browser tests because no production behavior changed. The committed script's native assertions cover this disposable proof; the full repository gate is `npm run verify`. Human testing and sign-off remain required under MOV-436 before any dependency decision.
