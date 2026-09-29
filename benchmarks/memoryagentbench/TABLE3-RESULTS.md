# MemoryAgentBench Table 3 — product inject + NIM

**Wave:** M37.2 (official inject re-bench after M16–M36). Command `/memory-wave` stays.
**Date:** 2026-09-24
**Verdict:** WIN vs HippoRAG-v2 41.6 (memory-agent row; not 4o-mini)
**Bar ≥50:** no. **SF SOTA:** no (need FC-SH ≥82 and FC-MH ≥27). **4o-mini Table 3 SOTA:** no (backbone is `google/gemma-4-31b-it`).
**API under test:** `openMemory` inject (not BrainMemory retrieve).
**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` (disclosed — **not** GPT-4o-mini, **not** local models, **not** DeepSeek V4 Flash).
**k:** 10. **labelStrip:** false. Official lengths only (EventQA 534k, FC 262k, SH 197k, MH 421k).
**overall** = mean of AR / TTL / LRU / SF. A competency with a missing official-length leaf is FAIL/missing, not invented.

- NIM smoke: FAILED — google/gemma-4-31b-it APITimeoutError: Request timed out.
- Command: `/Users/kaiavnihalani/Downloads/Eden/.venv/bin/python run-table3-inject.py --force-all eventqa icl_banking icl_clinic icl_nlu icl_trec_coarse icl_trec_fine sh`
- Elapsed: 30207s
- Config: `benchmarks/memoryagentbench/table3-inject.config.json`

## Competency averages

| Competency | Score | Formula |
|---|---:|---|
| AR | 57.3 | mean(SH, MH, MAB-LME, EventQA) |
| TTL | 34.6 | mean(MCC, Recsys) |
| LRU | 53.8 | mean(Summ, DetQA) only if both exist; missing named not zeroed |
| SF | 33.5 | mean(FC-SH, FC-MH) |
| **overall** | **44.8** | mean(AR, TTL, LRU, SF) |

## Leaves

| Leaf | Official length | n | metric | score | status |
|---|---:|---:|---|---:|---|
| fc_sh | 262000 | 100 | substring_exact_match | 58.0 | ok |
| fc_mh | 262000 | 100 | substring_exact_match | 9.0 | ok |
| eventqa | 534000 | 100 | substring_exact_match | 67.0 | ok |
| icl_banking | 103000 | 100 | exact_match | 72.0 | ok |
| icl_clinic | 103000 | 100 | exact_match | 86.0 | ok |
| icl_nlu | 103000 | 100 | exact_match | 74.0 | ok |
| icl_trec_coarse | 103000 | 100 | exact_match | 27.0 | ok |
| icl_trec_fine | 103000 | 100 | exact_match | 6.0 | ok |
| sh | 197000 | 100 | substring_exact_match | 65.0 | ok |
| mh | 421000 | 100 | substring_exact_match | 45.0 | ok |
| lme | 355000 | 300 | llm_judge | 52.3 | ok NIM google/gemma-4-31b-it yes/no judge (not gpt-4o) |
| recsys | 1440000 | 200 | recsys_recall@5 | 16.2 | ok |
| detqa | 200000 | 71 | exact_match | 76.1 | ok |
| summ | 1200000 | 100 | llm_judge | 31.5 | ok NIM google/gemma-4-31b-it yes/no judge (not gpt-4o) |

## MCC (five ICL leaves, k=10, no label strip)

MCC avg: 53.0 (requires all five ICL leaves).

## Honesty

- Do not compare this column to GPT-4o-mini Table 3 without naming the backbone.
- Legacy `mab-bridge.ts` / `eden.py` BrainMemory numbers are **not-product**.
- LoCoMo 92, k=40, Memorable 454/454, EventQA-64k, FC-6k are not this exam.
- AR = mean(SH, MH, MAB-LME, EventQA) only; missing named not zeroed.
- LRU vs Claude 49.6 requires ≥46; else concede. Do not claim overall ≥50 without it. See `LRU-M30.md`.
