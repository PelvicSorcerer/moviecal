# MOV-415: Claude command network isolation decision

**Status:** No go for production. Design and disposable proof recorded 2026-09-30; owner review required. This decision does not change a worker profile, tool list, daemon, credential source, or rollout state.

## Context and threat

The installed Mac runs macOS 27.0 (26A428), Claude Code 2.1.282, Node 24.16.0 and `/usr/bin/sandbox-exec`. `worker-spawn.mjs` puts the whole Claude process and all descendants under the generated allow-default Seatbelt profile. That profile blocks Git, `gh`, SSH, selected credential reads, protected writes and Git metadata writes, but allows arbitrary sockets so the same process can call the subscription-backed provider. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` removes provider tokens from Bash, hook and MCP child environments. It does not remove the parent's network authority or restrict a child socket. `security-policy.mjs` audits commands after execution; a general Node TCP command is classified `allow`. Neither the scrub nor audit prevents exfiltration.

The adversary is model-generated tool input, repository content, package scripts and their descendants. Required command confinement means **zero outbound command sockets**, including loopback, TCP, UDP, Unix-domain sockets and broker-assisted routes; the trusted provider client alone may reach its provider. Model code must not read provider credentials or Keychain, protected files, sibling/main checkout data, or change shared Git metadata. Allowed worktree edits, synchronous builds and repair work must still function. A domain allowlist for all Claude descendants would leave command egress and would not meet this goal.

## Supported interface review

| Route | Finding |
| --- | --- |
| Keep the current outer guard and disable Claude's own sandbox | Provider and ordinary tools work, but `Bash` and its descendants retain direct sockets. **Fails command isolation.** |
| Add network denies to the existing whole-process Seatbelt profile | Denies the provider client too. Even one unrelated deny makes a nested `sandbox_apply` fail with exit 71 on this OS. Claude's built-in Bash sandbox cannot be layered inside that profile. **Fails provider/command split.** |
| Enable Claude's built-in strict Bash sandbox under an allow-only outer profile | The built-in sandbox is a supported per-command feature, with `sandbox.failIfUnavailable` and `allowUnsandboxedCommands: false`. The allow-only outer profile loses the existing OS-level protected-file, sibling and Git boundaries for the built-in Read/Edit/Write tools, which run in the Claude process rather than in the Bash sandbox. Domain restrictions also permit command egress to those domains. **Fails equivalent confinement.** |
| CLI permission prompt tool or Agent SDK `canUseTool` | These are permission decisions, not a supported substitute execution transport for an approved built-in Bash call. Denying Bash and exposing a different tool changes the tool protocol. **Not a drop-in split.** |
| Disable built-in Bash and expose a trusted command MCP tool | Claude documents custom MCP tools. A separately launched, strict Seatbelt sibling could execute each requested command while the network-capable Claude client retained built-in file tools behind the existing outer guard. The MCP entry point, local IPC, process ownership, immutable config, authentication, fail-closed startup, file-tool boundaries, subscription startup and structured result correlation are **not yet proved** on the installed CLI. Starting an MCP child under the current outer guard and applying strict Seatbelt inside it reproduces the nested collision; a sibling supervisor is required. **Candidate, not approved design.** |
| Whole-process sandbox runtime, container or VM | A whole-process boundary covers built-in file tools, hooks and MCP, but provider egress still needs a trusted proxy; command traffic to an allowed provider domain remains egress. A VM/container requires a separate credential, checkout, build, publication and operator model. Docker/cloud installation is outside this issue. **Explicit alternative, not a local proof.** |

Anthropic's [sandbox documentation](https://code.claude.com/docs/en/sandboxing) distinguishes Bash isolation from built-in file tools and warns that allowed domains and Unix sockets are not a zero-egress boundary. Its [environment comparison](https://code.claude.com/docs/en/sandbox-environments) covers whole-process runtime and VM tradeoffs; [secure deployment guidance](https://code.claude.com/docs/en/agent-sdk/secure-deployment) recommends placing credentials outside the agent boundary. Installed CLI help exposes `--mcp-config`, `--strict-mcp-config`, `--tools`, `--permission-prompts none` and `--bare`, but no Codex-like `exec-server` or Bash executor switch. This is an observation for version 2.1.282, not a claim that future Claude releases cannot add one.

## Disposable native proof

Run `node tools/dispatcher/bin/mov415-claude-network-proof.mjs` **outside an existing worker sandbox** on macOS. The proof makes a temporary Git main/own/sibling fixture and fake home, starts occupied loopback TCP and Unix listeners and a fake Anthropic SSE provider, and invokes installed Claude Code behind the actual generated implementation and repair profiles. It uses `--bare` and `ANTHROPIC_API_KEY=fixture-not-secret` to avoid any Keychain or subscription credential read. It never contacts an external provider and does not mutate the dispatcher. The script asserts expected results, prints a bounded summary and removes its temporary fixture on completion. Set `MOV415_KEEP_EVIDENCE=1` only during local diagnosis to retain the detailed fixture and transcript. Only the bounded, sanitized [proof summary](evidence/mov-415-native-proof.json) belongs in the PR; raw temporary transcripts and request bodies do not.

| Control | Implementation | Repair |
| --- | --- | --- |
| Fake provider plus installed Claude `Read` | completed | completed |
| Bash creates allowed `src/fixture.txt` | completed | completed |
| Literal Bash `npm run verify` | command and fixture build completed; readiness parser says `incomplete` | same |
| Installed Claude Bash connects to occupied TCP endpoint | `CONNECTED` | `CONNECTED` |
| Direct native TCP / UDP / Unix control under current guard | `CONNECTED` / `SENT` / `CONNECTED` | same |
| Spawned command descendant connects to occupied TCP endpoint | `CONNECTED` | `CONNECTED` |
| Sibling, main and fake credential reads; Git metadata write | `EPERM` | `EPERM` |
| `AGENTS.md` write | `EPERM` | `EPERM` |
| `docs/operators/` write | allowed by current implementation policy | `EPERM` |
| Strict Codex-style command profile: TCP / UDP / Unix | `EPERM` / `EPERM` / `EPERM` | profile independent of mode |

The positive TCP and Unix listeners distinguish a real network denial from connection refusal. UDP `SENT` shows the socket send was admitted; it does not claim a recipient received a datagram. The strict profile is a native **candidate command boundary**, not a working Claude transport. Interleaved nested native controls returned inner exit 0 with pure `(allow default)`, and inner exit 71 (`sandbox_apply: Operation not permitted`) with either one unrelated deny or the real Claude profile. The installed Claude loop used the current outer profile without enabling its inner sandbox, so it had no nesting failure while demonstrating the socket leak.

### Verification evidence seam

The installed fake-provider run emitted a correlated Bash `tool_use` for exact `npm run verify`, a linked `tool_result`, and the fixture wrote `src/verified.txt`. Its successful result text was the npm output only; there was no `Exit code: 0` line or task-completion event. `captureVerificationEvidence()` correctly returned `incomplete`. Therefore a custom MCP command transport **must not** forge a Bash event or infer success from the worker's prose or the presence of output. A future implementation must record a trusted, correlated custom-tool completion with the exact command and numeric exit code, distinguish attempted/startup failure from completed execution, and update both readiness and security audits and usage summaries for that new event shape. A missing, malformed, duplicate or uncorrelated completion must remain incomplete. The exact command must still be `npm run verify`; no wrapper, pipeline or `|| true` is accepted.

### Limits and failure table

The fake provider proves installed CLI parsing, tool dispatch and provider transport under a fake API key. `--bare` deliberately skips Keychain and does not prove subscription-backed startup. The proof did not launch an MCP server, hook, `Task` subagent, native `Write`/`Edit` call, or a whole-process VM, and did not establish trusted broker IPC. Existing `worker-guard-sandbox.integration.test.mjs` and `codex-containment.integration.test.mjs` cover their respective current filesystem and Codex native boundaries; this issue does not weaken or replace them. A strict command profile by itself fails as a Claude whole-process profile because the provider cannot reach the fake endpoint, and nested application fails. No result in this proof authorizes deployment.

The follow-up must close every tool and subprocess path before calling a transport viable:

| Surface | Required gate |
| --- | --- |
| Built-in Bash, PowerShell/REPL/Monitor, shell mode, background tasks | Unavailable in the network-capable client; effective `system/init` tools and an attempted call must confirm refusal. No permission prompt or unsandboxed retry. |
| Custom MCP command tool | Exact single schema, protected config and server code, authenticated local IPC, strict sibling process, complete exit/status correlation and bounded output. No arbitrary URL or pass-through socket request. |
| Built-in Read/Edit/Write/NotebookEdit, Glob/Grep | Preserve the whole-client OS file guard; test protected reads/writes and worktree-only edits. A permission rule alone is insufficient. |
| Hooks, plugins, skills, project MCP, slash commands, `Task` agents | Disabled or proven to expose no code execution or alternate tool path. An `init` mismatch is a startup failure, not a warning. |
| Package scripts, compiler helpers and process descendants | Inherit the strict command profile, remain in the managed process group and have no TCP/UDP/Unix or Mach broker egress. |
| Provider client, Keychain and credential source | Client-only access with authorized disposable subscription fixture; no secret in executor environment, argv, config readable by commands, logs or manifest. Invalid auth fails closed. |

## Decision and follow-up contract

**No supported, installed route has passed every constraint.** Keep the current adapter unchanged and treat command networking as an open security gap. The most promising local design is a trusted, separately launched MCP command sibling with an immutable, bounded tool schema and no generic network-capable command path in the Claude client. A supervisor would start both guarded processes in one managed process group, authenticate and constrain local IPC, deliver commands only to the strict executor, and fail closed if either profile, server, client tool set or transport is missing. The client must retain OS protection for built-in file tools; the executor must retain repair and Git protections. No client-accessible provider or broker credential may reach a command, argv, transcript, manifest or worktree file. This paragraph is a testable candidate, not an approved architecture.

Before implementing MOV-425 or enabling any provider routing, the owner must review this no-go result and decide whether to fund a separate, bounded MCP-sibling proof or choose a whole-process VM/proxy design. The MCP proof should be one issue with native Mac gates for implementation and repair, installed Claude file tools and custom tool, normal subscription startup in an authorized disposable account, missing/invalid server and profile, alternate command channels, TCP/UDP/Unix/Mach brokers, protected and sibling/main/Git paths, exact verification correlation, and process-group cleanup. It must show no fallback to built-in Bash and no exposed credential. Only after that proof and owner approval should MOV-425 implement production transport/credential isolation; MOV-425's existing dependency on MOV-415 remains substantive. Rollout remains a separate owner decision. The current proof cannot satisfy MOV-425's live activation gate.

No production policy, argv, environment or protocol contract is introduced by this design issue, so there are no new production unit tests. The disposable script has executable native assertions. Unit coverage for the eventual client tool allowlist, broker request schema, profile and credential arguments, setup failure, transcript correlation and readiness parser belongs to the proposed MCP proof and MOV-425 implementation; no part of that coverage is waived by this decision.
