# MOV-421 research: re-evaluating model tier assignment

Written 2026-09-30. Read-only research: MOV-421 was not changed and no issue was created. Builds on `reports/model-tier-routing-review.md` (2026-09-25), which covered prices and per-run cost; this report covers how tiers get *assigned*.

## 1. There is no calculation today, only labels

- `resolveRouting()` in `tools/dispatcher/src/worker-routing.mjs:143` reads the `model:*` label and falls back to `default` when there isn't one. It never looks at the issue text. The only rule it enforces is that `model:strong` must also carry one of five `upgrade:*` labels (`:154`). The intake validator reuses that same check (`tools/dispatcher/src/issue-spec.mjs:180-188`).
- So the tier is whatever the author of the issue (usually a Claude session drafting the spec) picks from the table in `docs/operators/worker-routing.md` §Default routing and §Upgrade conditions.
- Current tier → model (`worker-routing.mjs:360-396`): cheap = Haiku 4.5 (no effort), default = **Sonnet 5** at medium effort, strong = Opus 5.5 at high effort. On Codex: Luna/low, Sol/medium, Sol/high.
- Note: the default tier is still on **Sonnet 5**, not Sonnet 5.5 (`worker-routing.mjs:363`).

**A doc/code mismatch.** `worker-routing.md` §Upgrade conditions says going straight to strong "requires citing `prior-failure` or `architecture`". The code accepts any of the five conditions, and in practice most strong issues cite `security-critical` or `multi-system`. The doc rule has never been enforced.

## 2. How `model:strong` is actually used (Linear, measured)

71 issues carry `model:strong`. Every one is `risk:high` or `risk:medium`; almost all are `area:process` (dispatcher, sandbox, CI). Of the 13 created since 2026-09-26, all are `risk:high` and 11 cite `upgrade:security-critical`.

| upgrade label cited | count |
|---|---|
| security-critical | 26 |
| multi-system | 17 |
| architecture | 10 |
| prior-failure | 5 |
| ambiguous-spec | 1 |
| none (mostly from before the rule existed) | 12 |

18 of the 71 are `human-only`, so the label didn't pick a worker model at all.

**What this means (inferred):** in practice the rule works out to "if it touches the dispatcher's safety surface, use strong". That measures *risk*, not *difficulty*. Several recent strong issues are narrow and fully specified: MOV-398 (stop the audit reading heredoc bodies as commands), MOV-399/400 (gate on the diff instead of command text), MOV-417 (worktree retention). For a well-specified narrow change, a medium model is likely enough, and the risk is already covered by other gates: the diff audit, `npm run verify`, Human testing: required, and review before merge. A bigger model doesn't replace any of those.

## 3. Cost context (from the 2026-09-25 review, measured then)

- Strong-tier Opus 5 runs had a median of **$10.59 and 96 turns**, against **$0.42 and 18 turns** for default (Sonnet 5). 12 strong runs cost about as much as 55 default runs.
- Strong has since moved to Opus 5.5, which costs less per token. No usage data since that switch has been reviewed. MOV-363 records per-run usage (`dispatcher usage export`), but it lives on the Mac and this cloud thread can't read it.
- The turn gap is mostly **task size**, not the model: strong issues are the big ones. So re-tiering has to be judged on cost per *finished* issue for comparable issues, not on median cost per tier.

## 4. Options

### A. Tighten the rubric (smallest change)
- Separate risk from difficulty. `security-critical` alone stops qualifying for strong. Strong requires `architecture`, `ambiguous-spec` or `prior-failure` (this is what the doc already says), or `multi-system` together with a stated scope. Make the code enforce the doc so the two match.
- Security-sensitive but well-specified work goes to default at `high` effort. The effort override already exists (`MOVIECAL_CLAUDE_EFFORT_*`), but it applies per tier, not per issue. A per-issue `effort:*` label would be a small new feature.
- Move default to Sonnet 5.5 (a one-line change at `worker-routing.mjs:363`, or `MOVIECAL_MODEL_DEFAULT` on the Mac). Check its price and effort support first.

