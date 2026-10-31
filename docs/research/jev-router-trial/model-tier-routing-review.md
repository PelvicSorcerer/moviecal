# Model tier routing: fact-check and recommendation

Written 2026-09-25 for Adam. Covers the other agent's proposed remapping of the dispatcher's `model:cheap` / `model:default` / `model:strong` labels, checked against published pricing, benchmark reporting, this repo, Linear, and the one measured worker run we have (MOV-360).

**Measured vs inferred.** Numbers labelled *measured* come from a real run record or a primary source I fetched. Numbers labelled *inferred* are my arithmetic on top of those. openai.com, artificialanalysis.ai and most third-party GPT-6 write-ups are blocked from this environment, so the OpenAI-side figures come from search-result summaries of those pages, not from reading them directly.

---

## 1. Bottom line

1. **Change `model:strong` from Claude Opus 5 to Claude Opus 5.5.** It costs less than Opus 5 per token (input and output 20% lower, cache reads 60% lower) and scores higher on every coding benchmark Anthropic published. This change is a one-line env/config edit.
2. **Keep `model:default` on Claude Sonnet 5 for now, and trial Opus 5.5 on some default issues.** Both models charge the same $0.20/MTok for cache reads, and cache reads were about 77% of MOV-360's cost. So an Opus 5.5 run that takes fewer turns could cost the same as or less than a Sonnet run. Measure this before switching.
3. **Don't move `model:default` to GPT-6 Luna.** The evidence for "Luna beats the old Sol" is narrow: it comes from a computer-use benchmark, compared against old Sol at *medium* effort. Our workers hold very large contexts, and that is the case where GPT-6 pricing gets worse.
4. **On the Codex side, pin model IDs explicitly:** cheap = Luna, default = Sol at medium effort, strong = Sol at high/xhigh. Today the tier only changes reasoning effort, and the model comes from whatever `~/.codex/config.toml` says.
5. **The biggest cost lever isn't the model; it's turn count × context size.** *Corrected 2026-09-25 after tracing transcripts:* the expensive runs were not verify loops. MOV-330, MOV-360 and MOV-305 each ran `npm run verify` only twice. The `Read` tool re-reading source files made up 68–87% of tool-result volume, and grep/find exploration another 5–19%. Cutting exploration and re-reading will save more than any model swap.
6. **Set reasoning effort explicitly for each tier. The Mac's tooling supports it; the dispatcher just doesn't use it for Claude yet** (see §3a). Codex workers already get a per-tier effort. Claude workers get only a model swap and run at the CLI's implicit default effort.

---

## 2. Fact-check of the pasted analysis

### Pricing table

| Claim | Verdict | What the source says |
|---|---|---|
| GPT-6 Luna $0.10 / $0.50, cache read $0.01, write $0.125 | ✅ Correct | Launch coverage gives $0.10/$0.50 with a 90% discount on cached input. Cache writes are 1.25× input, which is $0.125 |
| Claude Sonnet 5 $2 / $10, cache read $0.20 | ✅ Correct | Anthropic pricing page. The $2/$10 rate is now the standard price, and the planned rise to $3/$15 was cancelled |
| Claude Sonnet 5 **cache write $1.25** | ❌ Wrong | $2.50/MTok for the 5-minute cache and $4 for the 1-hour cache (Anthropic pricing page) |
| GPT-6 Sol $2 / $10, cache read $0.20, write $2.50 | ✅ Correct (secondhand) | $2/$10, cached input at 10%, cache writes at 1.25×. Read from search summaries of OpenAI's model page |
| Claude Opus 5.5 $4 / $20, cache read $0.20, write $5 | ✅ Correct | Anthropic pricing page. Cache reads on Opus 5.5 are 0.05× input, not the usual 0.1× |
| Sol "~114 t/s" | ⚠️ Only at medium effort | Artificial Analysis lists 114 t/s at medium, 99.6 at high and 93.5 at max |

### Question 1 (Opus 5.5 vs Opus 5)

