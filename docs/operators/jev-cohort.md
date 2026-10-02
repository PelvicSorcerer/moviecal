# Guarded Codex Jev cohort (MOV-437)

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
by the trusted broker. The exact policy digest is SHA-256 of
`JSON.stringify(policy)`; changing any policy field invalidates approval.

The policy identifies one trial, `route: "codex-openrouter-responses"`,
explicit UTC `activatedAt` and `expiresAt` no more than 14 days apart, and
`pairs` containing 1–12 preselected `{ "routed": "MOV-N", "control": "MOV-N" }`
objects. IDs cannot repeat. Routed issues need `router:jev`; both sides must
resolve to `worker:codex`. Excluded labels (`human-only`, high risk, auth,
security, database, deployment, migrations and secrets) refuse admission.
The `control` object pins a concrete Responses `model`, served `provider`,
`effort`, and dispatcher model `tier`; `routed` pins `typesafe/jev-router`,
Codex, and the same matched `tier`. `modelAliases` is an identity-only snapshot reviewed for the selected
models. It maps observed aliases to canonical model IDs, never prices or
default effort. A changed alias map invalidates approval.

The policy also names the dedicated `keyId`, `workspaceId`, the `$69` TOTAL
key limit, `$75` combined ceiling, `baselineKeyUsageUsd`, `priorOutlayUsd`,
and `purchaseFeesUsd`. The latter two record the owner-approved MOV-424
accounting basis before this cohort, including earlier paid proof outlay and
purchase/platform fees as applicable. They are not assumed zero. Do not count
the same historical charge in both values. Later fees use unique fee IDs in
the durable ledger. The owner reviews these numbers against key usage and
available credit without exposing the credential.

Approval must name `issue: "MOV-431"`, `owner: "Adam Moore"`, set
`ownerApproved`, `securityReviewPassed`, `accountPolicyReviewed`,
`effectiveEligibilityUnrestricted`, `promptLoggingOff`, `zdrOff`,
`dataCollectionUnrestricted`, and `priorOutlayBasisReviewed` to `true`, bind
the exact `policySha256`, `keyId` and `workspaceId`, repeat the `$69` and `$75`
limits, and include numeric `availableCreditUsd`, `keyRemainingUsd`,
`reviewedAt` and `expiresAt` in UTC. Approval expiry cannot outlive policy
expiry. These fields are an operator attestation of a concrete account review;
a bare hash is insufficient. The live broker checks current key usage and
available credit before every paid request. Unknown or changed evidence stops
the cohort.

## Commands and lifecycle

After review, on the pushed branch and outside a worker sandbox:

```sh
node tools/dispatcher/bin/dispatcher.mjs jev-cohort status
node tools/dispatcher/bin/dispatcher.mjs jev-cohort preview --issue MOV-N
node tools/dispatcher/bin/dispatcher.mjs jev-cohort activate
node tools/dispatcher/bin/dispatcher.mjs jev-cohort stop
node tools/dispatcher/bin/dispatcher.mjs jev-cohort export
node tools/dispatcher/bin/dispatcher.mjs jev-cohort fee --id PURCHASE_FEE_ID --usd 0.00 --description purchase-fee
```

`status`, `preview`, and `export` are read-only. `activate` validates the
approval and switches the reviewed config on; this is a MOV-431 action, not
part of MOV-437 verification. `stop` makes new admission and the next paid
request fail immediately without restarting the daemon. It retains all
assignments, reservations, invoices, fees, and stop reason. A stopped ledger
cannot simply be reactivated; a new reviewed cohort needs a fresh ledger and
policy. `fee` records a real charge once by unique ID; a conflicting replay
is rejected. `export` contains bounded identity and numeric accounting only,
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
rows. Each request reserves the **entire current remaining key allowance**
before going upstream. The key's provider-enforced limit bounds one in-flight
request; another request cannot start until an invoice releases the durable
reservation. The allowance must fit both remaining available credit and the
remaining `$75` all-in ceiling. This is deliberately conservative and does
not present a token-price estimate as an invoice. A crash, unknown invoice,
missing model/effort/provider, protocol error, refused response, fallback, or
account-metadata failure leaves the reservation unresolved and stops further
paid traffic. Human reconciliation is required; no subscription substitution
occurs.

Before MOV-431 ready promotion, review the exact cohort/approval files,
remaining key allowance and fee basis, fake routed and fixed Responses tool
loops, native contained implementation and repair read/edit/verify checks,
denied socket/key/filesystem actions, and untouched subscription routes.
Run the native fixtures **outside** `MOVIECAL_WORKER_SANDBOX=1`; a skip inside
the worker sandbox is not Mac containment evidence. After the cohort ends,
export evidence, reconcile provider invoices and any purchases/fees, stop the
cohort, then revoke the dedicated key in an owner-authorized handoff. Do not
change the shared Default key or account policy during this handoff.