### B. Change the structure
- Replace the three tiers with two axes: model (medium / frontier) and effort (low→max), with effort doing most of the work. With effort-capable models on both Claude and Codex, effort is now the finer control. Haiku 4.5 is the only model without it, and the cheap tier is barely used anyway (8 issues, 7 of them fixtures).
- Or use escalation instead of pre-assignment: always start at default, and move up to strong only on `prior-failure`. The dispatcher already has continuation and retry paths that could carry this. The cost is one wasted run whenever the first attempt fails.

### C. Trial the OpenRouter Jev Router
What it is (sources below; openrouter.ai itself is blocked from this environment, so this comes from search summaries and press coverage): released 2026-09-25 by TypeSafe on OpenRouter. Before each turn a small decision model scores the prompt and picks the model and reasoning effort for that turn. It tries to avoid switches that would lose the prompt cache. The router itself is free; the Jev model costs about $0.042 per million input tokens. OpenRouter reports it solved 237 of 423 agent-benchmark tasks, against 130 for OpenRouter's own Auto Router. That is the vendor's own benchmark.

Why it doesn't fit our workers as they are:
1. **Billing.** Claude workers run on your subscription (`CLAUDE_CODE_OAUTH_TOKEN`), and Codex on your ChatGPT plan. Sending turns through OpenRouter means paying per token through the API for every turn. The move to an API key (MOV-176) is still in Icebox.
2. **Data (corrected 2026-09-30).** This is not a blocker: Anthropic and OpenAI already receive repo contents. What it does need is a governance change. OpenRouter becomes a new provider destination, and the requests may then go on to other upstream providers. So the security docs, and any provider egress allowance in the worker guards, need updating, and OpenRouter's provider allowlist and data-retention settings should be pinned for the trial.
3. **Switching mid-run (clarified 2026-09-30).** Jev Router picks a model for each request, and an agent run is 18–200 requests, each resending the whole conversation. The prompt cache belongs to one model, so a switch partway through makes the new model pay full input price for the entire context. On a 350K-token context at Sonnet-class prices that is roughly $0.70 for the switching turn, against about $0.07 for a cached turn. Switching isn't forced: Jev is designed to be cache-aware and can keep one model for a whole run. How often it actually switches on our runs is the thing a trial has to measure.
4. **Plumbing.** Claude Code and Codex would each need to talk to an OpenRouter endpoint, with no guarantee that tools and effort flags behave the same. That also has to be proved under the Seatbelt guards.

A narrower trial that avoids all four problems: **use Jev only as a classifier before dispatch.** Send it the issue title, acceptance criteria and labels (no repo code) once, and have it suggest a tier and effort. Record that suggestion next to the human-chosen label in `routing-decisions.jsonl` without acting on it. After a couple of weeks, compare its picks with the actual outcomes from MOV-363 usage records. It costs fractions of a cent per issue, the worker path stays untouched, and it tells us whether Jev's judgment beats the rubric before anything depends on it.

## 5. Suggested order (for when you want issues filed)
1. Pull the MOV-363 usage export on the Mac for runs since 2026-09-26 (Opus 5.5 strong, Sonnet 5 default), so any re-tiering is based on current numbers.
2. Rubric fix (option A): enforce the doc's strong-tier rule in code, stop `security-critical` alone from qualifying, and move default to Sonnet 5.5. Then re-label the open strong issues (MOV-418, MOV-415, MOV-332, MOV-331).
3. Shadow-mode Jev classifier (option C, narrow version), with a governance note about sending issue text to a third party.
4. Decide on the structural change (option B) after that data is in.

## Sources
- Code: `tools/dispatcher/src/worker-routing.mjs`, `tools/dispatcher/src/issue-spec.mjs`, `docs/operators/worker-routing.md`
- Linear: all issues labelled `model:strong` (queried 2026-09-30); MOV-412 comments
- [Jev Router on OpenRouter](https://openrouter.ai/typesafe/jev-router) · [OpenRouter announcement](https://x.com/OpenRouter/status/2103610898690855161) · [GIGAZINE coverage](https://gigazine.net/gsc_news/en/20260928-openrouter-jev-router/) · [KuCoin: the cache is the real routing problem](https://www.kucoin.com/news/insight/BTC/6ab81b9574fd460007c59169)
