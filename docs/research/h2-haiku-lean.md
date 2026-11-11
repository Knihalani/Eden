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
run and read at $0 before this commit, while finding what "full" means in the funnel; no rule here depends on them);
lean-full against every isolates what reading more items is worth with the same requests.

**Pi pair (cap $8; addendum with the exact command before its first call).** `eden` against `eden~every`
(`cardsLean` false), `--coverage full`, held-out families, Haiku 5.5 agent, Sonnet regrade; hidden raised (clustered
interval), confirmed concerns, Eden's background $ (card calls) and total $ per 1,000 tasks.

**Cost per heavy user-month (measured, then arithmetic).** `cold-start.ts` through `buildPartner` for 3 users with
and without `cardsLean` false: the one-time backfill's $ and calls. The daily trickle at 50 new items a day: items
read a day under each setting × the measured $ a item.

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

**Amended before §1e's run (after the review found the dropped requests lists, §2b):** a fourth arm, **B20r**: the
shipped prompt with `"requests":[...]` added to its first example reply (the card format sentence), nothing else
changed. The shipped first example shows `{"cards":[...]}` alone, and B20 and B20b left the whole requests list out of
3 and 5 of 20 replies. Read: batches with no requests list, items given requests, $ a item, card kind and request
words against B20. `--arms B20,B20r,R20,RK20`. A measurement: a prompt change for the shipped call would be a trial of
its own (it changes every card cache key's replay), pre-registered in a later session if this reads well.

## 2. Results

**In plain words.**

- **The push check: nothing passed, and the default is unchanged.** A smaller pool cut its price per call by 26.5%,
  short of the 30% bar, and it handed 20 fewer facts and 18 more look-alikes (§2a). Its wait is the call itself: the
  push reaches the call about 9 ms after the request, so starting it earlier saves under 1%. A no-model skip rule
  would settle only 3.5% of calls.
- **The card-and-intent call: nothing passed, and the default is unchanged.** Output is about 80% of its price.
  Batches of 40 save nothing once the batches with no requests list are set aside. A compact reply saves 27%, short
  of 30% (§2b).
- **A finding along the way: the shipped card call leaves the whole requests list out of about a quarter of its
  replies** (15 of 60 batches over three runs), so those items get no intent requests. Showing the list in the
  prompt's first example cut it to 1 of 20 and raised the items given requests from 260 to 379 of 400, at no extra
  cost an item. That needs its own trial: it changes what every card cache replays (§2b, D1053).
- **A requests-only call** (if cards go micro or off, M10) costs 45% less an item (57% with a compact reply) and
  answers in 3.4–4.8 s instead of 8.5 s. Its requests overlap B20's less than B20's overlap its own repeat (§2b).
- **Full intent coverage is mostly a different requests file, not more items.** With the same requests, reading
  every item finds no more facts than today's lean selection, on the funnel (240 against 241 on the held-out
  families) and on Pi (−1.8 points, −5.5..+2.0). M11's "+19" compared two files. For a heavy user it adds about
  $0.05 once and $0.04 a month [EST], and a new user's background enrichment takes about 72 s instead of 5 s (§2c).