| Claim | Verdict |
|---|---|
| Opus 5.5 list price is 20% below Opus 5 ($5/$25) | ✅ Correct |
| Cache reads drop 60% ($0.50 → $0.20) | ✅ Correct |
| "Real-world metrics show… roughly 40% fewer tool calls and half the output tokens" | ⚠️ Misattributed. On anthropic.com/claude-opus-5-5 this is **one customer quote** (Kiro) about command-line tasks, not a general measurement. Anthropic's own general claim is about 40% lower cost than Opus 5 on typical workloads and over 30% faster output. Another customer (Box) reported a third of the tokens. These are vendor-selected testimonials |
| "Self-verification cuts total agent loops by 40%" (table) | ❌ No source says this. It merges the Kiro quote with a separate customer comment about self-verification |
| Conclusion: Opus 5.5 is cheaper than Opus 5 | ✅ Holds on price alone, even without the efficiency claims |

Published benchmarks, Opus 5.5 vs Opus 5 (Anthropic): Terminal-Bench 4.0 66.4% vs 52.3%, FrontierCode v1.1 54.4% vs 48.0%, CursorBench 4.0 57.8% vs 46.6%. The page has no Sonnet 5 comparison.

### Question 2 (Codex tiers)

| Claim | Verdict |
|---|---|
| Sol supports effort from none to max | ✅ Correct: none / low / medium (the default) / high / xhigh / max |
| "Luna at max effort clears complex OSWorld and coding benchmarks at a standard higher than legacy GPT-5.6 Sol" | ⚠️ Overstated. On OSWorld 2.0, Luna at max beat GPT-5.6 Sol at **medium** (52.7% vs 49.7%) at about 1/10 the cost per task. On DeepSWE v1.1, Luna at max scored 66.6%, slightly above **GPT-6** Sol at high. It did not beat GPT-5.6 Sol at max. Even GPT-6 Sol at max (68.8%) scores below GPT-5.6 Sol at max (72.7%) on DeepSWE; it is better value, not a better model |
| Luna is "the ideal choice for default tasks" | ❌ Not supported for our workload (see §4) |
| Split Sol by effort across tiers rather than one blanket choice | ✅ Reasonable, and it matches how `codexReasoningEffortForTier` already works |

### Question 3 (Sonnet 5 vs Sol, and the 272K tier)

| Claim | Verdict |
|---|---|
| Sol has a long-context price tier above 272K input tokens | ✅ Real |
| "Input token costs double, and cache writes match standard frontier pricing" | ⚠️ Incomplete. Above 272K, input **and cache** rates double and **output is 1.5×**, and the surcharge applies to the **whole request**, not only the tokens past 272K. The pasted text leaves out the output surcharge |
| Sonnet 5 stays flat-rate up to 1M | ✅ Correct. Anthropic bills the full 1M window at standard rates on Claude 4.6 and later |
| Sonnet 5 "retains a notable edge in structured visual design and complex code synthesis" | ❓ Unverified. The cited source is a Cursor forum thread, which is anecdote. The only aggregate I found gives mixed results with overlapping intervals (Luna slightly ahead on a coding lane, Sonnet 5 ahead on an agentic lane) |
| Sonnet 5 is "prone to high reasoning token overhead" | ⚠️ Consistent with our one data point: 139K of MOV-360's 217K output tokens were thinking (64%). One run is an anecdote, not a trend |

### Citation hygiene
- Citations [2] and [3] are the same URL, and they are used for different claims.
- Several claims cite pages that don't contain them. The clearest case is the "40% fewer loops" line.
- The proposal suggests routing by input context size. The dispatcher can't know that before a run, because a worker's context grows as it works. Switching models mid-run also throws away the prompt cache.

---

## 3. What our own data says

### How the tiers are wired today
From `tools/dispatcher/src/worker-routing.mjs`:

| Tier | Claude (`--model`) | Codex (`model_reasoning_effort`, `--model`) |
|---|---|---|
| cheap | `claude-haiku-4-5` | low, model from config.toml |
| default | `claude-sonnet-5` | medium, model from config.toml |
| strong | `claude-opus-5` | high, model from config.toml |

