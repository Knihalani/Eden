# MH 421k — M28 AR inject re-run

**Date:** 2026-09-21  
**Wave:** M28.2 / M28.3  
**Verdict:** **LOSS** vs paper BM25 **56** and HippoRAG **66**. **LOSS** vs M15 lock **45** (−2 pp). Unit 2-hop over ~512-token chunks: last hop Greenwich Village on inject (wrap OpenAI / Anthropic / hook). EventQA miller novels still yield **zero** triples (not GraphRAG). ICL `label:` shots stay out of the hop graph. Wiki `?` inside a chunk does not drop or steal the last hop.  
**API under test:** `openMemory` inject (`benchmarks/memoryagentbench/inject-bridge.ts`). **Not** `BrainMemory.retrieve`. No BrainMemory column.  
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` (disclosed — not GPT-4o-mini).  
**k:** 10. **labelStrip:** false. **Length:** RULER MH-QA **421k** (`ruler_qa2_421K`, yaml `context_max_length: 524288`).  
**Retrieve / hops:** sentence-preserving ~512-token chunks (M18) + CAR `hopChain`/`completeNotes` over expanded hop sentences (`src/cls/complete.ts` `expandHopRows`). Last hop first. No GraphRAG / OpenIE / PPR / RAPTOR / ICL index on this leaf.

| | n | metric | score |
|---|---:|---|---:|
| M15 (extract packs, frozen lock) | 100 | substring_exact_match | **45** |
| **M28 (512-token chunks + CAR hops)** | **100** | substring_exact_match | **43.0** |
| Paper BM25 (target) | — | substring_exact_match | **56** |
| HippoRAG | — | substring_exact_match | **66** |

- Command: `.venv/bin/python -u benchmarks/memoryagentbench/run-table3-inject.py --force-all mh` with `NIM_READ_TIMEOUT=300` `NIM_MODEL=google/gemma-4-31b-it`
- Dataset: official clone `/tmp/MemoryAgentBench`, yaml `configs/data_conf/Accurate_Retrieval/Ruler/QA/Ruler_qa2_421k.yaml` (`sub_dataset: ruler_qa2_421K`). Hugging Face `ai-hyz/MemoryAgentBench`.
- Protocol: k=10, inject-bridge `openMemory` inject, NIM `google/gemma-4-31b-it`, labelStrip false, 421k. Not BrainMemory. Not k=40. Not EventQA GraphRAG.
- Results JSON: `/tmp/MemoryAgentBench/outputs/eden-inject-gemma-4-31b-it/Accurate_Retrieval/ruler_qa2_421K_unknown_in524288_size50_shots0_max_samples100_k10_chunk4096_results.json`
- Hits: **43 / 100**. Live re-runs (not cached skip): ingest `flush stored=5505` then 100 NIM queries. First: 359s **43.0**. After hopStore/`?` sentence fix: 362s **43.0**. `leaf mh: ok n=100 score=43.0`
- Live Table 3: MH **43.0** → AR **53.4** = mean(SH **64**, MH **43**, MAB-LME **42.7**, EventQA **64**). All four leaves exist. overall **31.9**. Other leaves seeded, not re-run.

Do not retune `M15-EVIDENCE.md` MH **45**. Do not claim AR SOTA. HippoRAG 66 is still the MH bar. CAR over chunks is real on the Greenwich unit; official 421k still misses most Hotpot last hops. The `?` hopStore filter was a unit-reproduced bug; it did **not** move this official cell.

## AR avg (M28.3)

Date: 2026-09-21  
Formula: AR = mean(SH, MH, MAB-LME, EventQA) **only if all four exist**. Missing is FAIL/missing, never 0.

| Leaf | n | score |
|---|---:|---:|
| SH 197k | 100 | 64.0 |
| MH 421k | 100 | 43.0 |
| MAB-LME | 300 | 42.7 |
| EventQA 534k | 100 | 64.0 |
| **AR** | | **53.4** |

(64 + 43 + 42.7 + 64) / 4 = 53.425 → **53.4**. Published in `TABLE3-RESULTS.md`.

## Honesty

- **LOSS vs paper BM25 56 and HippoRAG 66 published.** M15 **45** is extract packs, not this cell. M28 **43.0** is −2 pp vs that lock.
- Do not score BrainMemory. Do not retune extract/ranker from this leaf.
- No k=40. No GraphRAG EventQA. No ICL index on MH hops. No LoCoMo 92.
- `--force-all mh` rewrote `TABLE3-RESULTS.md` but seeded other leaves from the prior file. EventQA / ICL / FC / SH / LME cells stay.
- Do not compare this column to GPT-4o-mini Table 3 without naming the backbone (`google/gemma-4-31b-it`).
- NIM harness smoke worked. Official yaml `context_max_length: 524288`, `sub_dataset: ruler_qa2_421K`, `max_test_samples: 100`.
