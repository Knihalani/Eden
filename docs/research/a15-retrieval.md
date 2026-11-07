# A15: finding the facts a request needs but does not name

Status: 2026-11-07, branch `claude/a15-moonshot-retrieval` (from `claude/lucid-hypatia-v9wqk5` at `598bd6ebe`), a
moonshot session. Decisions D330–D333. Every paid call went to the Anthropic API with `HAIKU_API_KEY`
(`claude-haiku-5-5` as agent, grader and card model; `claude-sonnet-5-5` only to regrade concerns) through the lab
provider (D97), `OPENROUTER_API_KEY` unset, on one ledger (`.local/a15/ledger.jsonl`) with a hard cap of $2.5:
**Anthropic-direct lab figures**. Train only (seeds 41–42); no held-out suite was run. **Spent: $1.392**
(`packages/sim/lab/a15/spend.txt`). Numbers marked **[EST]** are arithmetic or judgement; every other number comes from
a command in this note.

## In plain words

- **The question.** Of 384 hidden facts on train, the default never puts 79 in front of the agent, and 50 of those are
  in no candidate pool at all, mostly because they share no word with the request: "Transfer the £8,000 for the car to
  Riverside Motors" against a friend's "don't send them anything yet, there's outstanding finance on the Audi"; "a
  morning flight from London City on 18 November" against "LCY closed 14–22 November". The goal was to reach them at
  about $0 a request.