Each tier can be overridden with `MOVIECAL_MODEL_{CHEAP,DEFAULT,STRONG}` and `MOVIECAL_CODEX_{MODEL,EFFORT}_*`. No effort level is passed to Claude. Workers authenticate with `CLAUDE_CODE_OAUTH_TOKEN`, so **Claude workers draw on Adam's subscription limits, not API dollars**. MOV-176, the move to a Console API key, is in Icebox. The dollar figures in this report are Claude Code's API-equivalent estimates, and I'm using them as a proxy for how much limit each run consumes (*inferred*; Anthropic doesn't publish how subscription limits weight each model).

### 3a. Can we set effort? (checked on the Mac, 2026-09-25)
| Worker | Installed version | Effort control | Wired in the dispatcher? |
|---|---|---|---|
| Claude Code | 2.1.281 | `--effort low\|medium\|high\|xhigh\|max` (confirmed in `claude --help`) | **No.** `workerInvocation()` passes `--model` only, so every tier runs at the CLI's implicit default effort. We don't know what that default is for each model (Opus 5.5's API default is `medium`), which is a reason to set it explicitly |
| Codex CLI | 0.153.4 | `-c model_reasoning_effort=<value>`. The key is accepted under `--strict-config` | **Yes.** cheap/default/strong map to low/medium/high |

Caveats:
- **Haiku 4.5 does not support effort.** The API rejects the effort parameter on Haiku 4.5. The cheap tier must either omit `--effort` or move to a model that supports it. Do a smoke run before relying on how the CLI handles this.
- For Codex, the key is confirmed but the values aren't. Nobody has yet checked that 0.153.4 accepts `xhigh`/`max` or the `gpt-6-sol`/`gpt-6-luna` model ids. Try one short `codex exec` with each before pinning them.
- Effort changes both quality and cost for each model, so any Luna-vs-Claude cost comparison should wait until the Claude side is actually effort-tuned.

### How the labels are actually used (Linear, measured)

| Label | Issues | Notes |
|---|---|---|
| `model:strong` | 51 | About 15 are `human-only` decision or docs work. The rest are mostly dispatcher, process, security and database work. 8 were pinned to `worker:codex` |
| `model:default` | about 110 | About 30 are test fixtures or throwaways. Includes all the iOS and web feature work, plus several `risk:high` and `upgrade:*` issues |
| `model:cheap` | 8 | 7 are fixtures or cancelled. MOV-276 (a docs fix) is the only real cheap run |

So the cheap tier is barely used, and strong accounts for roughly 40% of real dispatchable work. How the strong tier is priced matters more than how the cheap tier is.

### The one measured run: MOV-360 (Sonnet 5, `model:default`)
Measured, from the "Check MOV-360 worker usage" thread: 200 turns, about 35 minutes, $18.50, 217,508 output tokens (139,102 of them thinking), about 71.4M cache-read tokens, and over 70% of the 5-hour limit. The earlier figure of "13 full verify runs" counted text mentions, not invocations. Tracing the transcript found **2 actual `npm run verify` runs**.

Cost breakdown at Sonnet 5 rates (*inferred*):
- Cache reads: 71.4M × $0.20 = **$14.28 (about 77%)**
- Output: 0.2175M × $10 = $2.18 (about 12%)
- The remaining $2.04 is cache writes and uncached input, roughly 0.8M tokens of cache writes

The same trajectory (same turns and tokens) repriced on other models (*inferred*):

| Model | Estimated cost | vs Sonnet 5 |
|---|---|---|
| Claude Sonnet 5 (actual) | $18.50 | — |
| Claude Opus 5.5 | about $22.70 | +23% |
| Claude Opus 5 (the current strong tier) | about $46 | +150% |
| GPT-6 Sol | above $18.50 | The run averaged about **357K context tokens per turn** (71.4M ÷ 200). Most later turns would cross the 272K tier and pay 2× on cache reads |
| Claude Haiku 4.5 | not viable | Its 200K context window is smaller than this run's average context |

What this means:
- Because cache-read prices are equal, Opus 5.5 would only need to finish in about 15–20% fewer turns to match Sonnet 5's cost on a run like this. Anthropic's customer quotes claim much more than that, but I haven't verified that on our workload.
- The "cheap per token" models don't come out cheaper for our long-context agent runs. Per-turn context size drives the bill, and GPT-6 charges extra above 272K.
- Cost roughly scales with turns × context size. MOV-360's turns went mostly to reading and re-reading files, not to verify runs (see the next section).

### Every logged run (measured, pulled from the Mac's dispatcher logs, 2026-09-25)
There are 107 run folders under `~/Library/Logs/moviecal-dispatcher/`. **71 Claude runs** have full usage and cost data. The rest are Claude runs from before stream-json logging, Codex runs without `--json`, or truncated logs. The per-run table is at `~/code/moviecal-run-usage.csv` on the Mac.

| Tier (model) | Runs with cost data | Median cost | Median turns | Median output tokens | Total cost |
|---|---|---|---|---|---|
| cheap (Haiku 4.5) | 4 | $0.11 | 14 | 3.1K | about $0.5 |
| default (Sonnet 5) | 55 | $0.42 | 18 | 6.1K | $124 |
| strong (Opus 5) | 12 | **$10.59** | **96** | **72K** | **$116** |

Totals: $241, 2.52M output tokens, 487M cache-read tokens, and 233 `npm run verify` calls (about 3.3 per run). Most expensive runs: MOV-330 (Opus, $23.29, 171 turns), MOV-360 (Sonnet, $18.50, 200 turns), MOV-305 (Opus, $17.85), MOV-303 (Opus, $12.62) and MOV-205 (Opus, $12.59). Outcome labels in the CSV came from matching patterns in the transcripts and are unreliable. No usable Codex cost data exists.

Two more findings from the same logs:
- **Workers write almost entirely to the 1-hour cache.** Cache writes therefore bill at 2× input, which is $4/MTok on Sonnet 5 and $8 on Opus 5.5, not the 5-minute rates. The Sonnet-to-Opus 5.5 ratio stays 2×, so the repricing estimates above hold.
- **Codex runs can't be costed.** Older runs didn't use `--json`; the current `workerInvocation` does pass it. The one recent Codex run with a transcript (MOV-298) hit the nested-sandbox failure class (MOV-180/299). Codex isn't ready to take over a whole tier until it has cost visibility and a clean reliability record.

The median default run reads about 638K cache tokens *in total over the run*. That works out to roughly 35K per turn, well under Sol's 272K tier. Sol's surcharge would hit the long outlier runs, like MOV-360 at about 357K per turn, not the typical run.

What this changes (*inferred*):
- **The strong tier is where the money goes.** 12 Opus 5 runs cost almost as much as 55 Sonnet runs. If those runs follow MOV-360's pattern, where most of the cost is cache reads, repricing them at Opus 5.5 rates cuts each run's cost by roughly half: a median of about $10.6 becomes about $5.5, and the 12-run total drops by around $55. That makes item 2 in the plan below the highest-value model change by a wide margin.
- **A typical default run is already cheap** ($0.42 median over 18 turns). MOV-360 was an outlier on the default tier. Moving default to Opus 5.5 would likely raise the cost of typical runs while mainly helping the rare long ones, so the default-tier trial drops in priority. It's only worth trying on issues that look large.
- The expensive runs, on both tiers, share one pattern: 100 to 200 turns spent mostly reading files.

### Where the expensive runs' tokens went (measured, transcript trace of the top 3)
| Run | Model | Cost | Turns | Cache reads | Actual `npm run verify` runs |
|---|---|---|---|---|---|
| MOV-330 | Opus 5 | $23.29 | 171 | 33.5M | 2 |
| MOV-360 | Sonnet 5 | $18.50 | 200 | 71.5M | 2 |
| MOV-305 | Opus 5 | $17.85 | 130 | n/a | 2 |

- Verify output was 0.9–5.2% of the tool-result content fed back into context.
- `Read` accounted for 68–87% of tool-result volume, and grep/find for 5–19%.
- Cache reads were about 70–77% of each run's cost, and output tokens (thinking included) about 12–16%.

So the cost comes from exploration: every file read stays in context and gets re-billed as a cache read on every later turn. The planned verify-loop fix (targeted tests while iterating) is still sensible hygiene, but it would not have made these runs much cheaper.

---

## 4. Recommendation

| Tier | Claude worker (default) | Codex worker (`worker:codex`) | Status |
|---|---|---|---|
| cheap | Claude Haiku 4.5, unchanged, no `--effort` (unsupported) | `gpt-6-luna`, effort low | Optional |
| default | **Claude Sonnet 5, unchanged for now**, `--effort medium` | `gpt-6-sol`, effort medium | Pin the Codex model |
| strong | **Claude Opus 5.5** (was Opus 5), `--effort high` | `gpt-6-sol`, effort high (xhigh only for `upgrade:prior-failure`) | **Do now** |

The rest of the plan, in order:
1. **Cut exploration cost first (revised).** Give workers orientation in the brief: the files and modules most likely involved (taken from the issue and `repository-context`), and guidance to grep before reading and to read line ranges instead of whole files. For broad searches, consider a subagent, so its reads stay out of the main context. Add a per-run turn or time budget as a backstop. The earlier verify-loop fix (targeted tests while iterating) is still worth doing, but it is secondary.
2. **Change strong to Opus 5.5.** Set `MOVIECAL_MODEL_STRONG=claude-opus-5-5` on the Mac, or change the default in `modelIdForTier`. Update `docs/operators/worker-routing.md` in the same PR.
3. **Pass `--effort` to Claude workers.** The installed CLI (2.1.281) supports it. Add a `claudeEffortForTier()` table that mirrors `codexReasoningEffortForTier()`, overridable with `MOVIECAL_CLAUDE_EFFORT_*`. Suggested starting values: default (Sonnet 5) = `medium`, strong (Opus 5.5) = `high`, and no flag on cheap (Haiku 4.5 doesn't support effort). Record the effort used on each run next to the model, so later runs can be compared. Lower effort should mean fewer and more consolidated tool calls, which is the turns × context cost driver, but measure it rather than assume it.
4. **Pin the Codex model IDs** with `MOVIECAL_CODEX_MODEL_*`, so the tier decides the model and not just the effort.
5. **Optionally, trial Opus 5.5 on large default issues only.** The median default run costs $0.42, so leave typical ones on Sonnet 5. Label 3–5 comparable default issues to use Opus 5.5 at medium effort and compare turns, cost and limit usage against Sonnet 5 runs. Keep whichever finishes issues for less. Judge on cost per finished issue, not price per token.
6. **Log usage for every run.** Have the dispatcher record the final `result` usage (turns, tokens, cost, model, verify count) in its state store or in the completion comment on Linear, so the next decision like this is based on data instead of one anecdote.

What I'd **not** do:
- Route by expected context size. The dispatcher can't know it up front.
- Split one issue across models mid-run, which forfeits the prompt cache.
- Put Luna on default before a measured trial on our own issues.

---

## Sources
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Claude Opus 5.5 announcement: https://www.anthropic.com/claude-opus-5-5
- GPT-6 Sol/Luna prices and launch: https://mixed-news.com/en/openai-halves-gpt-6-api-prices-sol-luna-opus-5-cost/ , https://venturebeat.com/technology/openai-releases-gpt-6-sol-and-luna-models-slashing-api-costs-50-or-more , https://www.marktechpost.com/2026/09/22/openai-releases-gpt-6-sol-and-luna-50-cheaper-api-pricing-and-benchmarks/
- Sol 272K tier, effort levels and cache writes: https://developers.openai.com/api/docs/models/gpt-6-sol , https://techjacksolutions.com/ai-tools/chatgpt/gpt-6-sol-and-luna-pricing-and-api/ , https://github.com/pydantic/genai-prices/issues/711
- Sol output speed: https://artificialanalysis.ai/models/gpt-6-sol-medium
- Luna vs GPT-5.6 Sol (OSWorld, DeepSWE): https://www.vellum.ai/blog/gpt-6-sol-and-luna-benchmarks-explained , https://www.datacamp.com/blog/gpt-6-sol-and-luna
- Sonnet 5 vs GPT-5.6 aggregate: https://benchlm.ai/compare/claude-sonnet-5-vs-gpt-5-6-luna
- Repo: `tools/dispatcher/src/worker-routing.mjs`, `docs/operators/worker-routing.md`. Linear label queries for `model:*`. MOV-360 usage from the "Check MOV-360 worker usage" project thread.
