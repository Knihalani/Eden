# H2: the two Haiku calls that stay, made cheaper and faster

Status: 2026-11-11, branch `claude/h2-haiku-lean` (from main 39237c4b), session H2. Decisions D1050–D1059. Train
suites, reworded train and longtail only; heldout19 is never read or run. Paid calls go to Anthropic directly with
`HAIKU_API_KEY` through the lab's spend ledger (`.local/h2/ledger.jsonl`, D97): **Anthropic-direct lab figures**.
Caps: Anthropic $25, Modal only if needed. Numbers marked **[EST]** are arithmetic or judgement; every other number
comes from a command in this note.

## 0. Where the money and the time go today ($0, from earlier sessions' ledgers and the code)

**The push check (D828).** One call a push with a constraint-like pool: the fixed instructions (`CHECK_SYSTEM`,
about 1,180 tokens, cached), then the day, the request's head and up to 15 items of up to 200 characters each, each in
an `<item>` fence with source, date and sender. P2 measured (form 2, train seeds 42–43, D822): 2,752 input tokens of
which 1,182 cached, 127 output, $0.000233 and 1.03 s at p50 a call. At Haiku 5.5's prices ($0.10 / $0.01 cached /
$0.50 per million) that is **uncached input 67%, output 27%, cache reads 5%** [EST from those token counts]. The
instructions are already cached (`anthropic.ts` marks the last system block; Haiku 5.5 caches from 512 tokens, reads
at 0.1×, writes at 1.25× for 5 minutes; the prefix holds no user content, so every user shares it). Haiku 5.5 takes
no assistant prefill (a 400), so the reply's opening cannot be prefilled.

