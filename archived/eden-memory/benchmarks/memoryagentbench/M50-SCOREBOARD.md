# M50.2 scoreboard — certified inject column

**Date:** 2026-09-25
**Done when:** Filed. SOTA sentences only if §9.2 holds

M50.2 **certifies** the M37 live numbers as still the official inject column. No Table 3, LME-V2, or Harbor re-run on this date (those official runs take hours).

M38–M49 were help-path: remain-silent / packet / provenance / identity. They did not retune extract/ranker for MAB leaves. Remain-silent can change Table 3: an off-cue packet the M37 inject included can now be omitted, so a re-run could move the avgs. The certified column is the pre-silence M37 run (2026-09-24 artifacts). It is not a post-silence re-run. No new bench numbers are invented here.

## Certification (protocol still matches)

Checked 2026-09-25 against `table3-inject.config.json`, `run-table3-inject.py` (`retrieve_num: 10`, `labelStrip: false`, `model: google/gemma-4-31b-it`), and the three RESULTS headers.

| Knob | Certified value |
|---|---|
| API under test | `openMemory` inject (not BrainMemory retrieve; not a BrainMemory product score) |
| Reader / backbone | NVIDIA NIM `google/gemma-4-31b-it` (disclosed — **not** GPT-4o-mini) |
| k | 10 |
| EventQA | 534k, n=100, context 0 only |
| FC | 262k |
| SH | 197k |
| MH | 421k |
| labelStrip | false |
| overall | mean of AR / TTL / LRU / SF |

No 4o-mini cells. No k=40-as-MCC. No EventQA-64k. No label-strip. No LoCoMo 92. No BrainMemory column.

## Table 3 (certified from M37)

Source: `TABLE3-RESULTS.md` 2026-09-24. NIM `google/gemma-4-31b-it`. k=10.

| Competency | Score | Formula |
|---|---:|---|
| AR | 57.3 | mean(SH 65.0, MH 45.0, MAB-LME 52.3, EventQA 67.0) |
| TTL | 34.6 | mean(MCC 53.0, Recsys 16.2) |
| LRU | 53.8 | mean(Summ 31.5, DetQA 76.1) |
| SF | 33.5 | mean(FC-SH 58.0, FC-MH 9.0) |
| **overall** | **44.8** | mean(AR, TTL, LRU, SF) |

MCC (five ICL, k=10, no label strip): **53.0** = mean(72, 86, 74, 27, 6).

## Other official columns (certified, not re-run)

| Exam | Live number | Verdict |
|---|---|---|
| LME-V2 Small | n=451 acc **1.8%** | **LOSS** vs RAG 42.8 / AgentRunbook-C 74.9 |
| Terminal-Bench 2.1 | locked subset k=5 n=2 Δ **−10.0 pp** (30.0%→20.0%) | honest **LOSS** |

Backbone on both: NVIDIA NIM `google/gemma-4-31b-it`. Do not copy M15 overall **30.0** or M15 LME **2.7%** into this file. Do not invent 4o-mini cells. Do not invent 74.9.

## Claims (Plan §9.2)

§9.2 does not hold. No SOTA sentence is claimed.

| Claim | Rule | This file |
|---|---|---|
| SOTA memory-agent (4o-mini Table 3) | Official overall **> 41.6** on the **4o-mini** protocol, four avgs published | **Not claimed.** Needs 4o-mini protocol. Backbone is Gemma. 44.8 is a Gemma column, not that sentence. |
| Bar ≥ 50 | Only if overall **≥ 50** | **Not met** (44.8). |
| SF SOTA | Only if FC-SH **≥ 82** and FC-MH **≥ 27** | **Not claimed.** FC-SH 58 / FC-MH 9. |
| SOTA vs long-context non-reasoning | Official overall **> 49.6** (Claude) | **Not claimed** (44.8). |
| Trajectory SOTA | Only if LME-V2 acc **≥ AgentRunbook-C 74.9** | **Not claimed.** 1.8% vs 74.9. |
| SOTA CLI-agent memory | Terminal-Bench 2.1 **Δ** vs locked harness k=5 | Honest **LOSS** Δ **−10.0 pp**. Not a win sentence. Not the 89-task board. |
| SOTA LoCoMo | Independent J ≥ 75; 92 only with audit | **Not claimed.** No LoCoMo 92. |
| SOTA at 1M chat scale | BEAM-1M under the paper harness | **Not claimed.** Not this file. |
| Actually helps | Next turn more correct or cheaper, or inject omitted | **Not this file.** That ledger is M50.3 `benchmarks/memory-holdout/HELP.md`. |

`TABLE3-RESULTS.md` may stamp `WIN vs HippoRAG-v2 41.6 (memory-agent row; not 4o-mini)` when overall > 41.6. That stamp is **not** 4o-mini Table 3 SOTA and is **not** repeated here as a SOTA sentence.

## Pointers

- Table 3: `benchmarks/memoryagentbench/TABLE3-RESULTS.md`
- Protocol: `benchmarks/memoryagentbench/PROTOCOL.md`
- Config: `benchmarks/memoryagentbench/table3-inject.config.json`
- LME-V2: `benchmarks/lme-v2/RESULTS.md`
- Terminal-Bench 2.1 Δ: `benchmarks/terminal-bench/RESULTS.md`
- Claim rules: `docs/MEMORY-PLAN.md` §9.2
- Help ledger (not this file): `benchmarks/memory-holdout/HELP.md`
