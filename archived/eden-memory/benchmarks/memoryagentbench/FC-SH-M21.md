# Factconsolidation_sh 262k — M21 inject re-run

**Date:** 2026-09-20  
**Wave:** M21.3  
**Verdict:** **LOSS** vs assembly paper **82**. **WIN** vs M15 lock **54**. Official n=100. Not SF SOTA (FC-MH still 7).  
**API under test:** `openMemory` inject (`benchmarks/memoryagentbench/inject-bridge.ts`). **Not** `BrainMemory.retrieve`. No BrainMemory column.  
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` (disclosed — not GPT-4o-mini; ignore shell `NIM_MODEL=z-ai/glm-5.3`).  
**k:** 10. **labelStrip:** false. **Length:** Factconsolidation_sh **262k** (not 6k).  
**Retrieve / assemble:** product `openMemory` inject. No GraphRAG. No LoCoMo 92. No k=40.

| | n | metric | score |
|---|---:|---|---:|
| M15 (frozen lock) | 100 | substring_exact_match | **54** |
| **M21 (serial assemble + SemanticStore tombstones)** | **100** | substring_exact_match | **60** |
| Assembly paper (target) | — | substring_exact_match | **82** |

- Command: `.venv/bin/python -u benchmarks/memoryagentbench/run-table3-inject.py --force-all fc_sh`
- Dataset: official clone `/tmp/MemoryAgentBench`, `configs/data_conf/Conflict_Resolution/Factconsolidation_sh_262k.yaml` (`sub_dataset: factconsolidation_sh_262k`). Thorough harness `THOROUGH_N fc_sh=100`. **Did not bump fc_mh.**
- Protocol: k=10, inject-bridge `openMemory` inject, NIM `google/gemma-4-31b-it`, labelStrip false, 262k. Not Fact 6k. Not BrainMemory.
- Results JSON: `/tmp/MemoryAgentBench/outputs/eden-inject-gemma-4-31b-it/Conflict_Resolution/factconsolidation_sh_262k_unknown_in300000_size10_shots0_max_samples100_k10_chunk4096_results.json`
- Hits: **60 / 100**. Empties: **0**. Elapsed: 4924s. `leaf fc_sh: ok n=100 score=60.0`
- Table 3: FC-SH **60** → SF **33.5** (mean 60, FC-MH 7). Other leaves unchanged (EventQA 64, MCC 53.6, FC-MH 7).

Invalid / not this cell: n=32 / 71.9 (NIM disconnect); n=8 / 87.5 (stale assemble, then skipped-query mix). Deleted those JSONs before the official n=100.

Do not retune `M15-EVIDENCE.md` FC-SH **54**. LOSS vs 82 is the close. Do not claim SF SOTA without FC-MH ≥27 (M22). Do not claim SOTA unless FC-SH ≥ 82.

## Honesty

- **LOSS vs 82 published.** WIN vs M15 **54** is a separate cell, not SOTA.
- Do not start FC-MH. Do not score BrainMemory. Do not retune extract/ranker.
- No k=40. No 6k-as-262k. No BrainMemory column. No GraphRAG. No LoCoMo 92.
- `--force-all fc_sh` rewrote `TABLE3-RESULTS.md` but seeded other leaves from the prior file. EventQA / ICL / FC-MH cells stay.
- Do not compare this column to GPT-4o-mini Table 3 without naming the backbone (`google/gemma-4-31b-it`).
- NIM harness smoke still times out at 30s; the leaf used `NIM_READ_TIMEOUT=300` and scored 100 queries with 0 empty outputs.
