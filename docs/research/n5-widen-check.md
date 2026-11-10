# N5: N2's "widen + check" at a cost and wait that can ship

Status: 2026-11-10, branch `claude/n5-widen-check` (from `claude/lucid-hypatia-v9wqk5` at 97b216a6, N2 and I3
merged), session N5. Decisions D525–D539. Train suites only (train1–6); heldout18 is not dumped, labelled or run.
Numbers marked **[EST]** are arithmetic or judgement; every other number comes from a command in this note. Every paid
call goes to Anthropic directly with `HAIKU_API_KEY` through the lab (D97): **Anthropic-direct lab figures**. Caps:
Anthropic $25 (ledger `.local/n5/ledger.jsonl` and the shards' ledgers), Modal $20.

## 0. Where this starts

- N2 (D510–D514): a push whose pool is widened (embedding neighbours, raw intent hits) and read by Haiku 5.5 with
  thinking at effort low ("does this item change what the agent should do for this request?") raised hidden facts
  +12.5 points live (short) and +10.9 over days, with look-alikes in the packet 418 → 195 and neutral packets
  617 → 150 at $0. Its price: $0.00115 and 5–7 s a push, +$0.98 per 1,000 tasks, +5 s wall. Without thinking the
  widening lets one look-alike in per fact.
- I3 (D500–D504): the same question with no thinking over the lexical pool: +4.0 points for +$0.11–0.13 per 1,000
  tasks and +0.8 s a task.
- **Targets (the brief's):** N2's quality or better at **≤ +$0.10 per 1,000 tasks in total** (agent + Eden, the
  days shape's steady state decides) and **≤ +0.3 s wall a task**, short and long horizon.
- **What the targets rule out before any run [EST].** A Haiku call the push waits for costs about 0.85 s at no
  thinking (I3: p50 0.89 s) and 0.82 calls a task, so any variant that calls on most pushes fails the wall target
  whatever its tokens. A variant can pass only if the push's decision needs **no model call** (the question is asked
  when the item is stored), or a call on **few** pushes (under about a third of them at no thinking, a twentieth
  with thinking), or a call the agent does not wait for. The order below follows from that.
- The base funnel on this tree (`bun run funnel --suite train --seeds 41,42,43,44 --jobs 4 -- --neutral`): hidden
  634/768, decoys 552/768, as N2's C0.

## 1. Pre-registration A: the question asked once, when the item is stored (hypothesis 4)

Written and committed before any paid call of this session.

### What a look at the pools showed ($0, before writing the prompt)

Six planted facts and their look-alikes read from seed 41's pool dump (train templates, not the held-out 40). Three
look-alikes are the fact's all-clear twin ("printing approved"). Two are a real constraint about **another person or
place** (the ramp closed at Fishbourne, not Lymington; Fatima off sick, not Bo). A label that says only "this item
states a constraint" cannot remove those; the request has to be compared with **what the constraint is about**. So
the stored answer holds that too.

### The stored answer (`n5-label.ts`, lab only at this stage)

Haiku 5.5 (`claude-haiku-5-5`), thinking adaptive at effort low (ingest is not on the agent's path), batches of at
most 12 items of a user's world, each item's title and first 900 characters (the card call's `READ_CHARS`), the items
fenced as data. No request is shown. Per item it writes:

- `act`: does this item, read by a careful assistant before acting on something it bears on, give a reason to stop,
  check first or do it another way (a limit, rule, clash, absence, deadline, hold, something already done or decided,
  a changed date, place, price or person)? An all-clear (approved, lifted, settled, called off, finished), background,
  chatter, a receipt or notice with no consequence, and bulk mail are `false`.
- for `act` items only: `about` (at most 6 short names: the specific people, organisations, places, accounts,
  things and kinds of thing the constraint applies to, **not** everyone the item mentions; a generic word for each
  specific thing, as a user would say it), `from`/`to` (the dates it holds over, when it states them), and `q` (at
  most 4 short requests a user might give that this item would change, in a user's words).

One label per item content (title and text hash), kept in a JSONL cache and replayed at $0.

### The push's rule (trial `pushActs`, D525; no model call on the push)

With `pushActs` on and an `acts` dependency (the lab's label table; a product build would keep the answer on the
item's card), the push's candidates are the pool's items (and, with `pushWiden`, the widened items) that the stored
answer passes **for this request**, in pool order, the first `pushCandidates`; none passing sends no packet (N2's
H3). The pass test is a function of the request and the stored answer only (no model, no network):

- **R0:** `act`.
- **R1:** `act`, and the request agrees with what the constraint is about. Candidate forms, to be chosen by the
  fitting rule below: (a) a named entity or content word of the request appears in `about` or `q` (stemmed tokens);
  (b) when the request names a day and the answer has `from`/`to`, the day falls inside them; (c) a lexical score of
  the request against `q` above a mark.
- An item with no stored answer (not yet read) is treated as the default treats it: a lexical-pool item passes, a
  widened item does not.

### Fitting and testing (no rule is fitted on the data that tests it)

- **Fit:** seeds 41–44, the 152 train-split templates (`splitOf`, share 0.2: I1/I2's split), at $0 on the cached
  labels. The prompt may be revised **once** after reading labels of fit-split items only; a revision re-labels
  everything and is reported with both versions' figures.
- **Screen:** seeds 41–44, the 40 held-out templates, the rule frozen.
- **Confirmation:** seeds 45–48, the 40 held-out templates (fresh worlds; intent replay does not cover 45–48, so the
  intent index is inert there in every arm, as in N2).
- **Arms** (funnel, `-- --neutral`): C0 the default; A1 `pushActs` (lexical pool only); A3 `pushActs` + `pushWiden`
  with the embedding table (`pushWidenEmbed` 5, `pushWidenIntent` 6: N2 §1's values, since no call's item cap binds);
  A3i `pushActs` + `pushWiden` with **no embedding** (`pushWidenEmbed` 0: the stored requests `q` indexed and matched
  lexically; this arm needs nothing at push time that the product does not have today).
- **Label gate, read first (held-out templates, seeds 41–44):** of the planted items, `act` for ≥ 85%; of the
  decoys, R1 passes ≤ 45% for their own request (I2's effort-low Haiku with the request in hand passed 42% of
  held-out decoys). Failing the gate, the arms are still screened (it costs $0) and reported.
- **Bars (N2 §1's H1+H3 bar, each arm against C0, screen and confirmation; every clause):** planted handed ≥ C0's;
  decoy handed ≤ C0's − 10%; hidden surfaced ≥ C0's; neutral packets at least halved. Reported beside it, not a bar:
  N2's C4L on the same tasks (41–44 all templates: hidden 690, planted handed 584, decoy handed 195, neutral packets
  150; 45–48 held-out: 124 / 112 / 42 / 22).
- **Cost of the labels:** $ per item from the ledger, and per 1,000 tasks at the cost model's items per user-day
  (docs/COST-MODEL.md), reported for direct calls and **[EST]** for the Message Batches price.

## 2. Pre-registration B: what a thinking check on the push costs at its cheapest (hypotheses 1, 2, 5)

Only as a component: §0's arithmetic says a call on every gated push cannot meet the wall target. Measured on a
fixed sample (seed 41, every 4th gated push of the hidden and control tasks, widened pool as A3 reads it), Haiku 5.5:

- T0: I3's request as shipped (no thinking), the reference.
- T1: I3's request with thinking adaptive at effort low, the reply unchanged (N2 §8's first thing to measure).
- T2: T1 over only the items the stored answer passes at R0 (fewer items; the others cannot be handed).
- T3: T2 with each item cut to its constraint sentence (`about`, dates and the 200-character excerpt).

Reported per arm: $ a call, input (cached) and output tokens, p50 and p90 seconds, planted yes, decoy yes. No bar:
these figures decide whether a two-stage arm (§3) is worth a funnel screen, by the rule there.

## 3. Pre-registration C: the call made rarely or behind (hypotheses 3, 5, 6)

Screened only if §1's best arm misses N2's C4L on the screen by more than 10 planted handed or 40 decoys handed (so
there is something left for a call to buy):

- **S1 (two-stage):** §1's rule decides; one thinking call (§2's cheapest arm that keeps planted yes ≥ 90% and decoy
  yes ≤ 50% on the sample) is made only when the items R1 passes include two or more that share an `about` name and
  differ in `act`'s grounds... **in short: only when the stored answers disagree about the same subject**, and at
  most on 15% of pushes (the bound that keeps a 2 s call inside +0.3 s a task). The exact trigger is fitted on the
  fit split and frozen before the screen, as §1.
- **S2 (behind):** the push hands §1's packet at once; the call of S1 runs behind and a correction (items to add) is
  queued for the agent's next take. Live only, and only if S1's screen passes: N3 (D515) found late packets rarely
  land, so its bar is hidden not lower than S1's waiting form.

## 4. Pre-registration D: live, and the promotion rule

For the best arm that passes §1's (or §3's) screen and confirmation, and A1 beside it if it passes too:

- **Harness:** Pi on Modal (`lab_fanout.py --preset bench-tools`, the F3/I3 bench recipe: `--tenant-prompt`, payload
  notices, direct profile, Haiku 5.5 agent and grader, cards and intent replayed where covered), the Modal Secret
  `HAIKU_API_KEY`, at most two Anthropic shards at a time, from the commit that holds the arm's code.
- **Short:** train seeds 41–48, `--variants hidden,control,neutral`, all templates if the cap allows (decided by seed
  41's measured spend, as I3 §3), else the 40 held-out templates.
- **Days:** `--days 8`, users w41–w48; the stored answers and (for an embedding arm) the embedding table made for
  those users' worlds beforehand.
- **Regrade:** every hidden answer and every control or neutral concern of the paired arms by Sonnet 5.5.
- **Intervals:** the powered bench's template-clustered bootstrap (`bench_report.py --sonnet`); for days also
  clustered by user (D519: day-level task intervals are too narrow).
- **Cost:** `pi-cost-report.ts` on connector-plan pricing, agent + Eden + background, steady state, 1:1:8; the
  stored answers' calls counted as background at their measured $ per item (direct price; batch price beside it).
- **Promotion rule (the brief's):** into `DEFAULT_CONFIG` only if hidden is better (short: the clustered interval
  above zero), Sonnet-confirmed concerns are not up, total $ per 1,000 tasks rises by at most $0.10 (days, steady
  state) and wall by at most 0.3 s a task (both shapes), **and** everything the arm needs at push time exists in the
  product (an arm that needs an embedding of the request has no shipped embedder: it can be recommended, not
  promoted, by this session). Otherwise the best arm stays an off trial and the trade (facts per dollar, per second)
  goes to the owner.

No arm, seed, split, bar or rule above changes after its first paid call; anything added later is labelled as an
addendum written before its own run.
