# M26 LME-V2 Small RESULTS

**Date:** 2026-09-24
**ISO date:** 2026-09-24
**Wave:** M26.2
**M37 recert:** 2026-09-24 — live n=451 after M16–M36; trajectory SOTA only if acc ≥ 74.9
**Report:** §11.1
**Bun:** 1.3.13
**API under test:** `openMemory` inject (`src/index.ts`). Ingest = `putExperience` (AX `tree` on `{dir}/experience/*.jsonl`) + optional short observe notes (goal/outcome/url only, `omitExperienceTree`) + `mem.sleep()`. Query = `inject([{role:"user",content:question}])`. Packet = `Eden Memory:`.
**Reader:** NVIDIA NIM `google/gemma-4-31b-it` at `NVIDIA_BASE_URL` (key from gitignored `.env`, not printed). Probe: ok. Probe failure does not skip the question loop.
**k:** product default 6 (`EDEN_MEMORY_CAP`). **JSONL store cap:** product default 2000 (`EDEN_MEMORY_STORE_CAP`) — not raised as a fake haystack.
**Experience disk cap:** `EDEN_EXPERIENCE_BYTES` (this runner sets 268435456 bytes if unset/tight; default 32MiB may evict 200 traj files).
**Chat-only:** no `[procedure]` mint. No `memory_search`. No BrainMemory.

Official Small: 100-trajectory haystack ~25M tokens, 451 questions. HuggingFace `xiaowu0162/longmemeval-v2`. M26 re-exam is after ExperienceStore files + silent slice inject (M23–M25). Official close is live n=451 — do not copy M15 **2.7%** into this acc cell.

## Headline

| metric | value |
|---|---|
| n | **451** |
| correct | 8 |
| **acc** | **1.8%** |
| inject p50 / p95 | 1433.0 / 4038.0 ms |
| reader p50 / p95 | 1042.0 / 9184.0 ms |
| query (inject+reader) p50 / p95 / mean | 3014.0 / 10840.0 / 4355.6 ms |
| empty packets | 0 / 451 (honest: files/silent slice can retrieve or miss; junk always-on is not assumed; non-empty ≠ gold) |
| gold_in_packet hit / phrase-match denom | 77 / 226 of 451 (34.1%; 225 N/A llm/mc — not a sample) |
| reader answered | 295 / 451 (156 HTTP errors scored incorrect) |

## vs M15 / diagnostic (Report §11.1)

| baseline | n | acc | gold_in_packet | empty packets |
|---|---:|---:|---|---|
| M15.2 official Small | 451 | 2.7% | 73 / 226 phrase-match (225 N/A) | 0 / 451 (junk always-on then) |
| diagnostic | 200 | ~3.5% | — | — |
| this run (M26) | 451 | 1.8% | 77 / 226 phrase-match | 0 / 451 |

Compare explicitly: this run vs M15 official **2.7% @451** and the **~3.5% @200** diagnostic. Official close is n=451 only. Do not treat the diagnostic as Small.

## Verdict

| target | published | this run | verdict |
|---|---:|---:|---|
| RAG query→slice | 42.8 | 1.8 | **LOSS** |
| AgentRunbook-C | 74.9 | 1.8 | **LOSS** |

**Overall: LOSS.** Do not invent 74.9. Verdict is vs published RAG 42.8 / AgentRunbook-C 74.9, not vs M15 2.7%. Overall WIN only if both rows WIN. Target first ≥ RAG 42.8, then AgentRunbook-C 74.9 (Plan §9.2).

## Honesty (do not green-wash)

**gold_in_packet denominator.** 77/226 is **not** a 226-question sample of n=451. `goldInPacket` only scores phrase-match `eval_function`s (`norm_phrase_set_match` + `norm_phrase_set_match_ordered`). llm/mc are N/A (null), not skipped. All 451 questions were queried; 225 llm_*/mc_* rows are N/A.

**empty packets 0/451.** honest: files/silent slice can retrieve or miss; junk always-on is not assumed; non-empty ≠ gold. Retrieval honesty is gold_in_packet hit / phrase-match denominator, not empty-packet count. 0 empty does not prove junk always-on.

**screenshots skipped (named).** Official Small includes HF `trajectory_screenshots` (~7GB remainder) and 29 question images (`errors-gotchas`). This run is text-only. Do not treat 1.8% as comparable to AgentRunbook-C 74.9 on multimodal gotchas.

**backbone.** NVIDIA NIM `google/gemma-4-31b-it`. Not 4o-mini. Not BrainMemory.

**reader errors.** 295/451 NIM answered. 156/451 scored incorrect after reader HTTP errors. Acc is still 8/451.

## M25 screenshot policy (2026-09-20)

The 29 `errors-gotchas` questions are multimodal. Policy: **skipped (named LOSS)** — HF `trajectory_screenshots` (~7GB remainder) and the 29 question images were not downloaded, not stored, and not replayed by sleep. If a host supplies alt-text/captions, those may be stored as text; this run did not ingest screenshots. Sleep (M25) replays experience **text files** into gists/how-to; files remain. That is not AgentRunbook-C **74.9**. Do not treat any current acc as comparable to 74.9 on multimodal gotchas (Report §4.12).