Anthropic $3.13 in all: `.local/h2/ledger.jsonl` books $1.43 (the Sonnet regrade's $0.58 included), the Modal shards'
ledgers $1.70. Modal compute: four shards of about 2.5 minutes each.

### 2a. Workstream 1: the push check

**Funnel** (train seeds 42–43, 576 tasks a seed, live Haiku 5.5 check at the shipped wait of 1,500 ms, two processes
at once; `p2/calls.py`, `n2/compare.py`; run at c26b4f2c):

| Arm | Calls | $ a call | in (cached) / out tokens | p50 / p90 s | TTFT p50 | Planted handed | Decoy handed | Neutral packets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base (15 items × 200 chars) | 1,121 | 0.000232 | 2,738 (1,184) / 128 | 0.92 / 1.34 | 0.45 | 292 | 81 | 115 |
| A (10 × 140) | 1,117 | 0.000171 (−26.5%) | 2,146 (1,171) / 123 | 0.89 / 1.36 | 0.45 | **272 (−20)** | **99 (+18)** | **126 (+11)** |

- **A fails every clause.**
  - Cost a call −26.5% against a bar of −30%; p50 −3%.
  - Planted −20 against a floor of −10.
  - Decoys +18 and neutral packets +11 against ceilings of +10.
  - Seed by seed, A moved planted handed +4 −14 and +3 −13, and decoys +29 −14 and +20 −17. Part of that is the
    check's own noise: it names the same items only 75–79% of the time (D931). The rule is read as written.
- **B (12 × 160) was not run.** It reads more of every pool than A, so its $ a call cannot fall further than A's,
  and A missed the bar [EST, by construction].
- **Where the check's yes items sit** (base's 1,125 dumped calls, `h2/skip.py`).
  - Of the 289 planted facts the check named on hidden tasks, 12 sat at pool positions 11–15, the ones A drops. By
    position 1–5 the counts are 150, 66, 19, 12 and 6.
  - So the dropped positions explain about 12 of A's −20; the 140-character items and the check's noise the rest.
  - The check's price is the pool: its instructions are cached, and its output is a fixed shape (D822). So no cut
    of what it reads keeps its facts at −30%.
- **Skip rule** (no item read shares a content word or a number with the request). On the 1,125 calls it settles 39
  silent (3.5%, against a bar of ≥ 10%). In those pools the check had named the planted fact twice, and named
  something in 6. It fails and is not built: Haiku's yes is semantic, as M7 found (D930).
- **Speculative start.** Measured at $0 with no checker wired, unlike the pre-registered live run: train1–3 instead
  of train1–2, seed 42, connectors at their profiles' latency (`-- --time 1`), 124 handed pushes.
  - The push reaches its packet in **8.7 ms at p50 and 18.5 ms at p90**. That is the most a check started earlier
    could overlap, against a call of about 920 ms: under 1%, against a bound of 10%. Not built.
  - The push already runs on the index before the poll answers (`readerPushBehind`), so the check starts within
    milliseconds of the request.
- **Prompt caching** is already where it can be (§0). A 1-hour TTL would pay only where traffic leaves 5-minute gaps,
  and the check's prefix is shared by every user. **A tighter reply** was measured by P2 (D822): it halved the
  output, cut p50 by 0.19 s and let look-alikes in. Not re-run.

No arm went to Pi; the default's check is unchanged (D1050, D1051).

### 2b. Workstream 2: the card-and-intent call

**Screen** (`h2-cards-screen.ts`; `h2/w2.py` reads it). The 400 items are those of train1–6 seed 41 that the
shipped enricher sends for intent: the strict prefilter's passes (211) and the rejects `readForIntent` keeps. Unlike
the enricher, the screen does not apply sentence reuse or known-card reuse. Haiku 5.5, thinking off, called directly
with `cardMessages` and the maker's output cap (not through `ModelCardMaker`). Run 1 at 90d1a665: 70 calls, $0.105.
Run 2 (§1e) at 073b97e5: 80 calls.

"Listed-only" is the $ a item over the batches whose reply held a requests list. A reply with none leaves its whole
batch without requests, and is cheaper because it is shorter, so it flatters the plain $ a item.

