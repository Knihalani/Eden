# M3: would embeddings find what Eden's lexical pool misses?

Status: 2026-11-10, branch `claude/m3-embed-screen` (from `claude/lucid-hypatia-v9wqk5`), session M3. Decisions
D450–D453. An offline screen: **$0 Anthropic**, Modal GPU only (cap $20). Train suites only (train1–6, seeds 41–42);
no held-out suite was dumped or embedded. Numbers marked **[EST]** are arithmetic or judgement; every other number
comes from a command in this note.

## In plain words

- **The question.** Eden finds candidates by words (a lexical pool). Facts that share no word with the request often
  never reach it. Would a modern embedding model, which matches meaning rather than words, bring those facts in, and
  would it bring in the look-alikes (decoys) as well?
- **What was done.** Every item of the 24 train worlds (train1–6, seeds 41–42; 3,541 unique texts) and every request
  (768) embedded on a Modal L4 with Qwen3-Embedding-0.6B (the primary), Qwen3-Embedding-4B, and all-MiniLM-L6-v2 (A15's
  CPU model, for comparison). For each task, the planted item's rank by embedding against its place in Eden's pool, then
  a hybrid (the pool fused with the embedding's top 3, 5 or 10) against a bar fixed before it was computed (§1).
- **Answer: no.** The embedding does find facts the pool misses, but it finds the decoys just as often. With the
  primary model at k 3 the hybrid puts **42 more planted facts** (net, of 384) in the first five candidates and **48
  more decoys** (of 384). The bar asked for ≥ +10 facts at ≤ +3 decoys; every model and every k misses it by about 45
  decoys. 41 of the 56 facts gained come with their own decoy gained on the same task's control world: the embedding
  sees a fact and its look-alike as the same thing, which is what a look-alike is built to be.
- **The target set (facts sharing no word with the request) barely moves:** net +2 facts (0.6B, k 3) or +5 (4B), on
  65 tasks, with decoys −1 to +4 on 53. The facts A15 could not reach are not reached here either: they need a leap
  (car → Audi, London City → LCY) that similarity of meaning does not make often enough.
- **No engine trial (D450).** A bigger model (4B, 7× the parameters) is no better on decoys (+48 to +51). The finding
  is A15's again with stronger models: at $0 a request, retrieval cannot tell a fact from its twin; reading the request
  against the item is the agent's job (D237). **Cost: $0.106 of Modal billed for the two Qwen runs (the MiniLM run, 7 s
  of GPU, was not yet in the billing report), $0 Anthropic.**

## 1. Pre-registration (written and committed before the hybrid was computed)