## M26.3 latency

Live-run inject (this file) vs filed clocks. **Different fixtures — do not collapse them.**

| clock | inject p50 | inject p95 | fixture |
|---|---:|---:|---|
| this LME run | 1433.0 | 4038.0 | ExperienceStore files + short JSONL notes; in-process inject |
| M15 LME | 82 | 286 | 2000 JSONL records (observe-only; no experience files) |
| M6.4 | 0.048 | 0.133 | 5-message fixture, N=80 (`BASELINE.md`) |

Wrap inject is in-process `AgentMemory.inject`, not a 60ms CLI. M6.4 remains the small-store baseline. LME p95 is haystack retrieve, not a CLI gate.

## What was actually ingested

Downloaded official `questions.jsonl` + `haystacks/lme_v2_small.json` + trajectories text. Did **not** download screenshot tarballs (~7GB dataset remainder). Kept only the 200 unique Small-tier trajectory ids, truncated per-state text, then `putExperience` (AX `tree` on `experience/*.jsonl`) + short observe notes (goal/outcome/url only, `omitExperienceTree`) + `mem.sleep()`. JSONL store cap 2000 (`EDEN_MEMORY_STORE_CAP`) is **not** raised as a fake haystack. Experience disk cap `EDEN_EXPERIENCE_BYTES`=268435456 (default 32MiB may evict 200 traj files). All 200 unique Small traj ids were present in trajectories.jsonl.

| | |
|---|---|
| questions.jsonl | 451 questions (official 451) |
| unique Small traj ids | 200 (2 shared 100-traj haystacks: web + enterprise) |
| screenshots | **skipped** (HF trajectory_screenshots + 29 question images not used) |
| official haystack size | ~25M tokens — **not ingested** |
| store after ingest | JSONL notes are short (goal/outcome/url); cap 2000 is not the haystack. Experience files: see domain table. Disk cap `EDEN_EXPERIENCE_BYTES`=268435456 (raised if tight) |
| truncation | accessibility_tree 1200 chars, thought 600, action 400, states/traj ≤ 40 |

| domain | traj found | states kept | chars kept | jsonl / cap | experience files | ingest |
|---|---|---|---|---|---|---|
| enterprise | 100/100 | 2358 | 3973266 | 100 / 2000 | 100 | 2.6s |
| web | 100/100 | 1583 | 2398927 | 105 / 2000 | 100 | 1.1s |

## Accuracy by question_type

| type | n | correct | acc % |
|---|---:|---:|---:|
| dynamic-environment | 86 | 2 | 2.3 |
| dynamic-environment-abs | 41 | 0 | 0.0 |
| errors-gotchas | 29 | 2 | 6.9 |
| procedure | 74 | 4 | 5.4 |
| procedure-abs | 32 | 0 | 0.0 |
| static-environment | 134 | 0 | 0.0 |
| static-environment-abs | 55 | 0 | 0.0 |

## Diagnosis (why LOSS)

1. **Files exist.** `putExperience` wrote 200 trajectory files (`experience/*.jsonl`, AX `tree`, not extractDurable). Inject is silent `[episode]` slices (k≤6), not a file-walking coding-agent memory controller. Still **LOSS** vs RAG 42.8 and AgentRunbook-C 74.9 (Plan §9.2).
2. **Screenshots skipped (named).** Gotchas (n=29) are multimodal; this run is text-only. That is not AgentRunbook-C 74.9.
3. **Truncation.** accessibility_tree 1200 chars, thought 600, action 400, states/traj ≤ 40. Official Small ~25M tokens not ingested.
4. **k.** Product default 6 (`EDEN_MEMORY_CAP`). Silent slices add a small extra budget; not k=40 MCC.
5. **Backbone.** NVIDIA NIM `google/gemma-4-31b-it`. Not 4o-mini. Not BrainMemory.
6. **Chat-only / no `memory_search`.** Reader sees only the inject packet. Store cap 2000 still evicts JSONL; experience disk cap is distinct (`EDEN_EXPERIENCE_BYTES`).
7. **Reader probe:** NIM answered.

## How to re-run

```bash
bun benchmarks/lme-v2/run.ts
```

Data cache: `benchmarks/lme-v2/.data/` (gitignored). Do not retune `src/index.ts` from this number. Schema is this file + `last-run.json`, not M15.1 MAB JSON. Smoke (`LME_LIMIT`) ≠ official.

## M15 lock appendix (2026-09-19)

Frozen M15.2 official Small (**not** this run): n=451, correct=12, acc=**2.7%**, gold_in_packet **73 / 226** phrase-match (225 llm/mc N/A), empty **0 / 451** (junk always-on then). inject p50/p95 82.0/286.0 ms. Reader `google/gemma-4-31b-it`. Overall LOSS vs RAG 42.8 and AgentRunbook-C 74.9. Do not copy these cells into the M26 headline.
