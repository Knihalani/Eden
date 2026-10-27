# MCC (five ICL leaves) — M19 inject re-run

**Date:** 2026-09-20  
**Wave:** M19.3  
**Verdict:** **LOSS** vs Qwen3-Emb **78.0** and BM25 **75.4**. **WIN** vs M15 freeze MCC **51.2** → **53.6**. TREC-F **6** is published LOSS (graveyard). Clinic **83** is not a collapse (M15 **87**; Mem0 was 32.4).  
**API under test:** `openMemory` inject (`benchmarks/memoryagentbench/inject-bridge.ts`). **Not** `BrainMemory.retrieve`. No BrainMemory column.  
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` (disclosed — not GPT-4o-mini; ignore shell `NIM_MODEL=z-ai/glm-5.3`).  
**k:** 10. **labelStrip:** false. **Length:** official ICL **~103k**.  
**Retrieve:** ICL atoms / index at k=10. No k=40. No graph. No extract. Output format `label: N` → `N` is **not** strip.

| | n | banking (`icl_banking`) | clinic (`icl_clinic`) | nlu (`icl_nlu`) | TREC-C (`icl_trec_coarse`) | TREC-F (`icl_trec_fine`) | MCC avg |
|---|---:|---:|---:|---:|---:|---:|---:|
| M15 (frozen lock) | 100 | **67** | **87** | **70** | **25** | **7** | **51.2** |
| **M19 (ICL index k=10)** | 100 | **71** | **83** | **75** | **33** | **6** | **53.6** |
| Qwen3-Emb (first target) | — | **90** | **88** | **86** | **67** | **59** | **78.0** |
| BM25 (next target) | — | **89** | **89** | **84** | **62** | **53** | **75.4** |

- Command (repo root): `.venv/bin/python -u benchmarks/memoryagentbench/run-table3-inject.py --force-all icl_banking icl_clinic icl_nlu icl_trec_coarse icl_trec_fine` then TREC resume `--force-all icl_trec_coarse icl_trec_fine` after a NIM outage emptied TREC-C q45–99 and all of TREC-F. Discarded outage scores (17 / 0) are **not** this row.
- Dataset: official clone `/tmp/MemoryAgentBench`, yamls under `configs/data_conf/Test_Time_Learning/ICL/` (ICL_banking77, ICL_clinic150, ICL_nlu, ICL_trec_coarse, ICL_trec_fine).
- Protocol: k=10, ~103k, no label-strip, `openMemory` inject, NIM `google/gemma-4-31b-it` disclosed.
- Hits: banking 71/100, clinic 83/100, nlu 75/100, TREC-C 33/100, TREC-F 6/100. All five n=100, **0 empty** reader answers on the published files.
- Live Table 3: EventQA **64** / FC-SH **54** kept. TTL **33.6** (was 32.4). overall **30.8** (was 30.0).
- NIM smoke on the TREC resume timed out; the reader still answered every TREC query.

Do not retune `M15-EVIDENCE.md` ICL cells (67 / 87 / 70 / 25 / 7, MCC 51.2). Do not treat 53.6 as SOTA.

## Honesty

- **TREC-F 6 is published LOSS** (M15 graveyard was 7; BM25 target 53). Publishing LOSS is the close, not a silent strip.
- **Clinic 87 → 83 (−4 pp)** is a small drop, not a collapse, and was **not** sacrificed for EventQA (EventQA stayed 64). Banking **67 → 71**.
- First TREC pass hit `APIConnectionError` and scored empty answers. Those files were archived; this table is the resumed TREC-C (keep 45 real + 55 re-run) and full TREC-F re-run, 0 empties.
- No k=40 as MCC. No BrainMemory product column. No `label:` strip on stored shots.
- Output `label: N` → `N` is format normalize, **not** strip.
- Do not compare this column to GPT-4o-mini Table 7 without naming the backbone (`google/gemma-4-31b-it`).

**Verdict:** LOSS vs Qwen3-Emb / BM25; WIN vs M15 MCC 51.2; TREC-F published.
