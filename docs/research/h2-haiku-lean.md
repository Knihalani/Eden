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

**In plain words.**

- **Push check: nothing passes; the default is unchanged.** Feeding it a smaller pool cut its price per call by 26.5%,
  short of the 30% bar. It also handed 20 fewer facts and 18 more look-alikes (§2a). Its wait is the call itself:
  the push reaches the call 9 ms after the request, so starting it earlier saves under 1%. A no-model skip rule
  would silence only 3% of calls.
- **Card-and-intent call: nothing passes; the default is unchanged.** Most of its price is output. Batches of 40 save
  12% per item but write requests for 29% fewer items. A compact reply saves 23%, short of the 30% bar (§2b).
- **Full intent coverage is mostly a different requests file, not more items.** With the same requests, reading
  every item finds no more facts than today's lean selection, and slightly fewer look-alikes. M11's "+19" compared
  two files (§2c). For a heavy user it adds about $0.05 once and about $0.04 a month in Haiku spend [EST], and a
  new user's background enrichment takes about 72 s instead of 5 s.

### 2a. Workstream 1: the push check

**Funnel** (train seeds 42–43, 576 tasks a seed, live Haiku 5.5 check at the shipped wait of 1,500 ms, two processes
at once; `p2/calls.py`, `n2/compare.py`). Run at c26b4f2c.

| Arm | Calls | $ a call | in (cached) / out tokens | p50 / p90 s | TTFT p50 | Planted handed | Decoy handed | Neutral packets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base (15 items × 200 chars) | 1,121 | 0.000232 | 2,738 (1,184) / 128 | 0.92 / 1.34 | 0.45 | 292 | 81 | 115 |
| A (10 × 140) | 1,117 | 0.000171 (−26.5%) | 2,146 (1,171) / 123 | 0.89 / 1.36 | 0.45 | **272 (−20)** | **99 (+18)** | **126 (+11)** |

- **A fails every clause** (cost −26.5% against −30%; p50 −3%; planted −20 against a floor of −10; decoys +18 and
  neutral +11 against ceilings of +10). Seed by seed, A changed the planted handed +4 −14 and +3 −13, and the decoys
  +29 −14 and +20 −17. Some of that is the check's own noise (D931: it names the same items 75–79% of the time), but
  the rule is read as written.
- **B (12 × 160) was not run.** B reads more of every pool than A, so its input, and with it its $ a call, cannot
  fall further than A's. B cannot reach −30% [EST, by construction].
- **Where the check's yes items sit (base, `h2/skip.py`).** Of the planted facts the check named on hidden tasks,
  8 of 150 sat at pool positions 11–15, the ones A drops (74, 33, 11, 11 and 5 at positions 1–5). That is about the −20
  above over 384 tasks, with the noise. The check's whole price is the pool. Its instructions are cached and its
  output is a fixed shape (D822). So no cut in what it reads keeps its facts at −30%.
- **Skip rule** (no read item shares a content word or number with the request): on base's 392 dumped calls it
  settles 12 silent (3.1%, against ≥ 10%), and among them the check had named a planted fact once and something in 4
  pools. Fails; not built. M7's finding stands: Haiku's yes is semantic (D930).
