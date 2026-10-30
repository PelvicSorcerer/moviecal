# Guarded Codex Jev cohort (MOV-437)

## Patch calls from routed models (MOV-479)

The MOV-476 run log records Codex rejecting the routed model's
`apply_patch` call with `unsupported call: apply_patch`; the broker then
stopped the route with `unsupported-tool-response`. Codex's unknown-model
request did not offer its native custom-grammar patch tool, so the routed
model's call could not reach the executor. The retained worker transcript
does not include the rejected call's patch arguments.

For the Jev arm, the protected broker now adds a standard JSON-schema
`apply_patch` function with one required string field, `patch`. It converts
the completed function call to Codex's offered `exec_command` and invokes
the installed patch executable with a quoted heredoc inside the existing
executor sandbox. Invalid arguments, incomplete patches, paths outside the
worktree, and symlink escapes become clear failing tool results so the model
can retry. The sandbox and post-run audit continue to protect repository
policy paths. Fixed controls and Codex runs without Jev retain their native
tool path. The fake-provider integration test covers a non-OpenAI-style call;
the disposable OpenRouter proof prompt now requests this function directly.
After this fix lands, MOV-476 can be re-queued under the same Jev policy.

This production route is **off by default**. MOV-437 supplies the guarded
execution and accounting boundary; MOV-431 owns the later owner/security
decision, actual matched issue selection, account review, activation, paid
traffic, and stop. The disposable MOV-429 proof approval and fixture bypasses
cannot activate this route. The older `dispatcher jev` admission ledger remains
separate and has no production transport approval.

## Prepare and review

The operator prepares two owner-owned, unlinked mode-600 JSON files outside the
repository, under `~/.config/moviecal/`. No key value appears in either file.
`jev-cohort.json` starts with `enabled: false` and a complete `policy` object.
`jev-cohort-approval.json` is a second, owner-reviewed attestation. The
dedicated `openrouter-jev.env` remains the only key source and is opened only
by the trusted broker. The exact policy digest is SHA-256 of the prefix `moviecal-jev-cohort-policy-v1` and a newline, then
`JSON.stringify(policy)`; changing any policy field invalidates approval.
`MOVIECAL_CONFIG_DIR` may relocate the cohort state independently of the key
store. The broker keeps the actual credential home; both the model client and
command executor are denied reads of the relocated cohort directory. Config,
approval and ledger reads validate and read the same no-follow descriptor.

The policy identifies one trial, `route: "codex-openrouter-responses"`,
explicit UTC `activatedAt` and `expiresAt` no more than 14 days apart, and
`pairs` containing 1–12 preselected `{ "routed": "MOV-N", "control": "MOV-N" }`
objects. IDs cannot repeat. Routed issues need `router:jev`; both sides must
resolve to `worker:codex`. Excluded labels (`human-only`, high risk, auth,
security, database, deployment, migrations and secrets) refuse admission.
The `control` object pins `worker: "codex"`, a concrete Responses `model`, served `provider`,
and a separate lowercase API routing `providerSlug` (for example,
`provider: "OpenAI"` with `providerSlug: "openai"`),
`effort`, and dispatcher model `tier`; `routed` pins `typesafe/jev-router`,
Codex, and the same matched `tier`. `modelAliases` is an identity-only snapshot reviewed for the selected
models. It maps observed aliases to canonical model IDs, never prices or
default effort. A changed alias map invalidates approval.
Fixed controls send the reviewed `providerSlug` in `provider.only`, with
`allow_fallbacks: false` and `require_parameters: true`, as documented in
[OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).
Served model, provider and effort must still match the approved control.

The policy also names the dedicated `keyId`, `workspaceId`, the `$69` TOTAL
key limit, `$75` combined ceiling, `baselineKeyUsageUsd`, `priorOutlayUsd`,
and `purchaseFeesUsd`. The latter two record the owner-approved MOV-424
accounting basis before this cohort, including earlier paid proof outlay and
purchase/platform fees as applicable. They are not assumed zero. Do not count
the same historical charge in both values. Later fees use unique fee IDs in
the durable ledger. The owner reviews these numbers against key usage and
available credit without exposing the credential. Activation refuses unless
`priorOutlayUsd + purchaseFeesUsd + (69 - baselineKeyUsageUsd) <= 75`.
This bounds the full remaining key liability, including an unfinished request,
without estimating token prices or relying on currently available credit.

