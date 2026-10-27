# EventQA 534k — M18 inject re-run

**Date:** 2026-09-19  
**Wave:** M18.3  
**Verdict:** **LOSS** vs LangChain BM25 **74.6**. **WIN** vs M15 extract packs **56**.  
**API under test:** `openMemory` inject (`benchmarks/memoryagentbench/inject-bridge.ts`). **Not** `BrainMemory.retrieve`.  
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` (disclosed — not GPT-4o-mini).  
**k:** 10. **labelStrip:** false. **Length:** EventQA **534k** (not 64k).  
**Retrieve:** sentence-preserving ~512-token chunks + Okapi BM25 (`src/chunk-store.ts`, `src/chunk-retrieve.ts`). No GraphRAG / OpenIE / PPR / RAPTOR / ICL index / `complete()` on novels.

| | n | metric | score |
|---|---:|---|---:|
| M15 (extract packs) | 100 | substring_exact_match | **56** |
| **M18 (512-token BM25 chunks)** | **100** | substring_exact_match | **64.0** |
| Paper BM25 (target) | — | substring_exact_match | **74.6** |

- Command: `.venv/bin/python -u benchmarks/memoryagentbench/run-table3-inject.py --force-all eventqa`
- Dataset: official clone `/tmp/MemoryAgentBench`, `eventqa_full`, context 0, **100** queries (same n as the M15 lock). Outer harness has 5 novels; M15 published n=100, so this freeze matches that protocol.
- Results JSON: `/tmp/MemoryAgentBench/outputs/eden-inject-gemma-4-31b-it/Accurate_Retrieval/m18-eventqa-archive/eventqa_full_n100_context0_results.json`
- Hits: 64 / 100. Live Table 3 AR **54.4** (was 52.4). overall **30.5** (was 30.0). Still LOSS vs HippoRAG-v2 41.6.
- NIM smoke timed out; the reader still answered queries (one `APIConnectionError` retry on q71).

Do not treat 64 as SOTA. Do not add GraphRAG to close the 10.6 pp BM25 gap. M15-EVIDENCE.md stays 56 / AR 52.4 / overall 30.0.
