# MemoryAgentBench Table 3 — official protocol

Gate 0 sheet. Runners that claim **Table 3** / **MAB** / **MCC** must match this file. [arxiv:2507.05257]

API under test = `openMemory` inject / hook `memoryHookResponse`, **not** `BrainMemory.retrieve`.

## Table 3 official lengths (do not mix)

| Leaf | Official | Forbidden substitute |
|---|---|---|
| EventQA | **534k** | NOT 64k |
| FC (FactCon) | **262k** | NOT 6k |
| SH-QA | **197k** | |
| MH-QA | **421k** | |

Optional extras (same table, not mixed with the four above): LME(S*) **355k**, MCC **~103k**, Recsys **1.44M**.

**64k is FORBIDDEN** as EventQA for Table 3. Fact **6k** is FORBIDDEN as FC for Table 3.

## Protocol knobs

- k=**10** (NOT 40)
- 4o-mini reader (**GPT-4o-mini**) unless a different backbone is disclosed
- 512/4096 chunks as paper
- overall = mean of AR / TTL / LRU / SF (four competency averages), not mean of 10 leaves
- **no `label:` strip**

## Forbidden comparisons

Copied from Report §0. Do not publish or score these as Table 3 / SOTA:

- Retrieve@40 ICL vs Table 7 MCC @ k=10
- EventQA-64k vs Table 3 EventQA-534k
- Fact 6k vs Table 3 262k
- goldHit retrieve@5 vs Mem0 Cloud 92.5 J
- HCM bakeoff vs current CLS BrainMemory
- BrainMemory.retrieve vs what Claude Code sees (AgentMemory)
- Long-context GPT-5-mini 60.6 vs JSONL BM25 without saying so

## Trap benches stay traps

LoCoMo-10 is regression only (never optimize retrieve@5). Do not claim LoCoMo 92.