- **Nine ideas screened at $0, one built and measured live, none kept.** Every way to reach more of these facts
  reached about as many look-alikes (the control worlds' near-misses), because a look-alike is the planted fact's twin
  by construction: same topic, same words, a different status, date or person. The best no-model, no-dependency
  version (two extra push slots: the best intent hit at a looser bar, and the best item whose stated dates cover a day
  the request names) put the planted fact in the funnel's packet 7 more times in 384 and the look-alike 7 more times.
- **Built and measured live, then deleted: trial `pushReach` (D330).** On Pi with payload notices, over short,
  targeted and `--days 8` runs: **hidden facts raised −2.6 points (−8.9..+3.1, n 191), Sonnet-regraded concerns −0.4
  (−1.1..+0.4), cost level** (+$0.005 per 1,000 tasks on the short mix, −0.015..+0.024; +$0.002 over a user's days,
  −0.006..+0.009; connector calls unchanged). The slots did reach the agent: the planted item was in the packet more
  often (short 106 → 112 of 144, targeted 13 → 20 of 24). The agent raised it less often once there: **86% of in-packet
  planted facts raised without the slots, 79% with them** (113/132 against 114/145). More items, thinner attention; and
  a fact that shares no word with the request is also one the agent has to make the leap for.
- **One side finding that matters for every intent lever (D332).** Asking the card model again for the same items'
  requests, with the same prompt, moved 19 hidden tasks up and 25 down in the funnel (305 → 299). One sample of
  requests is a noisy thing: a funnel delta under about 20 tasks from anything touching the intent index is inside one
  re-draw. The union of two samples reached 316 hidden and 279 look-alikes (from 305/267): more phrasings help, at
  the same one-for-one exchange, for a second card call's worth of output. Asking for more phrasings in one call made
  it worse (8 asked: 286/277).
- **What this says.** At $0 a request, retrieval cannot tell a fact from its look-alike, and on this lab's agent a
  packet gain of a few tasks in a hundred does not become a raised fact (A2 found the same with a re-rank, D266). The
  facts still missed need someone to read the request's meaning against the item's; since D237 that is the agent. The
  cheapest remaining lever is the agent's own `ask_context`, whose questions are in its words, not the user's.

## 1. Where the 79 go

`bun run funnel --jobs 4 --json base.json -- --pool-dump … --corpus-dump … --ask-diag …` (the default, reader stub,
intent replayed): hidden surfaced 305/384, decoys 267/384, planted in the packet 253, decoy in the packet 219 (A2's
figures, reproduced). Of the 79 hidden never surfaced: 29 are in the push's pool past the first five, 33 in a pool
without the planted item, 17 with no pool (no pushed candidates). What links the 50 not pooled to their request,
read by hand from the dump (`misses.txt`; one template can count twice):

| Link | Templates | Examples |
| --- | --- | --- |
| A kind of thing only (category) | about 14 | car ↔ the Audi; broadband ↔ a full-fibre order; "top up the dinner account" ↔ free school meals; "remove their access" ↔ an offboarding ticket; an exhibitor package ↔ "discretionary spend (conferences) frozen" |
| A day inside a span the item states | about 9 | 29 October ↔ away 28 October to 9 November; 18 November ↔ closed 14–22 November; Sunday 8 November ↔ "Sun 08 Nov" |
| A place or code alias (world knowledge) | about 7 | London City ↔ LCY; Porto ↔ OPO; Entebbe ↔ Uganda; New York ↔ the US; Toronto, Dubai ↔ "outside the UK" |
| A nickname | 2 | Jen ↔ Jennifer Walsh; Dan ↔ Daniel Cohen |
| An amount over a stated threshold | 3 | £1,180 ↔ "over £1k needs sign-off"; £18,400 ↔ "over £10,000"; four A100s ↔ "$2k/month" |
| World knowledge only | 1–2 | a Eurostar to Paris ↔ the passport is away |

The look-alikes in control worlds share the same link and differ in the detail the request turns on ("HPI all clear",
"pre-approval came through", "the schedule change was withdrawn", Southend closed instead of LCY, a swap the week of 9
November instead of tomorrow).

## 2. The ideas and their $0 screens

Two instruments. **Offline** (`packages/sim/lab/a15/run_screen.py` over the corpus and pool dumps): each retriever
adds its first k items the push did not hand, as an extra packet slot would; counted are the 79 never-surfaced hidden
tasks it reaches and the 117 never-surfaced decoys it brings. **Funnel**: the engine itself, `bun run funnel` with the
lever on. Full output: `packages/sim/lab/a15/funnel-screen.txt`.

| # | Idea (the brief's letter) | Screen | Never-surfaced hidden reached / decoys brought | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Plain BM25 extra slot (control) | offline, k 1 | 4 / 11 | — |
| 2 | **(a) Name-free ("general") requests** at ingest: up to 2 more per item saying only the kind of action and thing ("pay a plumber for a callout") | paid sample ($0.20), funnel and offline | in the index: hidden 298 against 299 for the same sample without them; as their own slot, 4 / 0–1 | not built: too general to rank the planted item first (12 of 384 in top 1) |
| 3 | **(a) More phrasings in the same call** ("up to 8", "6 to 8" requests) | paid samples ($0.41), funnel | hidden 290 and 286, decoys 280 and 277 (against 305/267); the model wrote 3.3 and 4.0 requests an item | not built: worse |
| 4 | **(a) Two independent samples, merged** (shipped + one fresh) | funnel | hidden 316, decoys 279 | not built (D332): one-for-one, a second call's output at ingest |
| 5 | **(b) Date window**: the best lexical match whose stated span covers a request's day | offline, k 1 | 5 / 3 | built inside 9 |
| 6 | **(c) Local embedding** (all-MiniLM-L6-v2) as an extra slot | offline, k 1 | 8 / 14 (A2's 8 / 14 reproduced) | not built |
| 7 | **(c) Embedding, only when a date constraint also matches** | offline, k 1 | 7 / 4 | not built: the gate kills decoys, but it is 2 facts over idea 5 for a model dependency (D22) |
| 8 | **Re-rank the pool by the items' requests** (reciprocal rank with the pool order) | offline | +4 net planted in the first five with the shipped requests; **−28 net** when pools and re-rank use a fresh sample | not built: not robust to the request sample |
| 9 | **Intent hit at a looser bar** (two request terms, any coverage) + date window: two push slots | offline k 2: 16 / 10; funnel (the engine): **hidden 305 → 312, decoys 267 → 274** (+7 −0 each) | | **built (D330), live below** |
| 10 | (d) Aliases from the user's vocabulary | on paper | at most 2 of 384 (the nicknames); the place aliases need a world gazetteer, not the user's words | not built |
| 11 | (e) Constraint ledger matched by slot (who, what, when, limit) | on paper | the when-slot is idea 5; the limit-slot fits 3 of 384; cards hold slots for the carded items only (37% of planted items in packets, D286) | not built |

Stacking 4 and 9 in the funnel: hidden 324, decoys 288. Every lever here trades about one look-alike per fact.

Offline and engine differ for idea 9 (16 offline, 7 in the funnel): the engine's intent index stems and scores the
whole request, some requests are not yet written when the task arrives (A2's timing artefact), and the slots run only
when the push hands candidates (17 never-surfaced tasks have none; running the slots there too gave the same 312/274).

## 3. Live: `pushReach` on Pi

`packages/sim/lab/a15/run.sh LABEL payload eden,eden+pushReach …` (A2's harness: Haiku agent and grader, card model
replayed, direct connector profile, payload notices, time scale 1), both arms in one process, paired by task; pooled
with `cl8/pooled.py`, concerns regraded by Sonnet (`regrade.ts --only-concerns`, 19 answers over the six runs; in the short runs the two
neutral concerns only the trial arm had were grader errors).

| Runs | n hidden | Hidden raised (points) | Concerns, regraded (points) | $/1k mix | Wall, mix (s) |
| --- | --- | --- | --- | --- | --- |
| short, seeds 41–42, `--limit 12`, hidden/control/neutral | 144 | −1.4 (−7.6..+4.9) | −0.3 (−1.0..+0.0) | +0.005 (−0.015..+0.024) | −0.030 (−0.203..+0.146) |
| targeted (the 12 templates whose planted item or decoy the slots reached in the funnel), seeds 41–42 | 24 | +0.0 (−25.0..+20.8) | +0.0 | — | — |
| long, `--days 8`, users 41–42 | 23 | −13.0 (−26.1..+0.0) | −0.5 (−2.4..+1.0) | +0.002 (−0.006..+0.009) | −0.050 (−0.110..+0.009) |
| **all six** | **191** | **−2.6 (−8.9..+3.1)** | **−0.4 (−1.1..+0.4)** | | |

Where the planted item reached the agent (`a2/uptake.py`; raised of those in the packet):

| | default | `pushReach` |
| --- | --- | --- |
| short, 144 hidden | 88 of 106 in the packet | 90 of 112 |
| targeted, 24 | 12 of 13 | 14 of 20 |
| long, 23 | 13 of 13 | 10 of 13 |

Eden's critical path rose 1.1 ms on the short mix (+0.5..+1.8, the deeper search). Connectors priced per plan
(`pi-cost-report`, long, all-in on the mix, $ per 1,000 tasks): first-party 0.338 → 0.352, Composio 0.431 → 0.446,
Zapier MCP 8.346 → 8.360; connector calls a task 0.155 in both arms (the slots read the user's index, no source).
Tables: `short-pay-arms.txt`, `tgt-pay-arms.txt`, `long-pay-arms.txt`, `long-pay-cost.txt`, `pooled.txt`,
`uptake.txt`.

Not better on its axis, so deleted (D112): the code is in commit `1041e04d` (`reach.ts`, the slots in `partner.ts`,
`reach.test.ts`).

## 4. Decisions

- **D330** `pushReach` rejected and deleted.
- **D331** not built on $0 evidence: name-free requests, more requests in one call, the pool re-ranked by requests, a
  local embedding as an extra slot (with or without a date gate), aliases and a constraint ledger (on paper).
- **D332** the intent requests are one noisy sample: a fresh draw moves about 20 hidden tasks each way in the funnel;
  the union of two draws reaches +11 hidden and +12 decoys. A lever that touches the intent index is screened over
  two request samples before it is believed.
- **D333** lab: `--corpus-dump` lists each item as its source lists it and the cache holds it, with its card key `h`;
  `packages/sim/lab/a15/` holds the offline screens.

## Next most valuable step

Not retrieval. A2 and this note both moved the planted fact into the packet and saw no more facts raised; here the
agent raised a smaller share of what it was given. Two directions follow. (1) On the agent's side of the packet: the
facts still missed are ones whose bearing needs a leap (LCY is London City; a friend's "outstanding finance" is about
the car being paid for). A packet line that states the link Eden matched on ("names 18 November, inside 14–22
November") is no model and a few bytes, and is the precomputed bearing D286 tried with cards, now with the match
itself; it needs the powered Sonnet-graded hidden benchmark A2 proposed to be seen. (2) Measurement: re-draw the intent
requests once (about $0.2 for train seeds 41–42) and keep two files, so every intent screen reports its spread.

## Reproduce

```bash
cat packages/sim/lab/cards/cards-{v2,train,train-4344}.jsonl > .local/a15/cards-all.jsonl
bun run funnel --jobs 4 --json .local/a15/base.json -- --pool-dump $PWD/.local/a15/pool.jsonl \
  --corpus-dump $PWD/.local/a15/corpus.jsonl --ask-diag $PWD/.local/a15/askdiag.jsonl
zcat packages/sim/lab/distilled/intent-v2.jsonl.gz > .local/a15/intent.jsonl
python3 -I packages/sim/lab/a15/run_screen.py corpus.jsonl base.json pool.jsonl [EMB_DIR|-] intent.jsonl  # in .local/a15
VENV/bin/python packages/sim/lab/a15/embed.py .local/a15/corpus.jsonl .local/a15/emb   # sentence-transformers, CPU
# request samples (code of the general and 8-request prompts: this note, section 2; not committed):
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cards-enrich.ts --dir .local/a15/gen --funnel train --seeds 41,42 \
  --intent --model claude-haiku-5-5 --spend-ledger .local/a15/ledger.jsonl --spend-cap 2.5 --cap 1 --concurrency 6
bun run funnel --jobs 4 --intent FILE --json OUT.json                       # each sample, and the merged files
python3 -I packages/sim/lab/a15/score.py base.json OUT.json …
git checkout 1041e04d   # the trial
bun run funnel --jobs 4 --set '{"pushReach":true}' --json .local/a15/reach.json -- --neutral
L=packages/sim/lab/a15/run.sh
$L a15-short-pay-41 payload eden,eden+pushReach --seeds 41 --variants hidden,control,neutral --limit 12 --budget 0.3
$L a15-tgt-pay-41 payload eden,eden+pushReach --seeds 41 --variants hidden,control,neutral \
  --templates $(tail -1 packages/sim/lab/a15/targeted-templates.txt) --budget 0.1
$L a15-long-pay-41 payload eden,eden+pushReach --seeds 41 --days 8 --budget 0.2                 # and 42 for each
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results R.json --graders claude-sonnet-5-5 \
  --only-concerns --spend-ledger .local/a15/ledger.jsonl --spend-cap 2.5 --out .local/a15/runs/regrade-NAME.json
python3 -I packages/sim/lab/cl8/pooled.py eden+pushReach eden .local/a15/runs/a15-{short,tgt,long}-pay-4{1,2}
```

The two prompt variants of section 2, for the record. General requests: after the default's request instructions,
"Also, for every item given requests, add up to 2 general ones in "g": the same kind of request with every name taken
out (no person, firm, product, place, code or date from the item), saying only the kind of action and the kind of
thing…", parsed after the item's own. More phrasings: "write 6 to 8 short requests" (and "up to 8") with "Vary the
wording and the kind of request across them".

## Caveats

- Train only, two seeds; the held-out suites were not run. The long runs have 23 hidden tasks.
- The offline screens approximate the engine (their own tokenizer, no request timing); the funnel row is the engine's.
- The categories of section 1 are read by hand.
- Hidden rates are Haiku-graded; only concerns were regraded.