- **Speculative start.** With no checker and connectors at their profiles' latency (`-- --time 1`, train1–3 seed 42,
  124 handed pushes), the push reaches its packet in **8.7 ms at p50 and 18.5 ms at p90**. That is the most a check
  started earlier could overlap, against a call of about 920 ms: under 1% (the rule's bound is 10%). Not built. The
  push already runs on the index before the poll answers (`readerPushBehind`), so the check starts within milliseconds
  of the request.
- **Prompt caching** is already where it can be (§0); a 1-hour TTL would only pay where traffic leaves 5-minute gaps,
  and the check's prefix is shared by every user. **A tighter reply** was measured by P2 (D822). It halved the output
  and cut p50 by 0.19 s, and let look-alikes in. Not re-run.

No arm went to Pi; the default's check is unchanged.

### 2b. Workstream 2: the card-and-intent call

**Screen** (`h2-cards-screen.ts`, 400 items of train1–6 seed 41 as the shipped enricher sends them for intent, 211
prefilter passes; Haiku 5.5, thinking off; 70 calls, $0.105). Run at 90d1a665.

| Arm | Calls | $ a item | in (cached) / out tokens a item | p50 s a call | Items carded | Items given requests | Requests a item | Card kind / request words vs B20 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B20 (shipped) | 20 | 0.0000729 | 201 (66) / 117.5 | 9.3 | 227 | 335 | 2.38 | |
| B20b (the same again) | 20 | 0.0000685 | 201 (66) / 108.7 | 8.2 | 217 | 294 | 2.00 | 0.820 / 0.358 |
| B40 | 10 | 0.0000644 (−12%) | 167 (33) / 101.2 | 15.3 | 218 | **239 (−29%)** | 1.56 | 0.745 / 0.334 |
| K20 (compact reply) | 20 | 0.0000561 (−23%) | 201 (63) / 83.1 | 7.2 | 225 | 399 (+19%) | 2.46 | 0.760 / 0.362 |

- **Output is 80% of a card call's price** [EST from B20's tokens: 117.5 out against 135 uncached and 66 cached in a
  item]. That fixes what each lever can do. More items a call saves on the cached instructions and the per-item
  instruction overhead (−12%). But Haiku then writes requests for far fewer items (239 against 294–335): it shortens
  its answer over a long batch. A compact reply drops the key names (−29% output tokens, −23% $ a item) and keeps
  every item's requests. Neither reaches −30%. Against the mean of the two B20 runs, K20 is −20%.
- Haiku's own repeat (B20b) agrees with B20 on the card kind for 82% of items and shares 36% of request words, so
  B40's and K20's agreement (75–76%, 33–36%) sits near Haiku's own noise.
- By the rule neither goes to the funnel; the screen stays as lab tooling. **The Message Batches API stays rejected
  (D242)**: the wait it costs a new user and the shipped route have not changed.

### 2c. Workstream 3: full intent coverage (a decision input; not promoted)

**What "full" is.** The lab's "full" index (`--coverage full`) replays `intent-v2`, Haiku's requests written for every
item in separate batches. Under the default's lean selection (`cardsLean`, 7 days) the enricher reads 6,560 items'
requests from it on train seeds 41–42. With `cardsLean` false it reads 35,486. The shipped file (`cards-shipped`,
what `cold-start.ts` recorded through `buildPartner`) has requests for 2,805 of the items the lean selection reads,
so "shipped" against "full" mixes two things: which items are read, and which recorded requests exist for them.

**Funnel ($0; seeds 41–42).** Run at main 39237c4b (no engine change since).

| Families | shipped (default) | lean-full (default, Haiku every-item requests) | every (`cardsLean` false, the same requests) |
| --- | --- | --- | --- |
| train1–6, hidden / decoys of 384 | 281 / 264 | 315 / 276 | 305 / 266 |
| train5–6, 5r–6r, hidden / decoys of 256 | 196 / 159 | 213 / 171 | 210 / 168 |
| the same, neutral given a packet of 256 | 243 | 240 | 232 |
| longtail, hidden / decoys of 48 | 30 / 28 | 28 / 29 | 30 / 28 |
| longtail, neutral given a packet of 48 | 36 | 35 | 31 |
| held-out pooled (n 304 hidden) | 226 / 187 | 241 / 200 | 240 / 196 |

- **Reading every item adds nothing over today's selection when the requests are the same**: on the held-out
  families pooled, 240 against 241 facts, 196 against 200 look-alikes, 263 against 275 neutral packets; on all of
  train 305 against 315.
- **The gain M11 saw (D971: 300 / 252 against 281 / 264) is the requests file**, not coverage: "lean-full" reads the
  same items as shipped and finds +15 facts on the held-out families. The shipped file lacks requests for most of
  the items the funnel's lean selection reads, probably because it was recorded on `cold-start.ts`'s own clock and
  batches. In the funnel (no wall clock) those items get no requests [EST: the cause is not measured here]. So the funnel's
  shipped figure may understate what the shipped pipeline writes in a deployment. That is a lab question
  (D714, D872), worth its own session; it changes no engine figure here.
