# Edge track "bridge": a request-time bridging query and an active-constraints digest

Status: 2026-11-01. Two engine features behind flags, off by default, measured on the no-model funnel only (the
development suites dev6a and dev6b, and the old in-sample suites). No live agent run: the lab's paid credit is nearly
spent, and these are reach measures, not facts raised. Every number below comes from a command run in this session;
estimates are labelled.

## What was built

### (a) The bridging query (`bridgeQuery`, `bridge.ts`)

[path-to-90.md](path-to-90.md) found that 89 of 122 dev misses are never candidates: the request and the decisive item
share no word ("approve the laptop order" against "any commitment above £5,000 needs a second signature"). Cards bridge
that gap from the item's side, in the background. The bridge works from the request's side.

- **When.** For a request that acts (`isImperative`, with `conflictVocab`'s wider verbs when that flag is on, or an
  `external` message), on the slow path only. With `bridgeQuestions`, also a question asking leave to act ("Can I…",
  "Is it fine if I…", "Is the week of … a good time…"). Never on the fast path, never per event.
- **The call.** One small model call (`QueryBridge` with its own `BridgeMaker`, `Budget` and model) rewrites the
  request into two or three short queries in a constraint's words. Its prompt asks what the action depends on (a
  document or licence and whether it is valid, approvals, limits and policies, the people's availability and changed
  details, whether the place or system is open, whether it was already done, deadlines).
  - The model reads the request alone, redacted and fenced as data, at most 400 characters. It never sees item text.
  - Its output is schema-checked (`parseBridge`): at most three queries of at most eight words, letters, digits and a
    few signs, redacted again. Unreadable output is no queries.
  - The call starts beside the lookup's search. The lookup waits for it at most `bridgeWaitMs` (4 s) past its own
    search, then goes on without it.
- **The cache.** Queries are cached per user by a hash of the redacted request: at most 256 requests per user, 7 days,
  bounded users per tenant, dropped with the user. An `ask` never calls. It reads the question's own cached queries, or
  the session's latest bridged request's. If that request's call is still out, the ask waits for it, at most
  `bridgeWaitMs`.
- **Using the finds.** The queries run against the user's own index (the cache a sync fills), with no source call:
  each query's best `bridgeHits` (3) items holding two of its words.
  - A find the conflict test reads as a conflict, tied by the queries' words (`assess`'s extra ties, as the
    consequence probe's class words tie its finds), counts as a consequence find in conflict does. It gets a judge
    seat, the conflict ground and an `ask` verdict hit (`bridged`).
  - With `bridgeAskSeats` (n), the best other finds that the test does not clear and that are not bulk mail take n
    seats in an `ask` answer, after the verdict hits. The agent's model judges them.

### (b) The active-constraints digest (`constraintDigest`, `digest.ts`)

- **What it lists.** The user's cached items whose card (`cards`) is a standing constraint in force: kind freeze,
  limit, absence, deadline, prohibition or dependency, with no end or an end today or later.
