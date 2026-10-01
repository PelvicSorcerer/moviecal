# Contained Codex Jev Responses proof (MOV-429)

This disposable proof keeps subscription routing unchanged and the cohort off.
The dispatcher has no production transport resolver; both policy allowlists
remain empty. MOV-431 owns activation.

## Automated evidence before paid traffic

On the pushed issue branch, outside the dispatcher worker sandbox on native
macOS with installed `codex-cli 0.157.1`, run:

```sh
npx vitest --config vitest.integration.config.ts --run tools/dispatcher/test/codex-containment.integration.test.mjs tools/dispatcher/test/jev-trial.integration.test.mjs
npm run verify
```

The fake provider drives real read/edit/verification and implementation/repair
socket, key and filesystem denial checks. Failure fixtures and request caps
stop without fallback. Review native results before paid authorization;
missing live preflight does not prevent implementation or fixture tests.

## Human-led preflight and one-use authorization

Adam reviews the MOV-425 boundary and confirms current dedicated-key/workspace
eligibility, no account/key ZDR or data-collection restriction, prompt logging
off, available credit, the $69 TOTAL key limit and the $75 all-in arm ceiling.
For a later diagnostic, the owner may explicitly direct reuse of recorded
account safeguards. Record that basis rather than claiming a fresh check.
Inspect metadata only; never reveal or copy the key into a prompt or shell.
Do not modify shared workspace policies or the existing Default key. This
command does not buy credits or change any account setting.

After review and explicit authorization, save the following at
`~/.config/moviecal/jev-proof-approval.json`, owned by the operator, mode 600.
Replace timestamps, key/workspace identifiers and monetary figures with actual
observations, and set confirmation fields true only after review. The example
deliberately refuses to run. The expiry must be within one hour of review.

```json
{
  "issue": "MOV-429", "owner": "Adam Moore", "ownerApproved": false,
  "securityReviewPassed": false, "effectiveEligibilityUnrestricted": false,
  "promptLoggingOff": false, "zdrOff": false, "dataCollectionUnrestricted": false,
  "keyLimitUsd": 69, "allInCeilingUsd": 75,
  "availableCreditUsd": 0, "keyRemainingUsd": 0, "allInOutlayUsd": 0,
  "keyId": "DEDICATED_KEY_IDENTIFIER", "workspaceId": "DEDICATED_WORKSPACE_IDENTIFIER",
  "maxRequests": 6, "reviewedAt": "REVIEW_TIME_UTC", "expiresAt": "EXPIRY_TIME_UTC"
}
```

Run once in the human-led Mac session:

```sh
node tools/dispatcher/src/openrouter-proof.mjs
```

An anonymous `/api/v1/models` preflight validates and saves `id`/`canonical_slug`
identities before paid traffic. Catalogue aliases resolve identity only; defaults
and prices never supply effort or charges. No broker/executor destination is added.

The command consumes an exclusive `.used` fuse beside the approval before launching
the provider, creates a non-private disposable Git repository under the Mac
temporary directory, and requests only `typesafe/jev-router` at
`https://openrouter.ai/api/v1/responses`. One tool-loop session may need up to
six Responses requests; automatic HTTP/stream retries are disabled. The
existing dedicated key limit is the monetary hard boundary, under the
approved $75 all-in arm ceiling. A request-count bound is not a dollar-price
estimate. Record actual key usage and all fees, and never purchase additional
credit as part of this proof. Removing the fuse requires a new owner review;
do not automatically retry a failed paid proof.

Only the broker opens the key; executor descendants retain network/key denial.
The guarded client reaches only broker/executor ports. Scoped proof approval
cannot activate production allowlists.

## Outcome and review

Preserve private `proof.json`, manifest, redacted transcript, native profiles,
verification and request evidence before temporary cleanup. Link the private
location from MOV-429; never commit approval, credentials or raw payloads.

The broker holds a bounded completion tail until upstream EOF, records final
metadata, then forwards completion because Codex stops reading at that event.
Early disconnects, malformed streams and timeouts still stop. It records the
served model, unique selected provider, generation ID, actual `usage.cost` and
reported token/cache counters with source `openrouter-responses`. Admission
accounting deduplicates invoices; manifest attempt IDs link usage/export.
Missing fields stay null; no cost or effort is inferred from catalogue prices.
Responses `reasoning.effort` may echo the caller and is not served attribution.
The proposed Jev pipeline `data.reasoning_effort` path remains unproved live.
Private `openrouter-attribution.jsonl` preserves canonical identity and up to
32 stage field names, never arbitrary plugin data. Missing attribution stops;
investigate schema gaps in a separately authorized disposable diagnostic.

### Disposable effort diagnostic

The broker requests `debug.echo_upstream_body: true` using the documented
[Responses debugging event](https://openrouter.ai/docs/api_reference/errors-and-debugging).
Only capped disposable proofs enable it; caller debug is rejected and production
keeps it off. Whole debug frames are stripped before Codex/logs; normal Unicode
SSE and backpressure remain intact. No arbitrary upstream body is persisted.

Validated model/effort scalars require catalogue-correlated final model
identity (including OpenAI/Azure native IDs) and matching provider-attempt/debug
counts. Conflicts, unknown efforts and ambiguity stop. Source `upstream-request`
proves forwarding, not internal reasoning; token budgets never imply effort.

The private attribution file also records up to 16 nested Jev effort hints,
with bounded paths and enum values only (depth 8, 1,024 visited nodes/entries).
These are discovery hints, not accepted attribution: a candidate or default
effort can differ from the selected value. Compare them with the forwarded
effort to identify a normal metadata path before implementing cohort support.

Codex uses fallback tool metadata for the literal router slug. Its native
custom `apply_patch` tool is absent; the disposable brief uses the supported
`exec_command` shell patch path, which the native fixture proves produces a
real file edit. The broker rejects calls to tools/types the client did not
offer. It does not add tools or spoof a known model's capability catalogue.

OpenRouter documents debug echo for development, not production. A successful
debug tool loop is labeled `diagnostic-pass`, with `cohortReady: false`; it
does not establish a supported normal-metadata effort source. Continue MOV-429
to resolve that source and prove the route without debug before activation.

A successful tool-loop diagnostic requires a completed real file-edit tool, exact `npm run verify` passing,
a non-Anthropic selected model completing the tool round, and complete
attribution. Cross-check generation IDs and actual billed amounts with
OpenRouter Activity/invoice records and retain the redacted reconciliation.
An HTTP error, unsupported protocol/tool response, refusal, timeout, outage,
missing metadata or absent non-Anthropic proof is an explicit no-go. There is
no subscription, worker, model or provider substitution after failure.

Review the pushed draft manual checklist and record the outcome in MOV-429.
Keep the cohort disabled and the PR draft until required review/evidence pass.
