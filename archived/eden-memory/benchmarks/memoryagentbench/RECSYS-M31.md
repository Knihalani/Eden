# Recsys_redial_full 1.44M — M31 inject re-run

**Date:** 2026-09-21  
**Wave:** M31.2  
**Verdict:** **WIN** vs M15 lock **13.7** (+2.0 pp). **WIN** vs HippoRAG Rec **10.2** (store-all, not a 10.2 costume). **LOSS** vs TE3-L **16.2**. Recsys is still TTL drag; do not claim Recsys SOTA.  
**API under test:** `openMemory` inject (`benchmarks/memoryagentbench/inject-bridge.ts`). **Not** `BrainMemory.retrieve`. No BrainMemory column.  
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` (disclosed — not GPT-4o-mini).  
**k:** 10. **labelStrip:** false. **Length:** Recsys **1.44M** (`recsys_redial_full`, yaml `context_max_length: 1480000`, `max_test_samples: 1` context). Official n=**200** queries. **metric:** `recsys_recall@5`.  
**Encode:** M31.1 recsys shots are store-all narrative atoms (`isRecsysShot` → `encodeLane` narrative + `recsys` tag). Numbered `Title (YYYY)` lists skip `extractDurable` / SemanticStore. ICL still wins over recsys. No GraphRAG. No k=40.

| | n | metric | score |
|---|---:|---|---:|
| M15 (extract tax, frozen lock) | 200 | recsys_recall@5 | **13.7** |
| **M31 (store-all recsys atoms)** | **200** | recsys_recall@5 | **15.7** |
| HippoRAG-v2 | — | Rec | **10.2** |
| TE3-L (embedder, not this column) | — | Rec | **16.2** |

- Command: `.venv/bin/python -u benchmarks/memoryagentbench/run-table3-inject.py --force-all recsys` with `NIM_MODEL=google/gemma-4-31b-it`. Wall **4574s**. NIM harness smoke timed out (`APITimeoutError`); the reader still answered every query (**0 empty**).
- Dataset: official clone `/tmp/MemoryAgentBench`, yaml `configs/data_conf/Test_Time_Learning/Recsys/Recsys_redial_full.yaml` (restored from HUST-AI-HYZ when the clone dir was empty). Hugging Face `ai-hyz/MemoryAgentBench`.
- Protocol: k=10, inject-bridge `openMemory` inject, NIM `google/gemma-4-31b-it`, labelStrip false, 1.44M / 1480000, recsys_recall@5, n=200. Not BrainMemory. Not k=40.
- Results JSON: `/tmp/MemoryAgentBench/outputs/eden-inject-gemma-4-31b-it/Test_Time_Learning/recsys_redial_full_unknown_in1480000_size300_shots0_max_samples1_k10_chunk4096_results.json`
- Hits: recall@5 **15.666…** published **15.7**. recall@1 **6.1**, recall@10 **23.7**. Empties: **0**. Mean `input_len` **5558** (M15 was **2352** — packet is injecting more; store-all chunks, not extract packs). First-query `memory_construction_time` **59.6s**; later queries ~0.85s mean (one flush).
- Live Table 3: Recsys **15.7** → TTL **34.6** = mean(MCC **53.6**, Recsys **15.7**). overall **44.8**. Other leaves seeded, not re-run. See `TABLE3-RESULTS.md`.

Do not retune `M15-EVIDENCE.md` Recsys **13.7**. Do not claim Recsys SOTA. HippoRAG 10.2 is beaten because the lane is store-all, not because we copied a recsys profile.

## Honesty

- **WIN vs M15 13.7 and HippoRAG 10.2. LOSS vs TE3-L 16.2.** Memory is not a recsys; TTL still averages MCC.
- NIM smoke failed timeout on this run; n=200 answers were still non-empty. Backbone remains `google/gemma-4-31b-it`.
- Do not score BrainMemory. No k=40. No label-strip. No GraphRAG EventQA. No LoCoMo 92. No 64k.
- `--force-all recsys` rewrote `TABLE3-RESULTS.md` but seeded other leaves from the prior file. EventQA / ICL / FC / SH / MH / Summ / DetQA / LME cells stay.
- Do not compare this column to GPT-4o-mini Table 3 without naming the backbone (`google/gemma-4-31b-it`).