- **Order.** By when the item was written, an item from someone the user deals with counting as a week newer (a
  `From:` name or chat speaker who is a person in the user's items, not a no-reply sender, not bulk mail), then by
  id. One line per constraint: items whose cards say the same are folded into one line.
- **Size.** At most `digestLines` (12) lines and `digestBytes` (1,600) bytes, about 400 tokens.
- **Each line.** The item's title and the parts of its own text that bear on its card (compacted as packets are). The
  card's model-written statement is never shown: it only picks the sentences (D19).
- **Delivery.** Once at `session_start`, as data (`reason: "digest"`, the usual data envelope), and on request:
  `ContextPartner.digest`, `POST /v1/digest`, client `digest()`. The digest is not marked in the ledger: it is a
  standing list, not news, so a lookup may still deliver one of its items with its bearing on a request.
- **Byte-stable.** No date, time or count of "now" in the text. On dev, every simulated user's 30 sessions over 30
  simulated hours got one and the same digest (16 of 16 users).

### Lab only

- Free models: this track's `OpenRouterOptions.labDataCollection` was replaced at merge (edge-combined.md) by the
  lab's shared `allowLogging` and pacer (`free.ts`, edge-freelab.md); `bridge-enrich.ts` takes `--allow-logging
  --max-requests N`. `fromEnv`, the engine and the server never set it, so production still sends
  `data_collection: "deny"` and `zdr` (D12). A test pins this.
- `bridge-enrich.ts` makes the queries once, into a disk cache, sending several requests per call under the same
  instructions to stay inside the free tier. It meters every request to the model.
- `bridge-disk.ts` replays that cache in the funnel (`--bridge FILE`). `bridge-reach.ts` is the offline reach of the
  queries. `digest-reach.ts` checks the digest's inputs offline.

## Method

The no-model funnel, seeds 41–44, real sync, `--ask`, the recommended configuration ALL3 (D80) plus the flags named.

```bash
bun packages/sim/src/lab/bridge-enrich.ts --out bridge.jsonl --suite dev6a,dev6b --all --allow-logging --max-requests 120
bun packages/sim/src/lab/hidden-funnel.ts --suite dev6a,dev6b --no-record --ask \
  --config "$ALL3_PLUS_FLAGS" --cards CARDS --bridge bridge.jsonl --json out.json --packets out.jsonl
```

- **Cards.** `cards-v2.jsonl` is the committed replay. It holds no card for any dev planted item: `digest-reach.ts`
  finds all 240 hidden and 240 control planted items uncovered. So the dev runs are also made with the complete dev
  replay from [path-to-90.md](path-to-90.md) (`diag90/cards-all.jsonl`, scratchpad, not committed), which covers 162
  of 240 hidden planted items. The digest reads cards, so it is measured on that replay only.
- **Measures, per task.** hidden **either**: a packet, the ask's answer or the session's digest cited the planted item.
  **decoys**: the same on control tasks, where the decoy is planted instead.
- **Model.** nvidia/nemotron-3.5-super-vl:free, zero data retention off and data collection allowed for the lab only.
  Queries were made once and replayed.
- **Free requests.** 94 of the track's 120 were used, retries included:
  - 5 routing and debug checks;
  - 15 prompt-v1 calls cut off at a 600-token output cap before it was raised;
  - 8 for prompt v1 on dev;
  - 24 for prompt v2 on dev (89 requests, 3 never answered readably);
  - 42 for prompt v2 in-sample (170 acting requests).

## Results

### Prompt and reach (offline, `bridge-reach.ts`)

The planted item (or the decoy) among a query's best three, over the whole world as a finished sync holds it. Dev,
240 tasks per variant. "New" counts tasks the ALL3 run (cards-v2) surfaced by neither packet nor ask.

| Queries | Hidden top 3 | of them new | Decoy top 3 | of them new |
|---|---|---|---|---|
| Prompt v1 (constraint words for the named things) | 86 | 19 | 78 | 23 |
| Prompt v2 (what the action depends on), shipped | 81 | 30 | 57 | 24 |
| No-model control: the request's first three content words plus fixed constraint words | 52 | 8 | 45 | 4 |

- v2 finds fewer items in all but more of the missing ones, and fewer decoys.
- The no-model control shows the model is doing the work. It names what the action depends on: "driving licence
  expired" for a hire car, "Owen away until" for the accountant, "function room closed" for a venue booking.
- The small model copies the prompt's example phrases ("… away until", "… needs approval", "… changed to"). The
  phrasing is mechanical, but the object it names is the useful part.

### Funnel, dev (dev6a + dev6b, 240 + 240 tasks)

ALL3 plus the flags named. Hidden counts are planted items cited (of 240); decoy counts are decoys cited (of 240).
"Ask B" is mean bytes per ask answer; "pkt B" is packet bytes per task.

| Run | Cards | Hidden delivered | Hidden ask-cited | Hidden in digest | **Hidden either** | Decoy delivered | Decoy ask | Decoy in digest | **Decoy either** | Ask B | Pkt B |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ALL3 | v2 | 97 | 122 | | **122** | 10 | 91 | | **91** | 661 | 189 |
| + bridge | v2 | 98 | 127 | | **127** | 7 | 95 | | **95** | 671 | 214 |
| + bridge, questions | v2 | 102 | 131 | | **131** | 7 | 95 | | **95** | 673 | 221 |
| + bridge, questions, 1 ask seat | v2 | 102 | 139 | | **139** | 7 | 101 | | **101** | 719 | 221 |
| + bridge, questions, 2 ask seats | v2 | 102 | 138 | | **138** | 7 | 96 | | **96** | 744 | 221 |
| + no-model control queries, questions, 2 seats | v2 | 97 | 126 | | **126** | 10 | 89 | | **89** | 735 | 198 |
| ALL3 | complete | 98 | 129 | | **129** | 23 | 100 | | **100** | 684 | 216 |
| + bridge | complete | 99 | 133 | | **133** | 20 | 104 | | **104** | 694 | 241 |
| + bridge, 2 ask seats | complete | 99 | 139 | | **139** | 20 | 103 | | **103** | 758 | 241 |
| + bridge, questions, 2 ask seats | complete | 103 | 143 | | **144** | 20 | 106 | | **106** | 762 | 246 |
| + digest | complete | 98 | 129 | 34 | **145** | 23 | 100 | 19 | **108** | 684 | 216 |
| + both (bridge, questions, 2 seats, digest) | complete | 103 | 143 | 34 | **159** | 20 | 106 | 19 | **114** | 762 | 246 |

- **Bridge.**
  - +15 hidden (129 → 144) for +6 decoys (100 → 106), complete cards, questions, 2 seats. With cards-v2: +16 for +5.
  - Delivered decoys fall 23 → 20: a bridged conflict takes a packet's place.
  - It adds about 80 bytes per ask answer (+11%).
  - All of the gain is dev6a: dev6b's hidden either stays 65 (complete cards) and 61 → 60 (cards-v2). By template:
    contrast-blocker, fixed-saver, licence-lapsed and venue-deposit, 4 seeds each, and nda-lapsed once. Lost:
    offsite-headcount, 2 seeds. Decoys gained: child-passport, fixed-saver, licence-lapsed (4 each) and nda-lapsed
    (3); lost 9.
  - dev6b's misses are facts no request-side guess names, such as a surprise party behind "Reserve a table at Hoppers
    on the 31st". A request-side query cannot know them.
- **Digest.**
  - +16 hidden (129 → 145) for +8 decoys (100 → 108).
  - Unlike the bridge, the gain is mostly dev6b (65 → 76): lease-docusign, offsite-week (4 seeds each),
    legal-hold-devices, sole-approver, and client-kickoff (dev6a, 4).
  - The digest held the planted item in 34 of 240 hidden sessions and the decoy in 19 of 240 control ones.
  - Each session pays 1,377 bytes for it on average.
- **Both.** The two gains add up: 129 → 159 hidden (54% → 66%) for 100 → 114 decoys.

### Funnel, old in-sample suites (hidden, heldout, heldout2–4; 268 + 268 tasks; cards-v2)

Bridged requests acting only (`bridgeQuestions` was not enriched in-sample).

| Run | Hidden delivered | Hidden ask-cited | Hidden in digest | **Hidden either** | Decoy delivered | Decoy ask | Decoy in digest | **Decoy either** | Ask B | Pkt B |
|---|---|---|---|---|---|---|---|---|---|---|
| ALL3 | 216 | 244 | | **244** | 17 | 148 | | **148** | 638 | 278 |
| + bridge | 215 | 244 | | **244** | 17 | 144 | | **144** | 657 | 295 |
| + bridge, 2 ask seats | 215 | 246 | | **246** | 17 | 140 | | **140** | 710 | 295 |
| + digest | 216 | 244 | 83 | **252** | 17 | 148 | 49 | **181** | 638 | 278 |
| + bridge, 2 seats, digest | 215 | 246 | 83 | **254** | 17 | 140 | 49 | **172** | 710 | 295 |

- These suites are 91% reached already, so there is little left to gain.
- The bridge neither gains nor costs here: +2 hidden, −8 decoys. Its seats push lexical near-misses out of the answer.
- The digest adds +8 hidden and +33 decoys. It held the planted item in 83 sessions, but most of those facts were
  already surfaced. The decoys in these suites are near-miss constraints that are really in force, such as a freeze
  on another system or an absence in another week. A digest lists them by design, so these decoy counts measure the
  digest's noise, not false concerns.

### What production would call

- **Bridge.** One model call per bridged request. On dev, 352 of 480 tasks (0.73) were bridged, acts only; 392 (0.82)
  with `bridgeQuestions`. Each lane is its own user, so no cache was shared between the hidden and control variants.
  In-sample, 460 of 536 (0.86).
- **Cost.** Estimated in docs/COST-MODEL.md: $0.0001 to $0.00075 per bridged request at list prices, mostly reasoning
  tokens. The lab's free model wrote 1,375 output tokens for one request. Not measured on glm-5.3-flash.
- **Latency.** The free model answered one request in 4.4 to 8.8 s (three calls), longer than `bridgeWaitMs`. With
  such a model the lookup's packet goes without the bridge, and only an ask made after the call returns, or within
  4 s of it, gains. The funnel replays queries instantly, so it shows the bridge at zero latency: an upper bound for
  packets. A model or setting with no reasoning is the lever (unmeasured).
- **Digest.** No call of any kind.

## Checks

- `bun run check` is green on the final tree.
- `bun run eval` (no model) with every flag off equals `main`'s (`486a26b84`, run in this worktree detached) in every
  metric except latency (main against the branch): p50 0.474 against 0.471 ms, p95 3.81 against 4.23 ms. That is noise between runs, so no
  latency change is claimed.
- The rank model's facts fingerprint moved: `askFacts` gained the bridge's conflicts. With the flag off they are
  empty, so no fact can move, and `rank-weights.json` takes the new fingerprint without a refit. With `bridgeQuery`
  and `askRank` both on, a bridged conflict is read as a consequence find in conflict.
- The `reviewer` subagent was not run: this session has no subagent tool. Run it before merging.

## Verdict

- **Bridge (D86): proposed, off, not for ALL3 yet.**
  - It reaches facts no other path reaches: the model, not the query shape, does the work (v2 against the no-model
    control: 30 new against 8 offline, 138 against 126 in the funnel).
  - The gain is real but concentrated: +15 to +17 hidden on dev, all in dev6a, for +5 to +6 decoys; in-sample +2
    hidden and −8 decoys.
  - It costs one model call per acting request, plausibly +15% to +110% of the agent's cost at list prices, and its
    latency on a reasoning model exceeds the lookup's wait.
  - It needs a live A/B with the agent, and a cheaper, faster non-reasoning setting, before it can be recommended.
- **Digest (D87): proposed, off, the better candidate.**
  - +16 hidden for +8 decoys on dev, with no model call and a byte-stable, cacheable prefix.
  - In-sample it adds few facts (+8) and many decoys (+33): those suites' decoys are near-miss constraints that are
    really in force, and the suites are already 91% reached.
  - Its real test is live: whether the agent's model matches a line to a request without growing more cautious
    (guided asking raised false concerns by 7.8 points, [path-to-90.md](path-to-90.md)).
  - The funnel cannot say that. It counts a digest line as reach, and the suites plant thirty facts into one world at
    once, where a real user would have one or two new ones.
  - Offline, one planted fact at a time (`digest-reach.ts`, complete cards): 120 of 240 hidden planted items are
    digest-eligible, 51 of them in the top 12; 47 decoys are eligible, 22 in the top 12. The planted items are a day
    old, so recency favours them: an upper bound.
- **Both:** the two stack (dev 54% → 66% either), and they are complementary: the bridge reaches dev6a's
  precondition facts, the digest dev6b's standing ones.

## Next

1. A live A/B on a fresh blind suite (Pi harness): ALL3 against ALL3 + digest. Then + bridge with a non-reasoning
   model, pre-registered bars on facts raised and false concerns.
2. The bridge on glm-5.3-flash: tokens, latency and cost per call measured, and `reasoning` off if the API allows it.
3. A digest relevance cut (path-to-90's hypothesis 4): the top lines by the synthetic-request index for the session's
   first request, if live shows twelve generic lines are not read.
4. The intent index (another track) as a second index for the bridge's queries, if it lands.
