# MOV-429 readiness evidence

MOV-429 remains unfinished in Agent Working; PR #823 stays draft. The owner requested continued investigation within this issue. Both production policy
allowlists remain empty, the dispatcher has no transport resolver, and MOV-431
stays held. No cohort has been activated.

## Automated and native evidence

On native macOS with installed `codex-cli 0.157.1`, exact `npm run verify`
passed: production build, 2,480 unit tests (one pre-existing skip) and 406
integration tests. The native containment suite executed without skips.
Fake Responses prove read/edit/verification with socket, key and filesystem
denials in implementation and repair. Failure fixtures stop without fallback;
admission requires matching transport and invoices are deduplicated.

The diagnostic checks actual edits, verification, debug redaction, fragmented
SSE, model/effort conflicts, nested hints and bounded trusted debug gating.

## Two prior live attempts

Human testing: required. Adam separately approved two sessions after account
checks; no policies changed or credits were purchased. Private evidence stays
local. Both opted into metadata: the first exposed alias normalization, now
fixed; the second lacked attributed effort. Neither completed an edit/tool
round; the original top-level expectation did not prove nested effort absent.

## Prepared diagnostic and remaining work

A [community provider-effort report](https://www.reddit.com/r/DeepSeek/comments/1vdqjwr/openrouter_reasoning_effort_levels_are_broken_for/)
led to OpenRouter's [documented Responses debug envelope](https://openrouter.ai/docs/api_reference/errors-and-debugging).
The broker extracts validated model/effort scalars and strips whole debug
frames before Codex/logs. Nested candidate/default effort is discovery only.
A [Codex fallback report](https://github.com/openai/codex/issues/44529) explains
the absent custom patch tool; the supported shell patch path is proved natively.
Unoffered tools stop without spoofing capabilities or weakening containment.

Forwarded effort is not provider-internal behavior. Debug stays off in
production; diagnostic success has `cohortReady: false`. MOV-429 still needs
normal-metadata effort and a real tool loop without debug.

## Later paid diagnostics and corrections

Adam authorized both diagnostics using recorded MOV-424 safeguards. The third
exposed Azure native-ID correlation; normalization now admits OpenAI/Azure and
rejects other revisions. The fourth used two requests to read/edit with matched
forwarded effort, then stopped on `client-disconnected` before verification.
Provider-reported charges remain private, without Activity reconciliation.
No automatic paid retry or credit purchase ran; candidate effort is not served
attribution.

[Codex source](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs)
and a [community terminal-event report](https://github.com/earendil-works/pi/issues/1961)
confirm clients stop at completion before HTTP EOF. The broker now holds its
bounded completion tail until upstream EOF and records final metadata before
forwarding completion. Early disconnects still fail. Native fixtures delay
EOF to reproduce the race and use the actual disposable verifier; a newline
escaping error in that verifier is also fixed. MOV-429 remains unfinished.
See the [proof runbook](../operators/mov-429-codex-responses-proof.md).
