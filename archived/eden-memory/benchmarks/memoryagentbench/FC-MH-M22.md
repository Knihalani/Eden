# Factconsolidation_mh 262k — M22 inject re-run

**Date:** 2026-09-20  
**Wave:** M22.3  
**Verdict:** **LOSS** vs assembly paper **27**. **WIN** vs M15 lock **7**. Official n=100. Not SF SOTA (needs FC-SH ≥82 **and** FC-MH ≥27).  
**API under test:** `openMemory` inject (`benchmarks/memoryagentbench/inject-bridge.ts`). **Not** `BrainMemory.retrieve`. No BrainMemory column.  
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` (disclosed — not GPT-4o-mini; ignore shell `NIM_MODEL=z-ai/glm-5.3`).  
**k:** 10. **labelStrip:** false. **Length:** Factconsolidation_mh **262k** (not 6k).  
**Retrieve / assemble:** product `openMemory` inject + per-hop CAR (`src/cls/complete.ts`). Last hop first. No GraphRAG. No LoCoMo 92. No k=40.

| | n | metric | score |
|---|---:|---|---:|
| M15 (frozen lock) | 100 | substring_exact_match | **7** |
| **M22 (per-hop retrieve + last hop first)** | **100** | substring_exact_match | **12** |
| Assembly paper (target) | — | substring_exact_match | **27** |

- Command: `NIM_READ_TIMEOUT=300 .venv/bin/python -u benchmarks/memoryagentbench/run-table3-inject.py --force-all fc_mh`
- Dataset: official clone `/tmp/MemoryAgentBench`, `configs/data_conf/Conflict_Resolution/Factconsolidation_mh_262k.yaml` (`sub_dataset: factconsolidation_mh_262k`). Thorough harness `THOROUGH_N fc_mh=100`.
- Protocol: k=10, inject-bridge `openMemory` inject, NIM `google/gemma-4-31b-it`, labelStrip false, 262k. Not Fact 6k. Not BrainMemory. Not k=40.
- Results JSON: `/tmp/MemoryAgentBench/outputs/eden-inject-gemma-4-31b-it/Conflict_Resolution/factconsolidation_mh_262k_unknown_in300000_size10_shots0_max_samples100_k10_chunk4096_results.json`
- Hits: **12 / 100**. Empties: **0**. Elapsed: 1758s (ingest flush stored=18403 then 100 queries). `leaf fc_mh: ok n=100 score=12.0`
- Table 3: FC-MH **12** → SF **36.0** (mean FC-SH 60, FC-MH 12). Other leaves unchanged (EventQA 64, MCC 53.6, FC-SH 60). overall **32.1**.

Invalid / not this cell: n=1 smoke JSON (`max_samples1`); Fact 6k / 32k / 64k; BrainMemory retrieve; k=40; two aborted starts (missing `main.py`, then `agent_chunk_size` assert) that reused the frozen 7. Deleted those as official.

Do not retune `M15-EVIDENCE.md` FC-MH **7**. LOSS vs 27 is the close. Do not claim SF SOTA unless FC-SH ≥82 **and** FC-MH ≥27. Do not claim SOTA on this leaf unless FC-MH ≥ 27.

## Honesty

- **LOSS vs 27 published.** WIN vs M15 **7** is a separate cell, not SOTA.
- Packet now walks position → sport → country (and 4-hop continent when asked). Official 262k still misses most last hops — CAR is real, not 27.
- Do not score BrainMemory. Do not retune extract/ranker. Do not retune M15-EVIDENCE.md.
- No k=40. No 6k-as-262k. No BrainMemory column. No GraphRAG. No LoCoMo 92.
- `--force-all fc_mh` seeded other leaves from the prior `TABLE3-RESULTS.md`. EventQA / ICL / FC-SH cells stay.
- Do not compare this column to GPT-4o-mini Table 3 without naming the backbone (`google/gemma-4-31b-it`).
