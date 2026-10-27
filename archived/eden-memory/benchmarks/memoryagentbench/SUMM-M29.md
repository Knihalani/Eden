# InfBench_sum 1.2M — M29 inject re-run

**Date:** 2026-09-21  
**Wave:** M29.2  
**Verdict:** **WIN** vs paper BM25 Summ **19**. **WIN** vs M15 lock **9.0** (+28 pp). Still LOSS vs Claude LC **52.5** / GPT-5-mini **56.3** (long-context, not this column). LRU avg is M30 (needs DetQA).  
**API under test:** `openMemory` inject (`benchmarks/memoryagentbench/inject-bridge.ts`). **Not** `BrainMemory.retrieve`. No BrainMemory column.  
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` yes/no llm_judge (disclosed — **not** GPT-4o / gpt-4o HELMET).  
**k:** 10. **labelStrip:** false. **Length:** InfBench_sum **1.2M** (`infbench_sum_eng_shots2`, yaml `context_max_length: 1200000`).  
**Retrieve:** sleep hierarchical extractive gists on summarize cues (`promoteNarrativeGists` + `retrieveGists`) + leftover BM25 chunks. Not GraphRAG EventQA. `skipNarrativeComplete` on summary cues (no 1.2M hop).

| | n | metric | score |
|---|---:|---|---:|
| M15 (extract packs, frozen lock) | 100 | llm_judge | **9.0** |
| **M29 (hier gists + inject)** | **100** | llm_judge | **37.0** |
| Paper BM25 (target) | — | llm_judge | **19** |
| HippoRAG | — | llm_judge | **14.6** |
| Claude / GPT-5-mini (LC, not this column) | — | llm_judge | **52.5** / **56.3** |

- Command: `.venv/bin/python -u benchmarks/memoryagentbench/run-table3-inject.py --force-all summ` with `NIM_READ_TIMEOUT=300` `NIM_MODEL=google/gemma-4-31b-it`
- Dataset: official clone `/tmp/MemoryAgentBench`, yaml `configs/data_conf/Long_Range_Understanding/InfBench_sum.yaml` (`sub_dataset: infbench_sum_eng_shots2`). Hugging Face `ai-hyz/MemoryAgentBench`.
- Protocol: k=10, inject-bridge `openMemory` inject, NIM `google/gemma-4-31b-it` yes/no judge (not gpt-4o), labelStrip false, 1.2M. Not BrainMemory. Not k=40. Not GraphRAG EventQA.
- Results JSON: `/tmp/MemoryAgentBench/outputs/eden-inject-gemma-4-31b-it/Long_Range_Understanding/infbench_sum_eng_shots2_unknown_in1200000_size1200_shots2_max_samples100_k10_chunk4096_results.json`
- Hits: **37 / 100** llm_judge. Empties: **0**. Generate: 8273s. Judge labeled 100/100. Wall: 8683s. `leaf summ: ok n=100 score=37.0`
- Flush examples: `stored=1566` / `2345` / `761` then one NIM summary per context. First skip-pass (46s, score 9.0) was **stale M15 JSON** — `--force` still skips `last_processed_query_id`. Live cell archived that file then re-ran.
- Live Table 3: Summ **37.0** → LRU **18.5** = mean(37.0, DetQA **0.0**). overall **35.4**. Other leaves seeded, not re-run.

Do not retune `M15-EVIDENCE.md` Summ **9.0**. Do not claim LRU SOTA vs Claude without DetQA (M30). Do not average a BM25-19 costume into a vanity overall.

## Honesty

- **WIN vs paper BM25 19 and M15 9.0 published.** Claude 52.5 / GPT-5-mini 56.3 are long-context, not this inject column.
- Do not score BrainMemory. Do not GraphRAG EventQA. No k=40. No LoCoMo 92. No fake gpt-4o judge.
- `--force-all summ` rewrote `TABLE3-RESULTS.md` but seeded other leaves from the prior file. EventQA / ICL / FC / SH / MH / LME cells stay.
- Do not compare this column to GPT-4o-mini Table 3 without naming the backbone (`google/gemma-4-31b-it`).
- NIM harness smoke worked (`pong`). 0 empty reader outputs on n=100.
