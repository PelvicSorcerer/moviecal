# MOV-429 readiness evidence

MOV-429 is unfinished in Agent Working and PR #823 draft. Production policy
allowlists remain empty, no dispatcher transport resolver exists and MOV-431
stays held. The owner requested continued work within this issue.

## Automated and native evidence

Native macOS `codex-cli 0.157.1`: exact `npm run verify` passes production build,
2,488 unit tests (one pre-existing skip) and 407 integration tests, including
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

## Ordinary effort path and remaining proof

The sixth diagnostic also passed. Caller effort was low while terminal response,
unique candidate for the served model and forwarded effort were high on all four
turns. This validates `response-and-jev-selection`: corroborate terminal effort
with the unique model-matched candidate and documented `resolved_models`; never
infer from general candidates, evaluations, probabilities or incumbents.
The temporary shape collector is retired. Ordinary-mode native fixtures pass;
live proof without debug and private invoice reconciliation remain pending.
See the [proof runbook](../operators/mov-429-codex-responses-proof.md).
