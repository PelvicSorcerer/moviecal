# MOV-429 readiness evidence

MOV-429 is unfinished in Agent Working and PR #823 draft. Production policy
allowlists remain empty, no dispatcher transport resolver exists and MOV-431
stays held. The owner requested continued work within this issue.

## Automated and native evidence

Native macOS `codex-cli 0.157.1`: exact `npm run verify` passes production build,
2,481 unit tests (one pre-existing skip) and 406 integration tests, including
native containment without skips. Fixtures prove real read/edit/verification,
implementation/repair TCP/UDP/Unix/key/filesystem denial, failure without fallback,
scoped admission and invoice deduplication. Diagnostic coverage includes debug
redaction, fragmented SSE, model/effort conflicts and bounded selection hints.

## Live evidence and corrections

Human testing: required. Adam separately authorized each capped disposable
session, initially after account checks and later explicitly reusing MOV-424
safeguards. No policies changed or credits were purchased. The first two opted
into metadata but exposed alias normalization and missing attributed effort.
The third exposed Azure native OpenAI IDs; the fourth completed read/edit but
stopped on Codex closing at completion before HTTP EOF. Both defects and the
verifier's newline escaping are fixed with unit/native regression coverage.
[Codex source](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs)
and a [community report](https://github.com/earendil-works/pi/issues/1961) confirm
that lifecycle. Unknown-model tool mismatch is covered by a
[Codex report](https://github.com/openai/codex/issues/44529); the supported shell
patch path produces a completed file-change event without spoofed tools.

The fifth session passed actual read/edit/exact `npm run verify`: four requests,
no retries, all attribution error-free, worker exit zero and non-Anthropic tool
rounds. Correlated forwarded effort comes from stripped diagnostic echo;
private proof/charges are preserved without an Activity reconciliation claim.
A [community effort report](https://www.reddit.com/r/DeepSeek/comments/1vdqjwr/openrouter_reasoning_effort_levels_are_broken_for/)
led to the documented [Responses debug envelope](https://openrouter.ai/docs/api_reference/errors-and-debugging).

## Remaining work

Debug stays off in production; success is diagnostic-pass, `cohortReady: false`.
Find trustworthy ordinary effort attribution, prove the loop without debug and
reconcile invoices before readiness. The next diagnostic keeps response,
incumbent and matched candidate effort as separate hints, never served values.
See the [proof runbook](../operators/mov-429-codex-responses-proof.md).