| Run, arm | Calls | $ a item | listed-only $ a item | Batches with no requests list | in (cached) / out tokens a item | p50 s | Items carded | Items given requests | Requests a item |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1, B20 (shipped) | 20 | 0.0000729 | 0.0000765 | 3 of 20 | 201 (66) / 117.5 | 9.3 | 227 | 335 | 2.38 |
| 1, B20b (the same again) | 20 | 0.0000685 | 0.0000741 | 5 of 20 | 201 (66) / 108.7 | 8.2 | 217 | 294 | 2.00 |
| 1, B40 | 10 | 0.0000644 | 0.0000767 (+0%) | 4 of 10 | 167 (33) / 101.2 | 15.3 | 218 | 239 | 1.56 |
| 1, K20 (compact reply) | 20 | 0.0000561 | 0.0000561 (−26.7%) | 0 of 20 | 201 (63) / 83.1 | 7.2 | 225 | 399 | 2.46 |
| 2, B20 (shipped) | 20 | 0.0000665 | 0.0000766 | 7 of 20 | 201 (63) / 104.0 | 8.5 | 224 | 260 | 1.80 |
| 2, B20r (list in the first example) | 20 | 0.0000759 | 0.0000770 (+1%) | 1 of 20 | 201 (63) / 122.7 | 9.2 | 237 | 379 | 2.53 |
| 2, R20 (requests only) | 20 | 0.0000419 | 0.0000419 (−45%) | 0 of 20 | 152 (0) / 53.4 | 4.8 | — | 387 | 2.87 |
| 2, RK20 (requests only, compact) | 20 | 0.0000333 | 0.0000333 (−57%) | 0 of 20 | 151 (0) / 36.4 | 3.4 | — | 391 | 2.30 |

Percentages are against the same run's B20, listed-only.

Agreement with the same run's B20 on the 400 items is read two ways. Card kind is compared on every item. Request
words are the Jaccard of content words of four letters or more, over every item (an item one arm left without
requests has no words; both without counts as 1) and over the items both arms gave requests:

| Arm | Card kind | Request words, every item | Request words, both requested (items) |
| --- | --- | --- | --- |
| B20b (Haiku's own repeat) | 0.820 | 0.358 | 0.478 (250) |
| B40 | 0.745 | 0.334 | 0.417 (217) |
| K20 | 0.760 | 0.362 | 0.434 (334) |
| B20r | 0.767 | 0.275 | 0.461 (239) |
| R20 | — | 0.234 | 0.363 (250) |
| RK20 | — | 0.226 | 0.345 (253) |

- **Output is about 80% of the call's price** [EST from B20's tokens a item: 117.5 out, 135 uncached and 66 cached
  in]. That fixes what each lever can do.
- **More items a call saves nothing.** On the batches that list requests, B40 costs the same a item as B20. Its lower
  plain figure came from 4 of its 10 replies having no requests list (160 items).
- **A compact reply saves 26.7%** a item, short of the 30% bar. It also changed the example reply (`r` shown beside
  `c`), which is the likelier reason it never dropped the list. Neither arm goes to the funnel (D1052).
- **The shipped prompt drops the requests list** (D1053; found by the review).
  - B20 left the whole list out of 3, 5 and 7 of 20 replies in three runs: 15 of 60, 25%. Within batches that
    listed requests, almost every item got some.
  - In `CardEnricher` an item in such a batch keeps its card and is not read again for intent. The cold-start runs
    agree: 93–109 of 107–113 items sent got requests under the default.
  - The likely cause is the first format sentence. Its example reply is `{"cards":[...]}` alone; the requests key
    appears only in the intent paragraph after it.
  - B20r adds `"requests":[...]` to that first example and nothing else: 1 of 20 replies without the list, 379 items
    given requests against 260, at the same price per item covered. Its card kinds agree with B20 at 0.767, against
    Haiku's own 0.820.
  - Not taken here. A shipped prompt change re-keys every replayed card and intent cache, so it needs a trial of its
    own with fresh shipped caches, a funnel and a Pi pair. Recommended as the next session's first step.