**The question.** A15 (D330–D333) found that the facts Eden's default never surfaces mostly share no word with the
request ("Transfer the £8,000 for the car" against "outstanding finance on the Audi"), and that every $0 way of
reaching them reached about one look-alike (the control worlds' near-miss decoy) per fact. A15 screened one small CPU
embedding (all-MiniLM-L6-v2) at k 1 as an extra slot: 8 facts for 14 decoys. M3 asks the same of current open
embedding models on a GPU, at more k, and as a proper hybrid with the lexical pool.

**Data.** `bun run funnel --suite train --seeds 41,42 -- --corpus-dump … --pool-dump …` (the shipped default, cards and
intent requests replayed, no model): 384 hidden tasks (one planted fact each) and 384 control tasks (one decoy each),
with each world's items as its sources list them and the push's lexical pool in order (`pushPoolAt`: the planted
item's place in it). The embedding ranks every item of the task's world by cosine similarity to the request.

**The hybrid (primary).** For each task: the lexical pool (its order, up to 15 items) fused with the embedding's top k
(k = 3, 5, 10) by reciprocal-rank fusion, score = Σ 1/(60 + rank) over the lists an item is in (ties: the lexical
order first, then the embedding's). The hybrid's first 5 are compared with the lexical pool's first 5 (the push
hands at most 5). Per variant: **gained** (planted item in the hybrid's first 5, not in the lexical first 5), **lost**
(the reverse), and **net** = gained − lost. Hidden net counts facts; control net counts decoys.

**The bar for an engine trial (fixed now).** A trial switch is justified only if, for the primary model
(Qwen3-Embedding-0.6B) **at one k in {3, 5, 10}**, **hidden net ≥ +10 and control net ≤ +3** over the 384 + 384
tasks. A larger model clearing the bar where 0.6B does not counts only with its production cost stated (it is not a
CPU model). Because three k are tried, a k clearing the bar alone with its neighbours far below it is reported as
fragile. Even a clear pass is a funnel (packet) result: A15's trial `pushReach` raised packet hits and still lost
hidden facts live (86% → 79% of in-packet facts raised), so a pass buys a live trial, not a default.

**Secondary (reported, not the bar).** The same counts on the tasks whose planted item shares no word with the request
(A15's target set); an "extra slot" shape (the lexical first 5 plus the best embedding item not already in them, as
A15 screened); and the embedding's rank of the planted item against `pushPoolAt`, by group.

## 2. Embedding ranks against the lexical pool (step 3)

The funnel run (shipped default, no model, 11 s locally) reproduces main's figures: hidden surfaced 314/384, decoys
273/384; the planted item is in the pool's first 5 on 254 hidden tasks and the decoy on 219 control tasks. Every pool
id is in the corpus dump (9,348 of 9,348). Counts of tasks whose planted item (hidden) or decoy (control) is in the
embedding's top k, the pool's first k, either, and the embedding only (`packages/sim/lab/m3/report-*.txt`):

| Model | Variant, group | n | emb top 1 | emb top 5 | pool first 5 | either at 5 | emb-only at 5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3-0.6B | hidden, all | 384 | 154 | 220 | 254 | 314 | 60 |
| Qwen3-0.6B | hidden, no shared word | 65 | 9 | 14 | 24 | 32 | 8 |
| Qwen3-0.6B | hidden, not in the pool | 101 | 34 | 46 | 0 | 46 | 46 |
| Qwen3-0.6B | hidden, never surfaced | 70 | 12 | 25 | 0 | 25 | 25 |
| Qwen3-0.6B | control, all | 384 | 164 | 216 | 219 | 288 | 69 |
| Qwen3-0.6B | control, no shared word | 53 | 1 | 3 | 8 | 11 | 3 |
| Qwen3-0.6B | control, not in the pool | 137 | 39 | 57 | 0 | 57 | 57 |
| Qwen3-0.6B | control, never surfaced | 111 | 15 | 26 | 0 | 26 | 26 |
| Qwen3-4B | hidden, all | 384 | 174 | 243 | 254 | 316 | 62 |
| Qwen3-4B | hidden, no shared word | 65 | 12 | 19 | 24 | 36 | 12 |
| Qwen3-4B | control, all | 384 | 166 | 225 | 219 | 291 | 72 |
| Qwen3-4B | control, no shared word | 53 | 2 | 8 | 8 | 14 | 6 |
| MiniLM-L6 | hidden, all | 384 | 113 | 170 | 254 | 303 | 49 |
| MiniLM-L6 | control, all | 384 | 133 | 180 | 219 | 272 | 53 |

Read: on its own the embedding is a weaker ranker than the pool at 5 (220 vs 254 facts), but it covers different
tasks (either: 314). Of the 70 facts the default never surfaces it puts 25 in its top 5; of the 111 decoys the default
never surfaces, 26. "Embedding only" is 60 facts against 69 decoys. On the no-shared-word facts, its top 1 beats the
pool's first item (9 vs 2) but not its first 5 (14 vs 24).

## 3. The hybrid against the bar (step 4)

Gained (into the first 5), lost (out of them) and net, against the lexical first 5 (254 hidden, 219 control). "Slot":
A15's shape, the lexical first 5 plus the embedding's best item not in them (6 candidates), gains only.

| Model | k | hidden +/−, net | decoys +/−, net | slot: facts / decoys | bar (≥ +10, ≤ +3) |
| --- | --- | --- | --- | --- | --- |
| **Qwen3-0.6B** | 3 | +56 −14, **+42** | +64 −16, **+48** | +45 / +49 | fails |
| **Qwen3-0.6B** | 5 | +57 −21, **+36** | +66 −20, **+46** | +45 / +49 | fails |
| **Qwen3-0.6B** | 10 | +56 −24, **+32** | +66 −18, **+48** | +45 / +49 | fails |
| Qwen3-4B | 3 | +56 −12, +44 | +63 −15, +48 | +47 / +51 | fails |
| Qwen3-4B | 5 | +59 −15, +44 | +65 −14, +51 | +47 / +51 | fails |
| Qwen3-4B | 10 | +59 −16, +43 | +66 −19, +47 | +47 / +51 | fails |
| MiniLM-L6 | 3 | +38 −14, +24 | +48 −16, +32 | +28 / +35 | fails |
| MiniLM-L6 | 5 | +48 −18, +30 | +51 −21, +30 | +28 / +35 | fails |
| MiniLM-L6 | 10 | +49 −24, +25 | +51 −24, +27 | +28 / +35 | fails |

The no-shared-word tasks (hidden n 65, control n 53), net at k 3 / 5 / 10: Qwen3-0.6B facts +2 / +1 / +1, decoys
−1 / 0 / −1; Qwen3-4B facts +5 / +5 / +5, decoys +3 / +4 / +3; MiniLM facts −2 / −2 / −3, decoys +1 / +1 / +1.

**Twins.** At k 3, of the 56 tasks whose fact the 0.6B hybrid gains, 41 also gain their decoy on the same suite, seed
and template's control world (4B: 34 of 56). The gain is the topic, not the fact.

**Against the noise.** A gain of a few tasks would sit inside D361's intent re-draw noise (43 hidden tasks moved);
these are not small, but they are matched one for one by decoys, so the noise question does not arise. A15's live
lesson (packet hits did not become raised facts) was not needed either: the screen fails before it.

**Why the bar was right to ask for decoys.** In this lab a decoy in the packet is a look-alike the agent may act on or
raise wrongly; precision over recall is the product's rule (CLAUDE.md), and any trial raising decoys one for one with
facts needs an explicit decision (D450 declines it).

## 4. Cost, and the production shape not pursued

**This screen:** `modal billing report --for today`: the 0.6B app $0.0427 (107 s of embedding on an L4 plus image build
and model download), the 4B app $0.0631 (208 s); the MiniLM run (7 s) was not yet in the report when read. $0
Anthropic. Under the $20 cap by two orders of magnitude.

**Production (not built; [EST]).** Had it cleared, the cheapest shape would have been a CPU embedding at ingest (each
item embedded once when synced, a few ms an item for a 0.6B model on a server core, roughly 10⁻⁶ dollars an item at
cloud core prices [EST]) and each request embedded on the push (one call, tens of ms on CPU [EST]), adding a model
dependency (D22) and a 1,024-float vector per item per user. With decoys rising one for one with facts, none of that
is worth paying.

## 5. Reproduce

```bash
bun run funnel --suite train --seeds 41,42 --jobs 4 --json .local/modal/embed/funnel.json \
  -- --corpus-dump .local/modal/embed/corpus.jsonl --pool-dump .local/modal/embed/pool.jsonl      # local, 11 s, $0
export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt     # behind the session proxy, with modal[api-proxy-support]==1.6.3
for m in Qwen/Qwen3-Embedding-0.6B Qwen/Qwen3-Embedding-4B sentence-transformers/all-MiniLM-L6-v2; do
  modal run packages/sim/modal/embed_screen.py --corpus .local/modal/embed/corpus.jsonl \
    --funnel .local/modal/embed/funnel.json --pools .local/modal/embed/pool.jsonl --model "$m"
done
```

Committed: the three reports (`packages/sim/lab/m3/report-q06.txt`, `report-q4b.txt`, `report-minilm.txt`; counts
only); the embeddings, ranks and dumps stay in `.local/`. The hybrid's scoring is `embed_score.hybrid` (`rrf`,
`extra_slot`), unit-tested without Modal.

## Limits

- Train only, two seeds; the embedding ranks the whole world's items, while the lexical pool sees only what the sync
  cached: the embedding is given the easier search, which makes the negative result stronger, not weaker.
- The decoys exist by construction as near twins of the facts (A15); real users' look-alikes may be fewer. That is a
  property of the lab, measured nowhere else yet.
- RRF with c 60 is one fusion; the extra-slot shape (no fusion) gives the same picture (+45 facts, +49 decoys).
