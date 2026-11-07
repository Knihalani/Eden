# Cost and latency wave (CL): results

Status: 2026-11-07. Goal set by the owner: Eden's all-in cost per task below the agent alone, latency cut hard, on
short (one request per session) and long (many requests per user over days) horizons, without losing the hidden facts
Eden raises. Plan and hypotheses: [cost-latency-plan.md](cost-latency-plan.md). Every paid call went to the Anthropic API
with `HAIKU_API_KEY` (`claude-haiku-5-5`; Sonnet for concern regrades only) through the lab provider, on capped
ledgers: **Anthropic-direct lab figures**, not the OpenRouter route the servers ship.

## In plain words

- **The paid reader is gone from the request path.** Eden now hands the agent up to 5 candidate items it found, as short
  excerpts, and tells it to check that each is about the same person, thing and date before using it (D237). The
  agent, which reads the packet anyway, does the judging the reader used to do with a separate model call.
- **Blind result (heldout16, never run before, Pi, payload notices):**
  - **Long horizon (a user over days): Eden is now cheaper than the agent alone**, $0.352 vs $0.391 per 1,000 tasks
    (−0.049, interval −0.069..−0.029), and 0.9 s faster a task.
  - **Short horizon (one request): level** ($0.378 vs $0.357, +0.021, −0.000..+0.043) and **2.0 s faster** a task
    (2.91 vs 4.92 s mean).
  - **Hidden facts: 79.7% vs 10.9%** for the agent alone (short); 12 of 16 vs 4 of 16 (long). Against the reader-based
    setup it gives up about 5 points (−4.9, −11.1..+1.4), the price of the cost and latency cut; the pre-registered
    rule kept it.
  - **No rise in false concerns** after regrading.
- **Against RealUse-1** (heldout14, different suite): Eden was +$0.50/1k and +0.6 s on the mix; now level or cheaper and
  faster.
- **Hermes Agent** (heldout16, seeds 41–42): 71.9% vs 10.9% hidden facts, about 1 s faster on hidden tasks, but $0.077
  per 1,000 tasks above Hermes alone: Hermes's packets add input on every turn.
- **What is left on short horizons is mostly a lab artefact:** Pi's agent with Eden has a ~565-token fixed prompt that
  the cache never served, while the tools agent's longer prompt was cached (CL8, D260). Re-priced as if cached (a
  counterfactual), the short mix is $0.362 vs $0.370. Real agent prompts are far longer than the cache minimum.

## What was tried, kept and deleted

| Session | Lever | Outcome |
| --- | --- | --- |
| CL1 | Read at ingest (model-written applicability, no-model cascade) | Rejected (D233): −4.4% reader calls vs a 5x target; term-sharing items are in every pool |
| CL1 | Verdict reuse across turns | Not built (D234): exact inputs recur 1.08x |
| CL1 | Small local models as the reader | Not built (D235): AUC 0.44–0.61 vs Haiku 0.90 |
| CL2 | Reader stops after its binding entries (`readerStopEarly`) | **Kept (D240)**: output 172→91 tokens, −14% a call, −0.3 s; applies when the reader runs |
| CL2 | Smaller reader pool, shorter windows, compact fences, cached per-user prefix | Rejected (D238, D239, D241) |
| CL3 | Card only the last 7 days of person-written items (`cardsLeanDays` 7) | **Kept (D244)**: cold start $0.0208→$0.0088 a user |
| CL3 | Batch API for cards; 2 intent requests | Rejected (D242, D243): late cards cost recall; fewer requests cost recall |
| CL3 | Connector calls | No change (D245): with payload notices Eden makes ~0.6 calls a task; signals are the costly shape D210 advises against |
| CL4 | "Nothing found" note, ask from push, speculation, re-read ahead, closing line | All deleted (D246–D250, D257): the note made agents skip the ask that finds what the push missed |
| CL5 | Long-horizon harness (`--days`), cost split, neutral on train, blind heldout16, $0 cost screen | Lab (D251–D253) |
| CL6 | **The agent is the reader (`pushCandidates` 5)** | **Kept (D237)**: reader calls 0.9–1.0 → 0 a task; Eden's path ~1.1 s → 10 ms (payload) |
| CL7 | `pushChecked` on the new default | Deleted (D257): hidden −5.1 pts pooled |
| CL8 | Shorter excerpts, k=3, score floor, dedup | Rejected (D258, D259): each cost hidden facts or saved nothing; the cache finding (D260) |

The independent review of the merged wave found no defect in the default path; its two reader-path findings (a cut
Anthropic stream read as a stopped reply; a brace in a `why`) and three stale numbers were fixed with tests.

## Blind confirmation (heldout16)

Pi, Haiku in every role, payload notices, direct profile, time scale 1; $ per 1,000 tasks, steady state, 1:1:8 mix
(assumed). Detail: [realuse-3/pi-heldout16.md](realuse-3/pi-heldout16.md); Hermes:
`packages/sim/lab/realuse-3/hermes/hermes-heldout16-report.txt`.

| | tools | eden (candidates) | eden~reader |
| --- | --- | --- | --- |
| Short: hidden raised | 10.9% | 79.7% | 84.4% |
| Short: $/1k | 0.357 | 0.378 | 0.600 |
| Short: wall mean | 4.92 s | 2.91 s | 4.45 s |
| Short: Eden on the path | 0 | 10 ms | 1,145 ms |
| Long: hidden raised | 4/16 | 12/16 | 13/16 |
| Long: $/1k steady | 0.391 | 0.352 | 0.510 |
| Long: wall mean | 3.49 s | 2.56 s | 3.50 s |
| Regraded concerns (payload runs) | 0 | 0 | 1 |

With signal-only notices (seeds 41–42): eden $0.344 vs tools $0.363 (cross-run), 4.60 vs 5.04 s.

## Departures and what to know before shipping

- **D237 departs from D3, D6 and D11/D19**: Eden now sends a packet on most acting requests (the agent filters), with
  no score threshold, and puts one fixed Eden instruction line inside the data envelope (source text cannot forge
  it: `safeLine`). The no-model eval with a reader wired falls in precision (0.828 → 0.591) by design; the plain
  `bun run eval` is unchanged.
- **The push still needs the reader dependency** (a model key) though it makes no reader call: a no-key server runs no
  push.
- **Production route not measured**: OpenRouter's handling of `stop` (D240, inert in the default) and its prompt
  caching (`anthropicCache` off, D145: worth ~23% of a reader or card call) need one probe each on OpenRouter, which
  this lab does not call.
- **Agents that are not Haiku** were not measured; a stronger agent should judge candidates at least as well, but
  its extra input tokens cost more per token.

## Spend

| Session | $ (Anthropic) |
| --- | --- |
| CL1 0.19, CL2 2.80, CL3 1.80, CL4 2.70, CL5 1.19, CL6 3.22, CL7 2.46, CL8 1.98 | 16.34 |
| RealUse-3: Pi 1.06, Hermes 0.32 | 1.38 |
| **Total** | **17.72** |
