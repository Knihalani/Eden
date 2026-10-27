# LRU avg — M30 (Summ + DetQA)

**Date:** 2026-09-21  
**Wave:** M30.4  
**Report:** §7  
**API under test:** `openMemory` inject (`benchmarks/memoryagentbench/inject-bridge.ts`). **Not** `BrainMemory.retrieve`. No BrainMemory column.  
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it`.  
**k:** 10. **labelStrip:** false. Not k=40. Not GraphRAG EventQA.

## Formula

**LRU = mean(Summ, DetQA) only if both exist; missing named not zeroed.**

## Leaves

| Leaf | length | n | metric | score | note |
|---|---:|---:|---|---:|---|
| Summ (InfBench 1.2M) | 1.2M | 100 | llm_judge | **37.0** | M29 WIN vs paper BM25 **19**. See `SUMM-M29.md`. |
| DetQA (Detective_QA 200k) | 200k | 71 | exact_match | **73.2** | M30.2 WIN vs BM25 **52.1** / HippoRAG **57.7** / M15 **0.0**. See `DETQA-M30.md`. |
| **LRU** | — | — | mean(Summ, DetQA) | **55.1** | (37.0 + 73.2) / 2 = 55.1 |

Live `TABLE3-RESULTS.md`: LRU **55.1**, overall **44.5** (AR **53.4**, TTL **33.6**, SF **36.0**).

## Paper comparables (not this inject column)

| Stack | LRU | Overall | note |
|---|---:|---:|---|
| Claude LC | **62.2** | **49.6** | long-context; the SOTA-vs-Claude bar |
| GPT-5-mini LC | **66.2** | **60.6** | long-context; not a BM25 problem |
| BM25 | **35.6** | 41.5 | memory-agent row |
| HippoRAG | **36.2** | 41.6 | memory-agent row |
| **This board (NIM Gemma 4 31B)** | **55.1** | **44.5** | inject k=10 |

## Concede rule (Wave M30 · Plan §9.2)

Bar to claim vs Claude **49.6** overall: **LRU ≥ 46**.

This board: LRU **55.1 ≥ 46**. **Do not concede LRU.** Overall **44.5** is still **LOSS vs Claude 49.6** (TTL **33.6** / SF **36.0** drag). Do **not** claim overall **≥ 50**. Do **not** claim SOTA vs long-context. WIN vs HippoRAG-v2 **41.6** on this NIM column is named in TABLE3; claims vs 4o-mini Table 3 wait for M37.

## Honesty

- **Not** BrainMemory. **Not** k=40. **Not** GraphRAG EventQA.
- Do not retune `M15-EVIDENCE.md` (Summ **9.0**, DetQA **0.0**, LRU **4.5**, overall **30.0** stay the lock).
- Do not compare this column to GPT-4o-mini Table 3 without naming the backbone (`google/gemma-4-31b-it`).
