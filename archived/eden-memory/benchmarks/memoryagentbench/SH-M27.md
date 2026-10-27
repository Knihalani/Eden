# SH 197k — M27 AR inject re-run

**Date:** 2026-09-21  
**Wave:** M27.2 / M27.4  
**Verdict:** **LOSS** vs paper BM25 **66** and HippoRAG **76**. **LOSS** vs M15 lock **66** (−2 pp). Unit identical-chunk BM25: **tie** (5/5 = 5/5) — stop-structure (no GraphRAG / PPR) **did not fire** on identical chunks.  
**API under test:** `openMemory` inject (`benchmarks/memoryagentbench/inject-bridge.ts`). **Not** `BrainMemory.retrieve`. No BrainMemory column.  
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` (disclosed — not GPT-4o-mini).  
**k:** 10. **labelStrip:** false. **Length:** RULER SH-QA **197k** (`ruler_qa1_197K`, yaml `context_max_length: 220000`).  
**Retrieve:** sentence-preserving ~512-token chunks (M18) + AR multi-hit fusion (`fuseArHits`: CombMNZ + 1-hop neighbor spread). No GraphRAG / OpenIE / PPR / RAPTOR / ICL index / `complete()` on this leaf.

| | n | metric | score |
|---|---:|---|---:|
| M15 (extract packs, frozen lock) | 100 | substring_exact_match | **66** |
| **M27 (512-token chunks + AR fusion)** | **100** | substring_exact_match | **64.0** |
| Paper BM25 (target) | — | substring_exact_match | **66** |
| HippoRAG-v2 | — | substring_exact_match | **76** |

- Command: `.venv/bin/python -u benchmarks/memoryagentbench/run-table3-inject.py --force-all sh` with `NIM_READ_TIMEOUT=300` `NIM_MODEL=google/gemma-4-31b-it`
- Dataset: official clone `/tmp/MemoryAgentBench`, yaml restored from HUST-AI-HYZ `configs/data_conf/Accurate_Retrieval/Ruler/QA/Ruler_qa1_197k.yaml` (`sub_dataset: ruler_qa1_197K`). Hugging Face `ai-hyz/MemoryAgentBench`.
- Protocol: k=10, inject-bridge `openMemory` inject, NIM `google/gemma-4-31b-it`, labelStrip false, 197k. Not BrainMemory. Not k=40.
- Results JSON: `/tmp/MemoryAgentBench/outputs/eden-inject-gemma-4-31b-it/Accurate_Retrieval/ruler_qa1_197K_unknown_in220000_size50_shots0_max_samples100_k10_chunk4096_results.json`
- Hits: **64 / 100**. Empties: **0**. Elapsed: 238s. `leaf sh: ok n=100 score=64.0`
- Live Table 3: SH **64** → AR **53.9** (mean 64, MH 45, LME 42.7, EventQA 64). overall **32.0**. Other leaves seeded, not re-run.

Do not retune `M15-EVIDENCE.md` SH **66**. Do not claim AR SOTA. HippoRAG 76 is still the SH bar.

## Identical-chunk BM25 (M27.4)

Date: 2026-09-21  
API: openMemory inject / retrieveNarrativeChunks. Not BrainMemory.  
Chunks: sentence-preserving ~512 tokens (M18).  
Unit gold_in_top10: BM25-only **5/5** vs fused **5/5** on the zebra-quark needle fixture.  
gold_in_packet (inject, k=10): **5/5**.  
Official SH 197k reader score: **64.0**.  
Paper BM25: 66. HippoRAG: 76. M15 inject: 66.  
Verdict: **WIN** (tie) vs identical-chunk BM25 on the unit fixture. **LOSS** vs paper BM25 66 on official 197k.  
If LOSS vs identical-chunk BM25: stop structure (no GraphRAG / PPR). **Did not fire on the unit.** Do not add GraphRAG / PPR.

### Fixture (no NIM)

- File: `src/memory-ar-bm25.test.ts`
- Needle: `The special magic number of zebra-quark-17 is 48291.`
- Filler: miller/river prose, ~20 × 512-token chunks via `chunkText` / `ChunkStore.put` on `observe` (same path as product).
- Cue: `What is the special magic number of zebra-quark-17?`
- Gold: substring `48291` **and** `zebra-quark-17` in top-10 texts / inject packet.
- Bury positions: chunk index 0, 4, 9, 14, 19 (N=5 independent haystacks).
- BM25-only: `bm25Rank` on `ChunkStore.all()` texts, k=10.
- Fused: `retrieveNarrativeChunks` → BM25 pool (≤40) then `fuseArHits` down to k=10.

| Trial bury | n chunks | BM25 top-10 gold | fused top-10 gold | gold_in_packet |
|---:|---:|:---:|:---:|:---:|
| 0 | ~20 | hit | hit | hit |
| 4 | ~20 | hit | hit | hit |
| 9 | ~20 | hit | hit | hit |
| 14 | ~20 | hit | hit | hit |
| 19 | ~20 | hit | hit | hit |
| **rate** | | **5/5** | **5/5** | **5/5** |

3× `bun test src/memory-ar-bm25.test.ts`: **1 pass / 0 fail / 38 expects** each.

### §4.2

Fused AR retrieve did **not** lose to identical-chunk BM25 on this fixture (5/5 = 5/5). Official reader **64** lost to paper BM25 **66** (not the same chunker). Stop-structure trigger is fused top-10 gold rate less than BM25-only on **identical** chunks. Honest official LOSS is filed. Do not invent GraphRAG / OpenIE / PPR / RAPTOR to close a 2 pp paper gap. HippoRAG **76** is still the SH target (M28 hops stay out of ICL).

## Honesty

- **LOSS vs paper BM25 66 and HippoRAG 76 published.** M15 **66** is extract packs, not this cell.
- Do not score BrainMemory. Do not retune extract/ranker from this leaf.
- No k=40. No GraphRAG EventQA. No ICL index on SH retrieve. No LoCoMo 92.
- `--force-all sh` rewrote `TABLE3-RESULTS.md` but seeded other leaves from the prior file. EventQA / ICL / FC / MH cells stay.
- Do not compare this column to GPT-4o-mini Table 3 without naming the backbone (`google/gemma-4-31b-it`).
- NIM harness smoke worked (`pong`). 0 empty reader outputs on n=100.
