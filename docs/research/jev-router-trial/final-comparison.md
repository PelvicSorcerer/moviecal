# MOV-431 Jev vs fixed control: final comparison (cohorts 1 to 3)

Prepared 2026-10-30 from the cohort ledgers (all archives, de-duplicated by request id), the per-run `openrouter-attribution.jsonl` files and live OpenRouter key usage. Cohort 3 was stopped cleanly at 23:25:50Z with 0 pending requests.

## Headline numbers

| | Jev (routed) | Fixed control (GPT-6.1 Sol, medium) |
|---|---|---|
| Issues | 10 | 10 |
| Billed requests (completed) | 338 | 259 |
| Spend on those issues (includes failed and aborted attempts) | **$11.68** | **$3.32** |
| Average cost per request | $0.0346 | $0.0128 |
| Merged PRs | 10 of 10 | 10 of 10 |

- **Total trial spend:** Live key usage is $15.533 against a starting $0.543, so $14.99 was spent on the key. The per-issue figures above add to $15.00, so the two agree. Add $4.40 of purchase fees and the all-in total is about $19.9 against the $75 ceiling. Credits were never topped up.
- **Reading it:** Both arms delivered every issue. Jev cost about 3.5 times as much in total and about 2.7 times as much per request. The control arm's cost was steady at roughly $0.010 to $0.017 per request. Jev's was between $0.011 and $0.065, depending on which model it chose.

## Per pair (routed Jev vs control)

| Cohort | Jev issue | Jev cost | Jev requests | Control issue | Control cost | Control requests | Cost ratio |
|---|---|---|---|---|---|---|---|
| 1 | MOV-443 | $0.319 | 23 | MOV-444 | $0.438 | 30 | 0.7x |
| 1 | MOV-445 | $0.192 | 13 | MOV-446 | $0.159 | 10 | 1.2x |
| 2 | MOV-460 | $0.536 | 27 | MOV-459 | $0.152 | 15 | 3.5x |
| 2 | MOV-462 | $0.143 | 13 | MOV-461 | $0.151 | 13 | 0.9x |
| 2 | MOV-464 | $0.181 | 13 | MOV-465 | $0.197 | 17 | 0.9x |
| 2 | MOV-466 | $0.832 | 24 | MOV-467 | $0.209 | 19 | 4.0x |
| 3 | MOV-471 | $4.479 | 69 | MOV-470 | $0.611 | 36 | 7.3x |
| 3 | MOV-472 | $2.565 | 96 | MOV-473 | $0.252 | 21 | 10.2x |
| 3 | MOV-474 | $1.109 | 20 | MOV-475 | $0.845 | 73 | 1.3x |
| 3 | MOV-476 | $1.326 | 40 | MOV-477 | $0.312 | 25 | 4.3x |

PRs (all merged): MOV-443 #867, 444 #860, 445 #851, 446 #848, 459 #885, 460 #889, 461 #881, 462 #880, 464 #879, 465 #878, 466 #886, 467 #884, 470 #931, 471 #930, 472 #927, 473 #912, 474 #911, 475 #919, 476 #910, 477 #899.

- **Jev cheaper or equal (3 of 10):** MOV-443 (0.7x), MOV-462 (0.9x) and MOV-464 (0.9x), where Jev mostly picked GPT-6.1 Sol.
- **Near parity (2 of 10):** MOV-445 (1.2x) and MOV-474 (1.3x, though the control there made 73 requests across retries).
- **Well above control (5 of 10):** MOV-460 (3.5x), MOV-466 (4.0x), MOV-471 (7.3x), MOV-472 (10.2x) and MOV-476 (4.3x). The big gaps came when Jev routed to other models or higher effort. The cohort 3 gaps are inflated by re-runs, so treat them with care (see below).

## What Jev actually chose

- **Models:** Most requests still went to `gpt-6.1-sol`, but Jev also used `gpt-6-astra`, `gpt-6.1-terra` and `claude-opus-5.5`. The most expensive per-request runs were the mixed-model ones: MOV-471 ($0.065 per request, a mix of astra, Opus and sol), MOV-474 ($0.056, astra at low effort) and MOV-466 ($0.035, astra plus terra).
- **Effort:** The control is fixed at medium. Jev ran at **high** on MOV-443, MOV-464, MOV-466 (terra), MOV-476 and parts of MOV-460 and MOV-472, and at **low** on MOV-474 and parts of MOV-471 and MOV-466. So Jev did diverge from the control's effort, not only its model.

## Failures and noise (mostly the harness, not the arms)

- **Failed or aborted requests:** 15 settled failure rows, all in cohort 3: 5 on MOV-471, 4 on MOV-470, 6 on MOV-472. Reasons were provider HTTP 400s (MOV-471 x3, MOV-472 x4), orphaned requests reconciled after a worker died (MOV-470 x2, MOV-471 x2), settle-on-worker-exit (MOV-470 x2), and `conflicting-served-effort` stops (MOV-472 x2).
- **Effort-mismatch flags:** Jev's candidate effort differed from the response effort on **10 attribution rows**: 2 on MOV-460 and 8 on MOV-472. There were also 4 `conflicting-served-effort` stops over the trial (MOV-460 twice, MOV-472 twice) before the guard was changed to flag mismatches instead of stopping.
- **Control reliability:** The control arm had zero provider 400s and zero effort mismatches. Its worker deaths were the SIGKILL incidents (MOV-470).
- **Worker deaths:** Five workers were killed about 40 seconds after a sibling's exit (diagnosed to the per-poll worktree cleanup and fixed in #929). These hit both arms, cost money, and inflate request counts and costs for MOV-470, 471 and 472 and for MOV-475's 73 requests.
- **Codex parse errors:** I saw one Codex-native tool-call parse error (a string "false" for a boolean, MOV-472). Other parse errors in transcripts may be double-counted across retries and attempts, so I did not include a count.

## Caveats

- **Costs are not clean per-issue costs.** They include aborted and re-run attempts, the cost of any request that was settled without an invoice (counted at reconciled usage), and no human rework time. Retries are why MOV-475's control shows 73 requests, and why MOV-471 and MOV-472 look so expensive.
- **Cohort 3 is distorted by harness faults** (SIGKILLs, provider 400s, scanner blocks). A fairer cost comparison is cohorts 1 and 2 only: Jev **$2.20** over 6 issues vs control **$1.31** over 6 issues, about 1.7x. Cohort 3 alone is Jev $9.48 vs control $2.02 over 4 pairs, about 4.7x.
- **Small sample and no quality score.** Every PR merged on both sides, but I did not measure first-attempt success, wall time or human rework, so this is a cost and reliability read, not a quality verdict.
- **Subscription comparison:** None of the trial runs used the ChatGPT subscription; all billed the dedicated OpenRouter key.

## My read for the MOV-433 decision

On this evidence Jev did not lower cost. It matched the control only when it picked the same model (GPT-6.1 Sol at medium) and otherwise cost 3 to 10 times more per issue, mostly by choosing pricier models or higher effort. It also produced far more infrastructure incidents, though many were harness bugs now fixed. Delivery was equal: 10 of 10 merged each side. To claim a saving, Jev would need to pick cheaper models without lowering quality, which the router did not show here. The decision is Adam's.
