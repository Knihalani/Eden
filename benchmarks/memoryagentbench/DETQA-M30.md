# Detective_QA 200k — M30 inject re-run

**Date:** 2026-09-21  
**Wave:** M30.2  
**Verdict:** **WIN** vs paper BM25 DetQA **52.1**. **WIN** vs HippoRAG **57.7**. **WIN** vs M15 lock **0.0** (+73.2 pp). Leaf also **> Claude LC DetQA 71.8** on this NIM column (disclosed; not 4o-mini). Still LOSS vs GPT-5-mini LC **76.1**. LRU avg is M30.4.  
**API under test:** `openMemory` inject (`benchmarks/memoryagentbench/inject-bridge.ts`). **Not** `BrainMemory.retrieve`. No BrainMemory column.  
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` (disclosed — not GPT-4o-mini).  
**k:** 10. **labelStrip:** false. **Length:** Detective_QA **200k** (`detective_qa`, yaml `context_max_length: 200000`, `max_test_samples: 10` contexts). Official n=**71** is QA pairs (~6–7 per context), not 71 contexts.  
**Retrieve:** M30.1 gist-then-chunk on book-length QA (`isBookQaCue` + scored hier gists then leftover BM25 chunks). Lone `Output:` on the official extract is not ICL. `_detqa_complete` unwraps JSON/fences to a short choice (output format, like ICL `label: N` → `N`). Not GraphRAG EventQA. Not k=40. `skipNarrativeComplete` on book-QA.

| | n | metric | score |
|---|---:|---|---:|
| M15 (extract packs, frozen lock) | 71 | exact_match | **0.0** |
| M15 (same run, not the published metric) | 71 | substring_exact_match | **63.4** |
| **M30 (gist-then-chunk + unwrap)** | **71** | exact_match | **73.2** |
| Paper BM25 (target) | — | exact_match | **52.1** |
| HippoRAG | — | exact_match | **57.7** |
| Claude / GPT-5-mini (LC, not this column) | — | exact_match | **71.8** / **76.1** |

- Command: `.venv/bin/python -u benchmarks/memoryagentbench/run-table3-inject.py --force-all detqa` with `NIM_READ_TIMEOUT=300` `NIM_MODEL=google/gemma-4-31b-it`
- Dataset: official clone `/tmp/MemoryAgentBench`, yaml `configs/data_conf/Long_Range_Understanding/Detective_QA.yaml` (`sub_dataset: detective_qa`, `max_test_samples: 10`, `context_max_length: 200000`). Hugging Face `ai-hyz/MemoryAgentBench`.
- Protocol: k=10, inject-bridge `openMemory` inject, NIM `google/gemma-4-31b-it`, labelStrip false, 200k, exact_match. Not BrainMemory. Not k=40. Not GraphRAG. Not 71 contexts.
- Results JSON: `/tmp/MemoryAgentBench/outputs/eden-inject-gemma-4-31b-it/Long_Range_Understanding/detective_qa_unknown_in200000_size2000_shotsunknown_max_samples10_k10_chunk4096_results.json`
- Hits: **52 / 71** exact_match. Empties: **0**. Generate: 4051s. Wall: 4143s. Mean `input_len` **4645** (packet is injecting; aborted ICL-steal probe was ~350). `leaf detqa: ok n=71 score=73.2`
- Live Table 3: DetQA **73.2** → LRU **55.1** = mean(Summ **37.0**, DetQA **73.2**). overall **44.5**. Other leaves seeded, not re-run.

Do not retune `M15-EVIDENCE.md` DetQA **0.0**. Do not GraphRAG. Do not k=40.

## Honesty

- **WIN vs paper BM25 52.1, HippoRAG 57.7, and M15 0.0 published.** GPT-5-mini 76.1 is long-context, not this inject column. Claude DetQA 71.8 is their LC cell; this column is NIM Gemma 4 31B.
- Do not score BrainMemory. Do not GraphRAG EventQA. No k=40. No LoCoMo 92. No 64k. No 71 contexts.
- `--force-all detqa` rewrote `TABLE3-RESULTS.md` but seeded other leaves from the prior file. EventQA / ICL / FC / SH / MH / Summ / LME cells stay.
- Do not compare this column to GPT-4o-mini Table 3 without naming the backbone (`google/gemma-4-31b-it`).
- NIM harness smoke worked (`pong`). 0 empty reader outputs on n=71.
- First abort (exact_match mid-30s, `input_len` ~350) was the live extract classified as ICL because of trailing `Output:`. Restarted after `isIclExemplar` required `label:` or an `input:`+`output:` pair.
