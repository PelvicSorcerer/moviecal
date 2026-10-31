# Jev Router trial: archived (MOV-431 / MOV-433)

**Status: archived. Decision (MOV-433, 2026-10-31): do not adopt.** The trial infrastructure stays in the repo, disabled by default, so the experiment can be re-run if OpenRouter's Jev Router becomes cost-competitive.

## Why we are not adopting

Both arms delivered: 10 of 10 issues merged for Jev and for the fixed control (GPT-6.1 Sol, medium effort, over OpenRouter Responses). Jev did not save money.

| | Jev | Control |
|---|---|---|
| Spend on 10 issues | $11.68 | $3.32 |
| Billed requests | 338 | 259 |
| Cost per request | $0.0346 | $0.0128 |

- Cohorts 1 and 2 only (the cleaner data): Jev $2.20 vs control $1.31 over 6 issues each, about 1.7x.
- Cohort 3 (harder issues, distorted by harness faults): Jev $9.48 vs control $2.02, about 4.7x.
- Jev matched the control only when it picked the same model and effort (GPT-6.1 Sol, medium). It otherwise routed to `gpt-6-astra`, `gpt-6.1-terra` and `claude-opus-5.5`, or to high effort, and cost 3 to 10 times more per issue.
- Jev was the only arm with provider HTTP 400s and served-effort mismatches. The control had zero of each.
- Total trial spend was about $19.9 all-in (key usage plus $4.40 of purchase fees) against the $75 ceiling. No credits were topped up.
- Not measured: first-attempt success, wall time, human rework. This is a cost and reliability read, not a quality verdict.

Full tables: [final-comparison.md](./final-comparison.md).

## What would make adoption worth revisiting

- Jev picks cheaper models or lower effort than a fixed medium control on comparable issues, with no drop in merged-PR quality. Today it routes up, not down.
- Provider 400s and served-effort mismatches disappear (or are shown to be harness-side only).
- A rerun with a clean harness gives an apples-to-apples cost per merged PR, plus first-attempt success and rework measured.
- Pricing or router behavior changes materially. Re-read OpenRouter's Jev documentation first.

## Open questions left by the trial

- Do Codex tool-call parse errors count against the router? One was seen (MOV-472, a string "false" for a boolean); others in transcripts may be double-counted across retries.
- Why `reconcileStartup` ran mid-worker before #929 is not fully explained; the fix scopes cleanup to the current dispatcher instance.
- "Escalated CI goes unflagged": an observed gap in how the dispatcher surfaces CI escalations; no issue filed yet.
- The Claude arm (MOV-428) and the prismhq proxy arm (MOV-430, MOV-432) were never run and remain in Spec Ready or Icebox.

## How to re-enable (all of it is off by default)

Nothing in the repo turns Jev on. Activation needs owner-controlled state outside the repo under `~/.config/moviecal/` on the Mac, and absent files mean disabled.

1. Read the runbook, [docs/operators/jev-cohort.md](../../operators/jev-cohort.md), and the design, [docs/planning/mov-422-jev-router-trial.md](../../planning/mov-422-jev-router-trial.md). Worker routing details are in [docs/operators/worker-routing.md](../../operators/worker-routing.md) and the Contained Codex Responses proof in [docs/operators/mov-429-codex-responses-proof.md](../../operators/mov-429-codex-responses-proof.md).
2. Create a dedicated OpenRouter key with a hard total limit (the trial used $69 with a $75 all-in ceiling). Store it only at `~/.config/moviecal/openrouter-jev.env`, mode 600. The earlier key should have been revoked at handoff; do not reuse it.
3. Write `jev-cohort.json` (starts `enabled: false`, with a full `policy`: 1 to 12 preselected routed/control pairs, a fixed control model/provider/effort/tier, model aliases, spend accounting) and the owner attestation `jev-cohort-approval.json`. Both are owner-owned, mode 600, and bound to the policy SHA-256. A stopped ledger cannot be reactivated, so a rerun needs a fresh ledger and policy.
4. Label routed issues `router:jev` (and both sides `worker:codex`). Auto-excluded: `human-only`, `risk:high`, auth, security, database, deployment, migrations, secrets.
5. Run `node tools/dispatcher/bin/dispatcher.mjs jev-cohort status|preview|activate|stop|export|reconcile|fee` on the Mac (the CLI is not on PATH). Run the native containment fixtures outside the worker sandbox before any paid traffic.
6. The older `jev` admission ledger (`jev-trial.json`, MOV-427) is separate, has an empty approved-hash allowlist, and cannot activate production traffic.