- **Requests only** (R20, RK20; the parent's ask, for M10).
  - 45% and 57% less an item, 3.4–4.8 s a call against 8.5 s, and no dropped lists.
  - Its prompt (about 250 tokens) is under Haiku's 512-token cache minimum, so none of it is cached; it is still the
    cheapest shape.
  - Its requests share fewer words with B20's (0.36 and 0.35 where both requested) than B20's repeat does (0.48):
    without the card part, Haiku writes different requests. Their funnel effect is not measured. That is the step
    before any requests-only call ships.
- **The Message Batches API stays rejected (D242):** the wait it costs a new user and the shipped route have not
  changed.

### 2c. Workstream 3: full intent coverage (a decision input; not promoted)

**What "full" is.**

- The lab's "full" index (`--coverage full`) replays `intent-v2`: Haiku's requests written for every item, in
  separate batches.
- Under the default's lean selection (`cardsLean`, 7 days), the funnel's enricher reads 6,560 items' requests from
  it on train seeds 41–42. With `cardsLean` false it reads 35,486.
- The shipped file (`cards-shipped`, recorded by `cold-start.ts` through `buildPartner`) holds requests for only
  2,805 of the items the lean selection reads.
- So "shipped" against "full" mixes two things: which items are read, and which recorded requests exist for them.

**Funnel ($0; seeds 41–42; run at main 39237c4b, no engine change since):**

| Families | shipped (default) | lean-full (default, Haiku's every-item requests) | every (`cardsLean` false, the same requests) |
| --- | --- | --- | --- |
| train1–6, hidden / decoys of 384 | 281 / 264 | 315 / 276 | 305 / 266 |
| train5–6, 5r–6r, hidden / decoys of 256 | 196 / 159 | 213 / 171 | 210 / 168 |
| the same, neutral given a packet of 256 | 243 | 240 | 232 |
| longtail, hidden / decoys of 48 | 30 / 28 | 28 / 29 | 30 / 28 |
| longtail, neutral given a packet of 48 | 36 | 35 | 31 |
| held-out pooled (304 hidden): hidden / decoys / neutral packets | 226 / 187 / 279 | 241 / 200 / 275 | 240 / 196 / 263 |

**Pi pair** (§1d, at 2246d56d: train5, train6, train5r, train6r, seeds 41–44, hidden, control and neutral, 3,072
task runs, no 429; Sonnet 5.5 regraded 1,035 answers, 0 failed; `bench_report.py --sonnet`; $1.70 the run, $0.58 the
regrade):

| `eden~every` − `eden`, both `--coverage full` | |
| --- | --- |
| Hidden raised (Sonnet) | −1.8 points (−5.5..+2.0), 78.3 vs 80.1, n 512 pairs over 128 templates |
| Confirmed concerns, control and neutral | +0.0 (−0.3..+0.3): 1 vs 1 of 1,024 |
| Eden's per-task $ per 1,000 tasks (card calls replayed, so not in it) | −0.009 (−0.016..−0.002) |
| Wall a task | −0.045 s (−0.090..+0.000) |
| `ask_context` calls a task | +0.043 (+0.005..+0.081) |

- **Reading every item adds nothing over today's selection when the requests are the same.**
  - Funnel, held-out pooled: 240 against 241 facts, 196 against 200 look-alikes, 263 against 275 neutral packets.
  - Funnel, all of train: 305 against 315.
  - Pi: −1.8 points, with an interval from −5.5 to +2.0.
- **M11's gain (D971: 300 / 252 against 281 / 264) is the requests file, not coverage.** "lean-full" reads the same
  items as "shipped" and finds +15 facts on the held-out families.
  - The shipped file lacks requests for most of the items the funnel's lean selection reads. Two likely causes
    [EST, neither measured here]: it was recorded on `cold-start.ts`'s own clock and batches, and the shipped prompt
    drops whole requests lists (§2b).
  - So the funnel's shipped figure may understate what the shipped pipeline writes in a deployment. Fixing the
    dropped lists is the cheaper route to that gain (D1053).
- 15 of longtail's 48 planted hidden facts have no requests in any file: Haiku wrote none, or the lab's two world
  builders build their items differently. The longtail rows differ by at most two facts between arms.

**Cost** (`cold-start.ts` through `buildPartner`, users w41–w43, about 1,500 items each; Anthropic-direct lab
figures):

| | default (lean) | every item |
| --- | --- | --- |
| Items sent to the card call, backfill | 107–113 | 1,468–1,474 |
| Calls; $ a user, backfill | 7; $0.0074–0.0080 | 74; $0.0575–0.0605 |
| Time to idle (enrichment) | 3.5–6.3 s | 69.8–74.2 s |

A heavy user at 50 new items a day [EST]:

- **Today:** about 14 of the 50 reach the card call a day. That is COST-MODEL's 10 of 36 (CL3), scaled. Scaled the
  same way, a first month costs about $0.031 (COST-MODEL: $0.026 at 36 a day).
- **Every item:** about 49 a day reach the call. At the measured $0.000040 an item (the every-item backfill: $0.0587
  over 1,470 items), the extra 35 a day add about **$0.0014 a day, $0.04 a user-month**, on top of a one-time
  **+$0.051** backfill.
- **Together:** about **+$0.09 in a heavy user's first month and +$0.04 a month after**, roughly three to four times
  today's background spend, for no measured gain in facts. Not promoted (the brief); the owner's call.

## 3. Decisions

- **D1050** Rejected: a leaner push-check pool (`pushCheckItems` 10, `pushCheckItemChars` 140). Both settings already
  exist; nothing changes.
- **D1051** Rejected, not built: a no-model skip rule and a speculative start for the push check.
- **D1052** Rejected: more items a card call (40) and a compact card reply. The Message Batches API stays rejected
  (D242 unchanged).
- **D1053** Finding: the shipped card prompt leaves the whole requests list out of about a quarter of its replies. A
  trial of the fix (B20r's example) is recommended.
- **D1054** Finding: full intent coverage adds no facts over the lean selection with the same requests (funnel and
  Pi), at about +$0.04 a heavy user-month [EST].
- **D1055** Lab tooling: `h2-cards-screen.ts` (with `--show`, `--arms`), `h2/skip.py`, `h2/w2.py`, `readForIntent`
  exported from `@eden/engine`, and the `p2/calls.py` fix (ledger rows without a time to first token).

## 4. Reproduce

```bash
unset OPENROUTER_API_KEY; L="--spend-ledger .local/h2/ledger.jsonl --spend-cap 25 --spend-headroom 0.5"
# §2a, one process a seed (S = 42, 43); arm A adds --set '{"pushCheckItems":10,"pushCheckItemChars":140}'
bun run funnel --suite train --seeds S --jobs 1 --json B-S.json -- --neutral --check live \
  --check-cache c-S.jsonl --check-dump B-S.dump.jsonl $L --run-label h2-w1-base-S
python3 -I packages/sim/lab/p2/calls.py .local/h2/ledger.jsonl
python3 -I packages/sim/lab/n2/compare.py --arm base=B-42.json --arm A=A-42.json
python3 -I packages/sim/lab/h2/skip.py B-42.dump.jsonl B-43.dump.jsonl
bun run funnel --suite train1,train2,train3 --seeds 42 --jobs 3 --json t1.json -- --time 1       # deliveryMs
# §2b
bun packages/sim/src/lab/h2-cards-screen.ts --items 400 --out w2.jsonl $L --run-label h2-w2
bun packages/sim/src/lab/h2-cards-screen.ts --items 400 --arms B20,B20r,R20,RK20 --out w2r.jsonl $L
python3 -I packages/sim/lab/h2/w2.py w2.jsonl; python3 -I packages/sim/lab/h2/w2.py w2r.jsonl
# §2c: the funnels (add --suite train for the train rows); longtail's top-up first
bun packages/sim/src/lab/cards-enrich.ts --dir .local/h2/lt --funnel longtail --seeds 41,42 --intent \
  --model claude-haiku-5-5 --batch 20 $L --spend .local/h2/lt/spend.jsonl --cap 0.1   # intent-v2.jsonl copied in
bun run funnel --suite train5,train6,train5r,train6r --seeds 41,42 --jobs 4 --coverage shipped -- --neutral
bun run funnel --suite train5,train6,train5r,train6r --seeds 41,42 --jobs 4 --coverage full -- --neutral
bun run funnel --suite train5,train6,train5r,train6r --seeds 41,42 --jobs 4 --coverage full \
  --set '{"cardsLean":false}' -- --neutral
bun packages/sim/src/lab/cold-start.ts --users user:41,user:42,user:43 [--set '{"cardsLean":false}'] $L
# the Pi pair and its regrade: §1d's commands
```
