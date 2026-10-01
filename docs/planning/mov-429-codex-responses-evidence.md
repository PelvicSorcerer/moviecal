# MOV-429 readiness evidence

## Implementation and native fixtures

Validated on native macOS with installed `codex-cli 0.157.1`, outside the
dispatcher worker sandbox, on 2026-09-30 (America/Chicago).

- Exact `npm run verify`: production build, 2,464 unit tests and 404
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

## Owner-reviewed live preflight and proof

Human testing: required. Automated evidence is local-agent evidence. Adam
explicitly approved the containment boundary and one bounded paid disposable
session after the draft branch was pushed. The agent operated that session
under his approval, following the proof runbook. No account policies changed,
no additional credits were purchased and input/output logging stayed off.

The read-only preflight checked the dedicated trial key, current eligibility,
logging, limits and existing credit. The existing payment total and live
request were reconciled against the provider's generation and key-usage
records. Detailed generation identifiers, account metadata, token counts and
billing remain in private local evidence, outside tracked source.

Outcome: **no-go**. The original observer directly compared a response alias
with a dated canonical endpoint model, creating a false conflict. Effective
Jev-served effort was also absent. The guarded client stopped unsuccessfully
with verification incomplete. No completed non-Anthropic tool round was
proved, and no automatic retry or subscription fallback ran.

The alias defect is corrected using OpenRouter's public catalogue identity
mapping, with unit and native integration evidence. Different revisions still
fail. Bounded canonical identity and Jev-stage field-name diagnostics now
support investigation of missing served-effort attribution.

After separate explicit owner authorization and a refreshed key/credit/privacy
preflight, the corrected branch ran one bounded diagnostic session. It stopped
after one request with `missing-provider-attribution`, not a model conflict.
The client exited unsuccessfully, verification stayed incomplete, and no
completed non-Anthropic tool round or file edit was proved. Its generation
and exact charge were reconciled privately with the provider's generation
record. No automatic retry, alternate route or additional credit purchase ran.

The bounded diagnostic reports Jev-stage fields including `resolved_models`,
`evaluations`, `candidates` and nested `pipeline`, but no top-level
`reasoning_effort`. Field names alone cannot establish whether deeper data
contains trustworthy served effort. The selected model/provider and actual
usage/charge were reported; served effort remains null. This confirms an
explicit **no-go under the implemented attribution contract**, not a claim
that the provider can never expose effort. A supported schema for deeper
router data and a separately approved proof are prerequisites to reconsidering
that result. The containment and missing-field stops were preserved.

Both production policy lists remain empty. No cohort activation is authorized;
MOV-431 stays disabled unless a later separately approved proof resolves this
no-go. The approval fuse remains consumed. A new owner review is required for
another paid session.