## Where the code lives

Dispatcher sources in `tools/dispatcher/src/`: `jev-cohort.mjs`, `jev-cohort-settle.mjs`, `jev-trial.mjs`, `jev-patch.mjs`, `openrouter-broker.mjs`, `openrouter-transport.mjs`, `openrouter-response.mjs`, `openrouter-proof.mjs`, `routed-request.mjs`, `routing-evidence.mjs`, `codex-containment.mjs`. Tests: `tools/dispatcher/test/jev-*.test.mjs`, `openrouter-*.test.mjs`, `codex-containment.integration.test.mjs`.

## Harness fixes made during the trial (merged)

#902 (MOV-479, `apply_patch` shim for routed models), #907, #909, #914, #917, #918 (`jev-cohort reconcile`), #921 (continuation effort), #922 (broker copy list), #925 (MOV-487, settle on worker exit plus exit evidence), #926 (effort mismatch flagged on all turns, MOV-486), #929 (MOV-488, `reconcileStartup` SIGKILLed live workers of the current dispatcher; fixed with a per-instance UUID, kills logged to `dispatcher-kills.jsonl`). Also MOV-482 (provider 4xx fail only that attempt) and MOV-484 (orphaned request settlement), described in the runbook.

## Failure modes seen

- Provider HTTP 400s on Jev routes (7 across MOV-471 and MOV-472).
- Routed models calling `apply_patch`, which Codex rejected as unsupported (fixed by #902).
- Served-effort vs candidate-effort mismatches, first a hard stop, then flagged (#926).
- Workers SIGKILLed about 40 seconds after a sibling exited (per-poll cleanup, #929), leaving orphaned paid requests that blocked the cohort until reconciled.
- Cohort admission needed several archive/rebase/re-activate cycles.
- lane-review and sensitive-path gates on dispatcher PRs needed acks; re-running `supabase-verify` can hit `startup_failure` (close and reopen the PR).

## Issues and PRs

- Trial control issues: MOV-431 (run cohort), MOV-433 (decision), MOV-422 (design), MOV-424 to MOV-427, MOV-429, MOV-437 to MOV-442.
- Cohort 1: MOV-443 #867, MOV-444 #860, MOV-445 #851, MOV-446 #848.
- Cohort 2: MOV-459 #885, MOV-460 #889, MOV-461 #881, MOV-462 #880, MOV-464 #879, MOV-465 #878, MOV-466 #886, MOV-467 #884.
- Cohort 3: MOV-470 #931, MOV-471 #930, MOV-472 #927, MOV-473 #912, MOV-474 #911, MOV-475 #919, MOV-476 #910, MOV-477 #899.

## Local state on Adam's Mac (not in the repo, do not delete)

- Cohort ledgers, archives and per-run `openrouter-attribution.jsonl` files under `~/.config/moviecal/` and the dispatcher run-log directories.
- Backup branches from cohort 3 leftovers: `backup/MOV-47x-*` (cohort 3 issues) and the MOV-444 backup. Kept intentionally; prune only on Adam's say-so.

## Related research in this folder

- [mov-421-model-tier-research.md](./mov-421-model-tier-research.md): why the trial was proposed (model tier assignment).
- [model-tier-routing-review.md](./model-tier-routing-review.md): fact-check of model tiers and measured run costs from before the trial.
