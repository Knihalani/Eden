# M3: would embeddings find what Eden's lexical pool misses?

Status: 2026-11-10, branch `claude/m3-embed-screen` (from `claude/lucid-hypatia-v9wqk5`), session M3. Decisions
D450–D454. An offline screen: **$0 Anthropic**, Modal GPU only (cap $20). Train suites only (train1–6, seeds 41–42);
no held-out suite was dumped or embedded. Numbers marked **[EST]** are arithmetic or judgement; every other number
comes from a command in this note.

## In plain words

(Filled in after the run; see §5.)

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

(Filled in after the run.)

## 3. The hybrid against the bar (step 4)

(Filled in after the run.)

## 4. Cost

(Filled in after the run.)
