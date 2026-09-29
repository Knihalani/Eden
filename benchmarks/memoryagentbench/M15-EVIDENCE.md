# M15 evidence lock

**Date:** 2026-09-19  
**Wave:** M16.1 freeze of M15 (closed 2026-09-19). Not a product claim — claims wait for **M37**.  
**Verdict:** **LOSS** (honest).  
**API under test:** `openMemory` inject / hook `memoryHookResponse`. **Not** `BrainMemory.retrieve`. No BrainMemory product column.  
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` (**disclosed, not 4o-mini**).  
**Protocol:** matches `PROTOCOL.md` — k=10, official lengths EventQA **534k** / FC **262k** / SH **197k** / MH **421k**, **no** `label:` strip.  
**overall** = mean of AR / TTL / LRU / SF. A later RESULTS that claims Table 3 overall without those four competency avgs is CI-fail. Missing leaves = the word `missing`, not 0.

Copied from this run’s RESULTS (`TABLE3-RESULTS.md`, `benchmarks/lme-v2/RESULTS.md`, `benchmarks/terminal-bench/RESULTS.md`) and the M15 evidence lock table in `docs/MEMORY-WAVES.md`. Do not invent 4o-mini cells.

| Leaf / exam | n | Product score | What it means | Mechanism that must change |
|---|---:|---:|---|---|
| FC-SH 262k | 100 | **54** | Tied HippoRAG-v2 54. Single-hop overwrite works at k=10. Not SF SOTA (82). | Richer candidates + `max(serial)` that **drops** losers (M20–M21). M8 copula `max(t)` is not enough. |
| FC-MH 262k | 100 | **7** | Field floor (HippoRAG 5, Zep 3). Packet does not assemble hops. | Per-hop retrieve, last hop first (M22). `complete()` on `#entity` is not CAR. |
| EventQA 534k | 100 | **56** | Loss to BM25 74.6 on the same official length. | Store-all 512-token chunks. **Stop** `extractDurable` on novels (M17–M18). |
| ICL banking | 100 | **67** | Working k=10 TTL. HippoRAG MCC avg 61.4; BM25 75.4. | Atomic exemplars, no extract, no graph. Protect this lane (M19). |
| ICL clinic | 100 | **87** | Strong. Do not Mem0-extract labels. | Same ICL index. Regression if extract returns. |
| ICL nlu | 100 | **70** | Finished. TREC-F is the MCC graveyard. | Diversity at k=10, still no `label:` strip. |
| ICL TREC-C | 100 | **25** | Weak coarse labels at k=10. | M19 atomic exemplars. |
| ICL TREC-F | 100 | **7** | Graveyard. | M19. Do not strip `label:`. |
| SH 197k | 100 | **66** | Tied BM25 66; HippoRAG 76. | Store-all chunks (M18) + associative extras that must not touch ICL (M27). |
| MH 421k | 100 | **45** | Below HippoRAG. | Same as SH; do not k=40. |
| LME (Table 3) | 300 | **42.7** | NIM yes/no judge, not gpt-4o. Not LME-S* 500. | Files + silent slice (M23–M26). |
| Recsys | 200 | **13.7** | TTL drag vs MCC 51.2. | Test-time learning, not a bigger k. |
| DetQA | 71 | **0.0** | Honest exact_match floor (scored 0, **not** a missing leaf). | Long-range understanding (M30–M31). |
| Summ | 100 | **9.0** | NIM yes/no, not gpt-4o HELMET. | Same LRU wave. |
| LME-V2 Small | 451 | **2.7%** | Cap 2000 + extract on truncated text; official ~25M haystack not ingested. RAG 42.8 / AgentRunbook-C 74.9 are not like-for-like. | Trajectory **files** + silent slice inject (M23–M26). Not a bigger BM25 k. |
| Table 3 SF | — | **30.5** | Complete competency. HippoRAG SF 29.5. | Hold while M21–M22 push toward 54+. |
| Table 3 AR | — | **52.4** | mean(SH 66, MH 45, LME 42.7, EventQA 56). | M18/M27 narrative; do not retune ICL. |
| Table 3 TTL | — | **32.4** | mean(MCC 51.2, Recsys 13.7). | M19 ICL protect; Recsys later. |
| Table 3 LRU | — | **4.5** | mean(Summ 9.0, DetQA 0.0). | M30–M31. |
| Table 3 overall | — | **30.0** | mean(AR, TTL, LRU, SF). LOSS vs HippoRAG-v2 41.6. Backbone is NIM Gemma 4 31B, **not** 4o-mini. | Claims wait for M37. |
| TB 2.1 Δ | 2 tasks × k=5 | **−20.0 pp** | Harbor mean on 10.0% vs off 30.0%. Locked subset, not 89-task board. On-arm 9/10 errored (tmux / BadGateway) — infrastructure, not a memory win. Token Δ is mostly zero-token failures. | M32. |

This run has no missing Table 3 leaves. If a later freeze omits a leaf, write `missing` in Product score — never `0` (DetQA **0.0** above is a scored floor).

**Hard splits (violating these is how M8 “assembly” still scored FC-MH 7):**

1. ICL index is never called from AR hops or SF assembly. (`icl` ⟂ AR hops ⟂ SF assemble ⟂ ExperienceStore)
2. Narrative chunks are never run through `extractDurable`. (no extractDurable on novels)
3. Facts that overwrite are assembled in **code**, not by asking Gemma which sentence is newer. (code `max(serial)`)
4. Trajectories are files (plus notes/events). Chat JSONL cap 2000 is not the LME store.
5. Still **silent inject**. No `memory_search`. Fail-open. k=10 on Table 3. No label-strip. No BrainMemory column.

**Locks (not this exam):** LoCoMo 92, k=40 as MCC, EventQA-64k, Memorable 454/454, FC-6k.

**Sources:** `docs/MEMORY-WAVES.md` M15 evidence lock; `benchmarks/memoryagentbench/TABLE3-RESULTS.md`; `benchmarks/lme-v2/RESULTS.md` (n=451 acc 2.7% LOSS); `benchmarks/terminal-bench/RESULTS.md` (Δ −20.0 pp Harbor 2-task subset); `benchmarks/memoryagentbench/PROTOCOL.md`.