- 15 of longtail's 48 planted hidden facts have no requests in any file (Haiku wrote none, or their items are built
  differently by the lab's two world builders); the longtail rows read the same in all three arms.

**Cost** (`cold-start.ts` through `buildPartner`, users w41–w43, about 1,500 items each; Anthropic-direct lab figures):

| | default (lean) | every item |
| --- | --- | --- |
| items sent to the card call, backfill | 107–113 | 1,468–1,474 |
| calls; $ a user, backfill | 7; $0.0074–0.0080 | 74; $0.0575–0.0605 |
| time to idle (enrichment) | 3.5–6.3 s | 69.8–74.2 s |

A heavy user (50 new items a day) [EST]: today about 14 of 50 a day reach the card call. That is COST-MODEL's 10 of
36 (CL3), scaled. Every item sends about 49. At the measured $0.000040 a item sent (every-item backfill: $0.0587
over 1,470 items), that adds 35 × $0.00004 ≈ **$0.0014 a day, about $0.04 a user-month**, on top of a one-time
**+$0.051** backfill. So about **+$0.09 in a heavy user's first month and +$0.04 a month after**, against today's
$0.026 for a first month (COST-MODEL). Roughly 3–4 times today's background spend, for no measured gain in facts
on the funnel. The Pi pair (§2d) is the live read.

### 1d. Addendum (before the Pi pair's first call): workstream 3's Pi pair, exactly

Written after workstreams 1 and 2 stopped on their screens (§2) and after workstream 3's funnels were read; no Pi call
made yet. Both arms replay the same requests (`--coverage full`: Haiku's every-item index), so they differ only in
which items the enricher reads for their requests; the background card calls are replayed, so this pair measures the
agent's answers, not the card bill (that is §2's cold-start figure).

```bash
EDEN_COMMIT=<this commit> SSL_CERT_FILE=/root/.ccr/ca-bundle.crt .venv-modal/bin/modal run \
  packages/sim/modal/lab_fanout.py --kind pi-ab --suites train5,train6,train5r,train6r --seeds 41,42,43,44 --cap 8 \
  --run h2-every --args "--config default --tenant-prompt --push payload --source-profile \
  packages/sim/lab/before-after/market-profiles/direct.json --model claude-haiku-5-5 --grader claude-haiku-5-5 \
  --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --cards <fanout_plan.CARDS> --coverage full \
  --conditions eden,eden~every --variant-config {\"every\":{\"cardsLean\":false}} --variants hidden,control,neutral"
bun packages/sim/src/lab/i3-regrade.ts --results <the four shards' out.json> --conditions eden,eden~every \
  --spend-ledger .local/h2/ledger.jsonl --spend-cap 25 --run-label h2-every-sonnet
python3 -I packages/sim/modal/bench_report.py --pair eden~every:eden --group every=<run dir> --sonnet
```

Read: hidden raised (Sonnet) with its template-clustered interval; Sonnet-confirmed concerns on control and neutral;
Eden's per-task $ and wall. Reported to the owner as a decision input; nothing is promoted (the brief), whatever it
reads. The whole pair, regrade included, stops at $8.

### 1e. Addendum (the parent's ask, before its first call): a requests-only call

If cards go micro or off (M10), the background call could write intent requests only. Arms on §1b's 400 items,
interleaved by batch, in a run of their own: **B20** (the shipped call again, the reference), **R20** (requests only:
the shipped prompt's opening and data rule, the day, and its intent instructions word for word less the card clause
and the cards in the example reply; about 250 system tokens, under Haiku's 512-token cache minimum) and **RK20** (R20
with the compact `r`, the item number first). `--arms B20,R20,RK20`. Reported: $ a item, tokens, items given requests,
requests a item and request words against B20's (Jaccard), beside §2b's B20 and B20b. A measurement for the parent
and M10; no rule decides anything here (no cards would be M10's decision).
