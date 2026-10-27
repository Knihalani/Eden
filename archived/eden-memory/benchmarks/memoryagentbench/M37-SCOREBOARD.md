# M37 scoreboard — official inject checkpoint

Checkpoint only. **`/memory-wave` stays.** M37 does not delete the command and does not start M38.

Live Table 3 is `benchmarks/memoryagentbench/TABLE3-RESULTS.md` (2026-09-24). LME-V2 Small n=451 acc **1.8% LOSS**. Terminal-Bench 2.1 locked subset k=5 inject Δ **−10.0 pp** (30.0%→20.0%). Do not copy M15 overall **30.0** into this checkpoint. Do not invent 4o-mini cells.

## Under test

| Knob | Value |
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

No 4o-mini cells. No k=40. No EventQA-64k. No label-strip. No LoCoMo 92.

## Table 3 (live)

Source: `TABLE3-RESULTS.md` 2026-09-24. NIM `google/gemma-4-31b-it`. k=10.

| Competency | Score | Formula |
|---|---:|---|
| AR | 57.3 | mean(SH 65.0, MH 45.0, MAB-LME 52.3, EventQA 67.0) |
| TTL | 34.6 | mean(MCC 53.0, Recsys 16.2) |
| LRU | 53.8 | mean(Summ 31.5, DetQA 76.1) |
| SF | 33.5 | mean(FC-SH 58.0, FC-MH 9.0) |
| **overall** | **44.8** | mean(AR, TTL, LRU, SF) |

MCC (five ICL, k=10, no label strip): **53.0** = mean(72, 86, 74, 27, 6).

vs M15 inject overall **30.0** (AR 52.4 / TTL 32.4 / LRU 4.5 / SF 30.5): this column is **44.8**. Bar ≥50 is not met. Backbone is Gemma, not 4o-mini.

## Claims (Plan §9.2)

| Claim | Rule | This checkpoint |
|---|---|---|
| SOTA memory-agent (4o-mini Table 3) | Official overall **> 41.6** on the 4o-mini Table 3 protocol, four avgs published | **Not claimed.** Backbone is Gemma, not 4o-mini. 44.8 is a Gemma column. |
| Bar ≥ 50 | Only if overall **≥ 50** | **Not met** (44.8). |
| SF SOTA | Only if FC-SH **≥ 82** and FC-MH **≥ 27** | **Not claimed.** FC-SH 58.0 and FC-MH 9.0. |
| SOTA vs long-context non-reasoning | Official overall **> 49.6** (Claude) | **Not claimed** (44.8). LRU 53.8 ≥ 46 is not enough without overall. |
| Trajectory SOTA | Only if LME-V2 acc **≥ AgentRunbook-C 74.9** | **Not claimed.** Live LME-V2 n=451 acc **1.8%** LOSS vs RAG 42.8 and AgentRunbook-C 74.9. |
| SOTA CLI-agent memory | Terminal-Bench 2.1 **Δ** vs locked harness k=5 | Filed. Live Δ **−10.0 pp** (honest LOSS). Not the 89-task board. |
| LoCoMo 92 / k=40 / EventQA-64k / BrainMemory column | Forbidden | **Not claimed.** |

`TABLE3-RESULTS.md` may stamp `WIN vs HippoRAG-v2 41.6 (memory-agent row; not 4o-mini)` when overall > 41.6. That is **not** 4o-mini Table 3 SOTA.

## Pointers

- Table 3: `benchmarks/memoryagentbench/TABLE3-RESULTS.md`
- Protocol: `benchmarks/memoryagentbench/PROTOCOL.md`
- Config: `benchmarks/memoryagentbench/table3-inject.config.json`
- LME-V2: `benchmarks/lme-v2/RESULTS.md`
- Terminal-Bench 2.1 Δ: `benchmarks/terminal-bench/RESULTS.md`
- Claim rules: `docs/MEMORY-PLAN.md` §9.2
- Wave: `docs/MEMORY-WAVES.md` Wave M37 (checkpoint; command stays)