Approval must name `issue: "MOV-431"`, `owner: "Adam Moore"`, set
`ownerApproved`, `securityReviewPassed`, `accountPolicyReviewed`,
`effectiveEligibilityUnrestricted`, `promptLoggingOff`, `zdrOff`,
`dataCollectionUnrestricted`, `priorOutlayBasisReviewed`,
`existingCreditOnlyReviewed`, `hardKeyCapReviewed`, and
`dedicatedKeyExclusiveReviewed` to `true`, set
`paymentBound: "dedicated-key-total-limit"`, and bind
the exact `policySha256`, `keyId` and `workspaceId`, repeat the `$69` and `$75`
limits, and include numeric `availableCreditUsd`, `keyRemainingUsd`,
`totalCreditsUsd` and `totalUsageUsd` (the difference must equal available credit),
`reviewedAt` and `expiresAt` in UTC. Approval expiry cannot outlive policy
expiry. These fields are an operator attestation of a concrete account review;
a bare hash is insufficient. The live broker checks current key usage and
available credit before every paid request. Unknown or changed evidence stops
the cohort. The owner must establish that the dedicated key's $69 total limit
is hard for every billable request, including one in flight, cannot overshoot,
and no other workload uses that key. If the provider cannot establish those
facts, keep activation disabled until an enforceable dedicated-key or provider
payment constraint exists. Available credit alone is not an in-flight bound.
Existing credit may be below unused key allowance; this approval authorizes
no purchase or top-up.
The broker also compares its protected attempt snapshot with the current
approval before each payment, including after the account lookup. Changed
policy or aliases refuse traffic rather than continuing under stale approval.
It checks approval again before terminal success. If approval is revoked in
flight, the completed invoice remains attributed to the original assignment,
but the turn fails and further requests stop.

## Commands and lifecycle

After review, on the pushed branch and outside a worker sandbox:

```sh
node tools/dispatcher/bin/dispatcher.mjs jev-cohort status
node tools/dispatcher/bin/dispatcher.mjs jev-cohort preview --issue MOV-N
node tools/dispatcher/bin/dispatcher.mjs jev-cohort activate
node tools/dispatcher/bin/dispatcher.mjs jev-cohort stop
node tools/dispatcher/bin/dispatcher.mjs jev-cohort export
node tools/dispatcher/bin/dispatcher.mjs jev-cohort reconcile [--apply] [--min-age-sec N]
node tools/dispatcher/bin/dispatcher.mjs jev-cohort fee --id PURCHASE_FEE_ID --usd 0.00 --description purchase-fee
```

`status`, `preview`, and `export` are read-only. `activate` validates the
approval and switches the reviewed config on; this is a MOV-431 action, not
part of MOV-437 verification. `stop` makes new admission and the next paid
request fail immediately without restarting the daemon. It retains all
assignments, reservations, invoices, fees, and stop reason. A stopped ledger
cannot simply be reactivated; a new reviewed cohort needs a fresh ledger and
policy. `fee` records a real charge once by unique ID and stops payment pending
new owner reconciliation; a conflicting replay is rejected. `export` contains
bounded identity and numeric accounting only,
and joins to the existing per-request `routing-decisions.jsonl` and
`usage export` evidence by issue, attempt and invoice. Retain accepted outcome
and review-time joins separately for MOV-431.

The broker asks OpenRouter's key and credit metadata endpoints for current
`limit`, `usage`, `limit_remaining`, `total_credits`, and `total_usage` before
each paid request. It requires the actual `$69` TOTAL key cap. The shared
meter counts routed and control invoices across implementation, resume,
continuation, and repair, plus later fees and the approved prior outlay. It
uses the larger of invoiced charges and the key-usage delta since the reviewed
baseline to avoid double counting while catching charges absent from local
rows. A key-usage increase without matching local invoices refuses payment;
account usage may lag those invoices but cannot authorize unexplained spend.
An increased allowance above the reviewed snapshot also refuses payment.
Liabilities round up to microdollars and remaining capacity rounds down.
Each request durably reserves the remaining liability under the hard
$69 key cap, reduced by actual invoices even when key metadata lags. The
reservation must fit the remaining `$75` all-in ceiling. Available credit
only needs to be positive after accounting for invoices absent from delayed
credit usage; it is never treated as the in-flight cap. One unresolved request
blocks all later paid requests, including after restart, continuation or
repair. A new purchase/top-up changes `total_credits` and stops the next
payment. Unexplained account usage and fees also stop. A crash, unknown invoice,
missing model/effort/provider, protocol error, refused response, fallback, or
account-metadata failure leaves the reservation unresolved and stops further
paid traffic. Human reconciliation is required; no subscription substitution
occurs.
No one should buy credits or use this key from another workload during the
cohort. If an external purchase or fee happens during an in-flight request,
stop immediately and reconcile the retained invoice, account totals, key
usage and all-in basis before a new approval. The key cap remains the
independent bound during that race. Never raise the limit, replace the key or
reset key usage under an existing approval.
Failed final attribution or invoice reconciliation withholds terminal
completion from Codex, so it cannot report a successful turn for that request.
A corrupt ledger, or a missing primary with a retained backup, requires human
reconciliation: the cohort never restores an older backup that could discard
an unresolved paid-request reservation. Keep all ledger evidence for review.

