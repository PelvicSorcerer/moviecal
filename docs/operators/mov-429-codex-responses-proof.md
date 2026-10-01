# Contained Codex Jev Responses proof (MOV-429)

This disposable proof keeps subscription routing unchanged and the cohort off.
The dispatcher has no production transport resolver; both policy allowlists
remain empty. MOV-431 owns activation.

## Automated evidence before paid traffic

On the pushed branch, outside the worker sandbox on native macOS with installed
`codex-cli 0.157.1`, run the real-client fake-provider tests and required checks:

```sh
npx vitest --config vitest.integration.config.ts --run tools/dispatcher/test/codex-containment.integration.test.mjs tools/dispatcher/test/jev-trial.integration.test.mjs
npm run verify
```

Fixtures prove real read/edit/verification, TCP/UDP/Unix/key/filesystem denials
in implementation and repair, and visible failure without fallback. No native
skip counts as evidence. Review results before paid authorization; missing live
preflight does not prevent implementation or fixture tests.

## Human-led preflight and one-use authorization

Adam reviews the MOV-425 boundary and dedicated-key/workspace eligibility,
logging off, unrestricted data collection, ZDR off, available credit, $69 TOTAL
key limit and $75 all-in ceiling. The owner may explicitly reuse recorded
safeguards; record that basis without claiming a fresh check. Inspect metadata
only; never expose the key, modify shared policies/Default key, or buy credits.

After explicit authorization, save an operator-owned mode-600 unlinked file at
`~/.config/moviecal/jev-proof-approval.json`. Set confirmations after review;
use actual identities/balances and expiry within one hour. This example refuses:

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
node tools/dispatcher/src/openrouter-proof.mjs --normal-metadata
```

An anonymous `/api/v1/models` preflight saves validated `id`/`canonical_slug`
identity only, never catalogue prices/default effort. It fails before payment.
The command consumes an exclusive `.used` fuse, creates a non-private temporary
Git repo, and requests only `typesafe/jev-router` at the approved Responses URL.
At most six requests run with no automatic HTTP/stream retries. The $69 key is
the monetary hard limit under the $75 all-in ceiling; request count is no price
estimate. Account for actual usage and fees. Removing the fuse requires a new
owner review; do not automatically retry a failed paid proof or buy credits.

Only the broker opens the key; executor descendants retain network/key denial.
The client reaches only broker/executor ports. Proof approval cannot activate
production allowlists. Preserve private proof, manifest, redacted transcript,
profiles, verification and accounting before cleanup; never commit credentials,
approval, generation/billing details or raw provider/debug payloads.

## Attribution and outcome

The broker drains final metadata before sending its bounded completion tail:
Codex stops reading at completion. Early disconnects, timeouts and malformed
streams still stop. It records selected model/provider, invoice ID, actual
`usage.cost`, token/cache counters and source `openrouter-responses`. Missing
fields stay null; admission accounting deduplicates invoices by generation ID
and manifest attempt IDs link export. Responses reasoning can echo caller
configuration. Ordinary attribution requires terminal `reasoning.effort` to
match the unique Jev candidate for the served canonical model, which must also
appear in `resolved_models`. Missing, duplicate or conflicting entries stop.
Collections exceeding 128 entries fail closed. Source is `response-and-jev-selection`,
validated by a live caller-low/response-candidate-upstream-high contrast.

Omit `--normal-metadata` only for a separately authorized diagnostic using the [Responses debug echo](https://openrouter.ai/docs/api_reference/errors-and-debugging)
through trusted configuration only. Caller debug is rejected; production keeps
it off. Whole debug frames are removed before Codex/logs, preserving normal
Unicode SSE/backpressure. Only validated model/effort scalars and bounded field
names are retained. Final model identity must match the selected endpoint via
catalogue mapping (including OpenAI/Azure native IDs), and debug/attempt counts
must match. Conflict, unknown effort or ambiguity stops. Source
`upstream-request` proves forwarding, not provider-internal reasoning.

Private diagnostics retain at most 16 nested effort hints (depth 8, 1,024 visited
nodes), terminal response effort and bounded stage keys. General candidates,
evaluations/probabilities and incumbents never supply attribution. The temporary
selection-shape collector was retired after identifying the ordinary path.

The unknown router slug lacks Codex's custom patch tool; use the supported shell
patch path through `exec_command`. Unoffered tools stop; no capability catalogue
is spoofed. Success requires a completed actual file-change tool, exact
`npm run verify`, a non-Anthropic tool round, exit zero and complete attribution.
Debug success is `diagnostic-pass`; ordinary success is `pass`. Both keep the
cohort disabled pending MOV-431 approval. Cross-check actual bills
against Activity/invoices privately. Protocol/tool/refusal/provider/metadata
failure stops without subscription, worker, model or provider substitution.

Record the outcome in MOV-429. Keep the PR draft and cohort disabled until the
required human review, ordinary attribution proof and invoice evidence pass.
