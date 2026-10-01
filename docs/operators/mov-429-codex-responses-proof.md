# Contained Codex Jev Responses proof (MOV-429)

This proves one disposable hosted Jev session, not cohort activation. The
dispatcher supplies no production transport resolver and both production
policy-hash allowlists remain empty. MOV-431 owns any subsequent activation.
Subscription routing remains unchanged.

## Automated evidence before paid traffic

On the pushed issue branch, outside the dispatcher worker sandbox on native
macOS with installed `codex-cli 0.157.1`, run:

```sh
npx vitest --config vitest.integration.config.ts --run tools/dispatcher/test/codex-containment.integration.test.mjs tools/dispatcher/test/jev-trial.integration.test.mjs
npm run verify
```

The disposable fake provider drives the real client's read, apply-patch and
exact verification tools. Implementation and repair fixtures deny TCP, UDP,
Unix sockets, key reads and protected filesystem access. Provider failures,
refusals, malformed tools, missing attribution and request caps stop the
route. No fake key is a live credential and no skip is native evidence.

Review those results before recording a paid-proof authorization. A missing
live preflight does not prevent implementation or fake-provider tests.

## Human-led preflight and one-use authorization

Adam reviews the MOV-425 boundary and confirms current dedicated-key/workspace
eligibility, no account/key ZDR or data-collection restriction, prompt logging
off, available credit, the $69 TOTAL key limit and the $75 all-in arm ceiling.
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
  "issue": "MOV-429",
  "owner": "Adam Moore",
  "ownerApproved": false,
  "securityReviewPassed": false,
  "effectiveEligibilityUnrestricted": false,
  "promptLoggingOff": false,
  "zdrOff": false,
  "dataCollectionUnrestricted": false,
  "keyLimitUsd": 69,
  "allInCeilingUsd": 75,
  "availableCreditUsd": 0,
  "keyRemainingUsd": 0,
  "allInOutlayUsd": 0,
  "keyId": "DEDICATED_KEY_IDENTIFIER",
  "workspaceId": "DEDICATED_WORKSPACE_IDENTIFIER",
  "maxRequests": 6,
  "reviewedAt": "REVIEW_TIME_UTC",
  "expiresAt": "EXPIRY_TIME_UTC"
}
```

Run once in the human-led Mac session:

```sh
node tools/dispatcher/src/openrouter-proof.mjs
```

Before guarded startup, an anonymous read-only preflight fetches OpenRouter's
public `/api/v1/models` catalogue and preserves only `id`/`canonical_slug`
identities. The observer compares canonical identities so a response alias
and its dated revision do not create a false conflict. Catalogue defaults and
prices never supply served effort or billed cost. Failure to fetch/validate
the catalogue stops before paid traffic. This does not add an executor or
broker network destination.

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

Only the broker opens the key. The executor and its descendants have no
network or key access; the guarded client can contact only the broker and
executor ports. The proof's scoped policy approval is supplied only by this
command and cannot activate either production policy allowlist.

## Outcome and review

The command preserves `proof.json`, manifest, redacted transcript, native
profiles, exact verification evidence and bounded request accounting under
the printed temporary evidence directory. Copy needed redacted evidence to a
durable location and link it from MOV-429 before temporary-file cleanup.
Never commit the approval file, key or raw provider payloads.

The broker observes split SSE frames, including standalone terminal router
metadata. It reports the served response model, the unique selected endpoint,
actual `usage.cost`, response/generation ID and reported token/cache counters.
Missing fields stay null. `reasoning.effort` can echo the request and is not
treated as served effort: the observer requires an explicit
`jev-router` pipeline `data.reasoning_effort` report. That optional field's
availability is a live-proof question, not a claim about the provider schema.
Missing it produces `missing-provider-attribution` and a no-go. Cache-write
counters that are not exposed remain null. No charge is derived from pricing.
Accounting identifies its source as `openrouter-responses`; usage/export uses
the same manifest attempt ID and the admission spend ledger deduplicates by
provider generation/invoice ID.

`openrouter-attribution.jsonl` also retains the canonical model identity and
up to 32 bounded Jev-stage field names. It never saves arbitrary plugin data,
prompt text or tool payloads. A schema gap remains a no-go and can be
investigated using these diagnostics during a separately authorized proof.

A go requires a completed real file-edit tool, exact `npm run verify` passing,
a non-Anthropic selected model completing the tool round, and complete
attribution. Cross-check generation IDs and actual billed amounts with
OpenRouter Activity/invoice records and retain the redacted reconciliation.
An HTTP error, unsupported protocol/tool response, refusal, timeout, outage,
missing metadata or absent non-Anthropic proof is an explicit no-go. There is
no subscription, worker, model or provider substitution after failure.

Review the pushed draft branch's manual checklist and attach the outcome to
MOV-429. A provider incompatibility is a valid documented no-go, not permission
to weaken confinement. Keep the cohort disabled in either outcome; do not
promote the PR until required human review and evidence are complete.