### Provider HTTP errors (MOV-482)
A non-2xx provider response records a bounded diagnostic (status, numeric or
string code, error type, provider name, and a fixed-vocabulary message
category) in `openrouter-attribution.jsonl`; message text, prompts and raw
provider payloads are never stored. A 4xx other than 401/402/403 fails only
that issue's attempt: its broker stops serving, the worker exits non-zero, the
reservation is settled as `failed`, and any key usage the request incurred is
counted as spend. The cohort stays active for the other issues. 5xx responses,
timeouts, 401/402/403 and every spend, identity or attribution failure still
stop the whole cohort.

### Orphaned paid requests (MOV-484)
Every broker failure path (provider 4xx/5xx, timeout, worker disconnect,
SIGTERM/SIGINT) settles the open reservation as `failed`, counting key usage
since the reservation, and appends a bounded record (`requestId`, issue,
`outcome` of `settled` or `unsettled`, reason, amount) to
`openrouter-settlement.jsonl` in the run log directory. A termination signal
or worker death fails only that attempt; the cohort stays active. If the
account read or ledger write fails the cohort stops and the row stays pending.

A hard kill (SIGKILL, crash, power loss) cannot settle, and a pending row puts
the cohort in `pending-invoice`, blocking all paid traffic. Recover without an
archive and re-activation:

1. `jev-cohort reconcile` is a dry run: it reads current OpenRouter key usage
   and prints what it would do.
2. `jev-cohort reconcile --apply` settles. It acts only on requests older than
   `--min-age-sec` (default 300, so a live request is never touched) and only
   when usage is unambiguous: usage unchanged (settled at $0), or the increase
   since the last observation fits within one pending request's reservation.
3. Anything else (usage fell, evidence malformed, usage exceeds the
   reservation, or an increase with more than one pending request) stops the
   cohort with `orphan-reconciliation-<reason>` and exits non-zero. Reconcile
   those against the OpenRouter activity page by hand.

Run it after the worker and broker processes are gone. A key-usage read can lag
a just-finished request; if later usage appears, the next reservation stops
the cohort as unknown exposure rather than under-counting silently.

Fixed controls pin model, provider and effort and send `provider.only`,
`allow_fallbacks: false` and `require_parameters: true`. The broker removes
Codex's optional boolean `parallel_tool_calls` parameter because the
validated strict Responses route omits it; malformed values are refused.
The contained client sets `features.multi_agent=false`. Both arms retain the
same guarded executor and read/edit/shell tools. The Jev model uses the
explicit shell `apply_patch` helper through `exec_command`; check helper
availability in the disposable fixture. Provider failure evidence retains
only bounded HTTP status and an alphanumeric/underscore/hyphen error code of
at most 48 characters, never raw body or credentials. Oversized, malformed or
unsafe codes leave only the HTTP status.

Before MOV-431 ready promotion, review the exact cohort/approval files,
remaining key allowance and fee basis, fake routed and fixed Responses tool
loops, native contained implementation and repair read/edit/verify checks,
denied socket/key/filesystem actions, and untouched subscription routes.
Require model-driven read/edit, a separate exact `npm run verify` command,
zero exit, complete invoices and a terminal report within the reviewed
request cap. A cap refusal while seeking the final report is a failure.
Run the native fixtures **outside** `MOVIECAL_WORKER_SANDBOX=1`; a skip inside
the worker sandbox is not Mac containment evidence. After the cohort ends,
export evidence, reconcile provider invoices and any purchases/fees, stop the
cohort, then revoke the dedicated key in an owner-authorized handoff. Do not
change the shared Default key or account policy during this handoff.

## Continuation effort echo and bad tool calls (MOV-486)

On a continuation turn that lists only an already-proven model, the broker
accepts a served effort that equals the requested effort even when the listed
candidate shows a different one (and the reverse). The candidate, response and
requested efforts are written as `continuationEffort` in
`openrouter-attribution.jsonl`. All other effort mismatches still stop the
cohort.

A tool output carrying Codex's `failed to parse function arguments: invalid
type:` error is appended to `attempt-failures.jsonl` as `worker-tool-format-error`
with the router arm. It is evidence of a failed attempt for that arm, never a
cohort stop, and arguments are not coerced.