- What is left for cost: the **items** (about 1,400 uncached tokens a call) and the **output** (127 tokens).
- What is left for latency: almost all of it is the call. Most of the call is output tokens; D822 halved the output
  (form 3) and cut p50 by 0.19 s (−18%) but let look-alikes back in (185 against 69 handed). A −30% p50 needs more
  than halving the output, so this note does not try another reply format (D822's measurement stands).

**The card-and-intent call (D59, D87, `cardsEconomy` batches of 20).** COST-MODEL's run `close-cards-reasoning`
(thinking off, 17 calls): 3,801 input tokens (1,242 cached) and 1,484 output a call, $0.001012. Output is **73%** of
its cost, uncached input 25%, cache reads 1% [EST from those counts]. The instructions are cached already (the system
block carries the day, so the first call of a day writes it; every user shares it). So more items a call amortises
only the cached instructions and the per-call overhead: [EST] batches of 40 save at most about 2% a item. Of the output,
in the checked-in shipped cards (`cards-shipped.jsonl.gz`, 11,024 items), cards average 92 characters a item and
requests 92 (2.3 requests a item, 49% of items carded).

## 1. Pre-registration (committed before any paid call of this session)

Each workstream's rule is fixed here. Anything added later is an addendum committed before its own paid run.

### 1a. Workstream 1: the push check's input (funnel, live check)

**Shape.** `bun run funnel --suite train --seeds S --jobs 1 -- --neutral --check live --check-cache F --check-log L
--check-dump D`, S = 42 and 43 one process each (P2's A shape), live Haiku 5.5 check, the run's own ledger. Every
arm the shipped default except the named settings. Measured per arm: $ a check call, input (cached) and output
tokens, p50 and p90 seconds (`p2/calls.py`), planted handed, decoy handed and neutral packets (`n2/compare.py`,
pooled over the two seeds: 384 hidden, 384 control, 384 neutral).

- **base**: the default (`pushCheckItems` 15, `pushCheckItemChars` 200).
- **A** (the lean pool): `pushCheckItems` 10, `pushCheckItemChars` 140.
- **B** (milder): `pushCheckItems` 12, `pushCheckItemChars` 160.

**Rule (which arm goes to Pi).** An arm passes the screen if its $ a call is at least 30% below base's (or its p50
at least 30% below), and, pooled, planted handed ≥ base − 10, decoy handed ≤ base + 10 and neutral packets ≤ base +
10. A goes to Pi if it passes; else B if it passes; else none, and the workstream reports the trade. (Both settings
already exist; no new code.)

**Skip rule (read at $0 from base's and the chosen arm's `--check-dump`).** A deterministic rule that settles a
pool silent with no call: **no item the check reads shares a content word (four letters or more, not a stopword) or
a number with the request's head.** Reported: calls it saves, and the planted and decoy items the check named in the
pools it would silence. It goes to Pi with the arm only if it saves ≥ 10% of calls and silences at most 2 of 384
planted items handed by the check; otherwise it is reported and not built. (M7, D930, found Haiku's yes semantic: a
yes on 29% of pools whose gated items share nothing with the request. This rule is expected to fail; it is measured
because the owner asked for it.)

**Speculative start (read at $0 from code and one small run).** The check already starts on the push's first
ranking of the local index (`readerPushBehind`: before the on-demand poll answers). One run with `--time 1` (train1
and train2, seed 42, hidden, live check, about $0.02 [EST]) reports, per checked push, the push's own time against its
check call's time: the share of the push's wait spent before the check starts is what a speculative start could save
at most. If that share's p50 is under 10% of the push's wait, nothing is built.

**Pi pair (the chosen arm, if any; committed as an addendum before its first call with its exact command).** P2's
bench-tools harness on Modal, Haiku 5.5 agent, grader and check, `eden` against `eden~V` (the arm's settings), train
seeds 41–48, all templates, hidden, control and neutral, two shards at a time; every hidden answer and every concern
regraded by Sonnet 5.5. **Bar (the brief's):** Eden's cost a check −30% (or check p50 −30%) on the Pi ledger, hidden
raised (Sonnet) with its template-clustered lower bound above −1.5 points, Sonnet-confirmed concerns not up. Pass:
the arm's settings join `DEFAULT_CONFIG` (D814). Fail: nothing changes. Cap $7.

### 1b. Workstream 2: the card-and-intent call's cost per item

**Screen** (`packages/sim/src/lab/h2-cards-screen.ts`, written for this): the same 400 items (unique, redacted as the
cache holds them, sorted by content hash, first 400 of train1–6 seed 41's items the shipped enricher would send for
intent: prefilter passes and lean-window rejects), sent with the shipped prompt (`cardMessages`, intent on) through
`ModelCardMaker`, Haiku 5.5, thinking off, arms interleaved batch by batch:

- **B20**: batches of 20 (shipped).
- **B40**: batches of 40.
- **K20**: batches of 20 with a compact reply (cards and requests as positional arrays, no key names; the same
  instructions otherwise), parsed by the screen into the same `Card` and requests.

Measured per arm: $ a item, input (cached) and output tokens a item, p50 a call, items carded (kind not none),
items given requests, requests a item; for B40 and K20, agreement with B20 on each item's card kind and the
requests' word overlap (Jaccard of content words) against B20's own repeat agreement (B20 sent twice).

**Rule.** An arm goes on to the funnel only if its $ a item is ≥ 30% below B20's and items carded and items given
requests are each within 5% of B20's. The funnel step (re-enriching train seeds 41–42's every item with B20 and the
arm, `--coverage full` funnels of both files, requests' funnel effect hidden and decoys within ±5 of each other) is
an addendum written before its run. Otherwise the arm is reported and deleted. Budget about $0.10 [EST] for the
screen. **The Message Batches API stays rejected (D242):** nothing it was rejected for has changed (a new user waits
17–22 minutes for cards and intent, the state that costs most recall; the shipped route is OpenRouter, which has no
batch API), so it is not re-run.

### 1c. Workstream 3: full intent coverage, a decision input for the owner (not promoted)

"Full coverage" in production is `cardsLean: false`: every item a sync stores is read by the card call for its
requests, not only prefilter passes and recent person-written items (today about 11–15% of items).

**Funnel ($0, replayed).** Held-out families train5, train6, train5r, train6r and longtail, seeds 41–42, `--
--neutral`, three arms: **shipped** (the default, `--coverage shipped`), **lean-full** (the default, `--coverage
full`: Haiku's every-item requests replayed, the shipped lean selection reads them) and **every** (`--coverage full`,
`cardsLean` false: every item reads them). Longtail's rare-connector items are topped up into a copy of
`intent-v2.jsonl` first (`cards-enrich.ts --intent`, 107 items, 6 calls, about $0.01 [EST]). shipped against every is
the owner's question; (the train5–6 and 5r–6r funnels of these three arms and the same three on all of train were
run and read at $0 before this commit, while finding what "full" means in the funnel; no rule here depends on them); lean-full against every isolates what reading more items is worth with the same requests.

**Pi pair (cap $8; addendum with the exact command before its first call).** `eden` against `eden~every`
(`cardsLean` false), `--coverage full`, held-out families, Haiku 5.5 agent, Sonnet regrade; hidden raised (clustered
interval), confirmed concerns, Eden's background $ (card calls) and total $ per 1,000 tasks.

**Cost per heavy user-month (measured, then arithmetic).** `cold-start.ts` through `buildPartner` for 3 users with
and without `cardsLean` false: the one-time backfill's $ and calls. The daily trickle at 50 new items a day: items
read a day under each setting × the measured $ a item.

## 2. Results

(Filled in below as each run is read.)
