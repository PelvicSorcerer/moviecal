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

## Continued investigation in MOV-429

The owner directed continued research/fixes in this issue rather than closing
it on a failed proof. MOV-429 is back in Agent Working; the draft PR remains
open and MOV-431 stays held.

Both live attempts already opted into `X-OpenRouter-Metadata: enabled` and
received routing metadata. The missing effort result was produced by our
parser's unverified expectation of a top-level `data.reasoning_effort`; it did
not establish that effort is absent throughout the response.

Community research found a [provider-effort debugging report](https://www.reddit.com/r/DeepSeek/comments/1vdqjwr/openrouter_reasoning_effort_levels_are_broken_for/)
that uses upstream debug echo. This is a diagnostic lead, not evidence that our
selected provider has the report's bug. OpenRouter's [official debugging reference](https://openrouter.ai/docs/api_reference/errors-and-debugging)
documents the Responses `response.debug` envelope containing the transformed
upstream request. The disposable proof now requests that envelope only through
trusted broker configuration, extracts validated model/effort scalars and drops
all debug frames before Codex. It also captures bounded nested metadata effort
hints without treating candidate/default values as selected effort.

The native test exposed a separate fixture error: the fake routed provider
emitted a custom `apply_patch` call that Codex does not advertise for an unknown
router slug. A [Codex fallback-tool report](https://github.com/openai/codex/issues/44529)
describes this mismatch. The corrected routed fixture uses the supported shell
patch path through `exec_command` and verifies the resulting file, rather than
accepting the harness exit code alone. The broker now rejects tool names/types
absent from the client's offered tools. No client capability catalogue is
spoofed and the guarded executor still performs edits.

This is a prepared diagnostic, not a third paid result. Upstream-request effort
reports what OpenRouter forwarded; it cannot establish the provider's internal
reasoning behavior. Debug is a development feature and remains disabled for
production. A passing debug tool loop will be labeled `diagnostic-pass`, with
`cohortReady: false`. MOV-429 still needs an observed, trustworthy effort path in
normal router metadata and a real tool-loop proof without debug before cohort
readiness. The previous paid approval remains consumed.

Exact `npm run verify` on the diagnostic implementation passed: production
build, 2,477 unit tests (one pre-existing skip) and 406 integration tests. Native
Mac containment executed without skips, including debug-frame redaction,
actual shell-patch edit/verification and unsupported-tool stopping.
