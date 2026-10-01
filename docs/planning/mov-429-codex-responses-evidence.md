# MOV-429 readiness evidence

## Implementation and native fixtures

Validated on native macOS with installed `codex-cli 0.157.1`, outside the
dispatcher worker sandbox, on 2026-09-30 (America/Chicago).

- Exact `npm run verify`: production build, 2,461 unit tests and 404
  integration tests passed. One pre-existing unit skip remains; the native
  Codex suite ran and passed rather than skipping.
- Fake OpenRouter Responses drove the actual guarded Codex read/edit/command
  loop and exact verification command. Implementation and repair retained
  socket, key, protected checkout and Git-metadata denials.
- Native outage, timeout, refusal, malformed tool, missing attribution and
  request-cap cases exited unsuccessfully without another upstream call or
  subscription/provider fallback.
- Codex admission validates a matching reviewed route before consuming an
  assignment. Missing/invalid/mismatched transport leaves the ledger
  untouched. Assigned retries preserve attribution; changed worker bindings
  defer. Repeated provider invoice reports count once.
- Both production approval lists remain empty; the production dispatcher
  has no transport resolver. No cohort activation occurred.

## Read-only live-account preflight

Observed from the existing authenticated OpenRouter Safari session on
2026-09-30. No key value was read, account setting changed or credit bought.

- Credits: $19.13 available; automatic top-up disabled. Existing history
  shows a $20 credit transaction; purchase/platform fees still require
  reconciliation before recording the all-in outlay attestation.
- Dedicated `moviecal-jev-hosted-trial` key: $0 usage, $69 TOTAL limit,
  expiry December 29, 2026. Local file remains owner-owned mode 600.
- `moviecal-jev-trial` guardrail: assigned only to that trial key, all policy
  sections unconfigured. The Default key is not assigned to it.
- Inherited Workspace Guardrail: $20 monthly credit limit; no model/provider,
  prompt-injection or sensitive-info restriction. Shared policy was untouched.
- Account ZDR switches: off. Paid/free training endpoint access enabled;
  public-prompt free endpoints disabled. Eligibility preview: 612 available,
  zero unavailable. No provider allow/deny entries.
- Workspace input/output logging and observability broadcast: off.
  Workspace data-discount opt-in: off.

## Remaining human-led proof

Human testing: required. Native and deterministic evidence above is
local-agent evidence, not a human test result.

Review the pushed branch, confirm the boundary and current account preflight,
reconcile existing fees/outlay, then authorize one bounded disposable session
using [the proof runbook](../operators/mov-429-codex-responses-proof.md).
Record the real response/generation IDs, actual charge reconciliation, served
model/provider/effort and exact verification outcome, or an explicit no-go.
Do not enable MOV-431's cohort here.

Paid-proof outcome: pending. No live provider request has been sent by this
implementation session.
