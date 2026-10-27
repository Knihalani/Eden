# M32 Terminal-Bench 2.1 Δ RESULTS

**M37.3 recert:** 2026-09-24 — after M16–M36; locked subset k=5; not 89-task; backbone `google/gemma-4-31b-it`.

Own schema (not MAB Table 3 / not LME-V2). Absolute % is the **agent** (**terminus-2**), not Eden. Memory claim is **Δ** vs the same locked harness (Plan §9.2 CLI SOTA: k=5, wrap ± inject).

| field | value |
|---|---|
| wave | M32 |
| date | 2026-09-24 |
| harness | Harbor CLI + terminus-2 + Docker (timeout_multiplier=3.0) |
| Harbor CLI | 0.23.0 |
| Harbor ran | yes |
| Harbor dry-run | OK |
| dataset | terminal-bench/terminal-bench-2-1 |
| dataset source | git-clone:https://github.com/harbor-framework/terminal-bench-2-1.git (cached) |
| public board (89 tasks) | **no — locked subset** |
| n (tasks) | 2 |
| k (trials / task) | 5 |
| model | `google/gemma-4-31b-it` |
| agent | terminus-2 |
| wrap | packages/wrap handleChatCompletions → injectBodyThenObserveTools(processMemory()) |
| inject check | off identity=true; on mark=true; on fact=true |
| NIM base | https://integrate.api.nvidia.com/v1 |
| reasoning_effort | n/a (both arms) |
| NVIDIA trial $/MTok | input 0 / output 0 |
| tasks | `terminal-bench/openssl-selfsigned-cert`, `terminal-bench/regex-log` |

## Δ (on − off)

| metric | off (EDEN_MEMORY=0 identity) | on (inject) | Δ |
|---|---|---|---|
| accuracy (Harbor mean) | 30.0% | 20.0% | -10.0 pp |
| tokens prompt | 126979 | 143140 | 16161 |
| tokens completion | 15312 | 10963 | -4349 |
| tokens total | 142291 | 154103 | 11812 |
| $ (NVIDIA trial $0/MTok) | $0.0000 | $0.0000 | $0.0000 |
| n_trials | 10 | 10 | |
| n_resolved (reward=1.0) | 3 | 2 | |
| n_resolved / n_trials | 3/10 | 2/10 | |
| n_errored | 5 | 5 | |

**Accuracy definition:** Harbor job mean (`stats.evals.*.metrics[].mean`) over `n_total_trials`. Errored trials count as **0 reward in that mean**, but they are **not** listed as reward 0.0 in the trial table — they are named exceptions. Also published: n_resolved/n_trials (reward 1.0 only). Absolute % is the **agent** (**terminus-2** + NVIDIA NIM `google/gemma-4-31b-it`), not Eden. Δ = on − off.
**Δ accuracy is a LOSS.** On-arm is worse; do not read this as a memory win.
Cost is NVIDIA hosted trial list ($0/MTok). Token counts are still reported. Not Friendli / third-party list price.
No BrainMemory column. No cortex-off. Not the 89-task tbench.ai board.

## Remain-silent measure

Dated 2026-09-24. Count of Harbor trials whose wrap inject packet was **empty** vs **junk** vs on-cue. Harbor trajectories do not contain `Eden Memory:` — counts come from wrap `EDEN_MEMORY_INJECT_LOG` JSONL. **Do not implement the omit gate here** — that is M38. Silent inject stays always-on; this wave only measures.

| arm | n_trials | empty | junk | on_cue | no_inject | n_injects |
|---|---|---|---|---|---|---|
| off (EDEN_MEMORY=0) | 10 | 5 | 0 | 0 | 5 | 31 |
| on (inject) | 10 | 0 | 0 | 5 | 5 | 30 |

empty = no `Eden Memory:` packet (off-arm identity, or on-arm with nothing to inject). junk = packet present and notes share no contentful tokens with this-turn cue (leftover sqlite/Clerk/postgres/CircleCI/diet on an openssl cue). no_inject = trial had no wrap chat (tmux died before first inject) — not an empty packet.

always-on lost vs off (Δ accuracy negative). Always-on inject that cannot help **hurts**. This is **evidence for M38**, not a WIN.

## Arm `off` (EDEN_MEMORY=0)

Harbor ran: yes. Job dir: `/Users/kaiavnihalani/Downloads/Eden/benchmarks/terminal-bench/jobs/eden-m32-off-google-gemma-4-31b-it`.

| task | trial | reward | error | prompt tok | completion tok |
|---|---|---|---|---|---|
| terminal-bench/openssl-selfsigned-cert | openssl-selfsigned-cert__4Pg5WKL | 1 |  | 17760 | 2548 |
| terminal-bench/openssl-selfsigned-cert | openssl-selfsigned-cert__f77BEra | 1 |  | 16588 | 2444 |
| terminal-bench/openssl-selfsigned-cert | openssl-selfsigned-cert__KQJ4bW2 | 0 |  | 26419 | 3285 |
| terminal-bench/openssl-selfsigned-cert | openssl-selfsigned-cert__qiv6n7e | 0 |  | 49921 | 4697 |
| terminal-bench/openssl-selfsigned-cert | openssl-selfsigned-cert__SighcFj | 1 |  | 16291 | 2338 |
| terminal-bench/regex-log | regex-log__b3RgyFu | n/a | RuntimeError | 0 | 0 |
| terminal-bench/regex-log | regex-log__Lf6EEiy | n/a | RuntimeError | 0 | 0 |
| terminal-bench/regex-log | regex-log__qPytXfL | n/a | RuntimeError | 0 | 0 |
| terminal-bench/regex-log | regex-log__Xm8pM4Y | n/a | RuntimeError | 0 | 0 |
| terminal-bench/regex-log | regex-log__zpqXUWp | n/a | RuntimeError | 0 | 0 |

## Arm `on` (EDEN_MEMORY=on)

Harbor ran: yes. Job dir: `/Users/kaiavnihalani/Downloads/Eden/benchmarks/terminal-bench/jobs/eden-m32-on-google-gemma-4-31b-it`.

| task | trial | reward | error | prompt tok | completion tok |
|---|---|---|---|---|---|
| terminal-bench/openssl-selfsigned-cert | openssl-selfsigned-cert__G96wVdr | 0 |  | 27583 | 1794 |
| terminal-bench/openssl-selfsigned-cert | openssl-selfsigned-cert__GesCZNM | 1 |  | 31097 | 2956 |
| terminal-bench/openssl-selfsigned-cert | openssl-selfsigned-cert__Gybj6CW | 0 |  | 25563 | 1664 |
| terminal-bench/openssl-selfsigned-cert | openssl-selfsigned-cert__rqxdUu4 | 0 |  | 23877 | 1771 |
| terminal-bench/openssl-selfsigned-cert | openssl-selfsigned-cert__XbXJAtC | 1 |  | 35020 | 2778 |
| terminal-bench/regex-log | regex-log__BcwytpQ | n/a | RuntimeError | 0 | 0 |
| terminal-bench/regex-log | regex-log__Mm2Scjo | n/a | RuntimeError | 0 | 0 |
| terminal-bench/regex-log | regex-log__qfD8wrn | n/a | RuntimeError | 0 | 0 |
| terminal-bench/regex-log | regex-log__UmRDdnn | n/a | RuntimeError | 0 | 0 |
| terminal-bench/regex-log | regex-log__xXmPirh | n/a | RuntimeError | 0 | 0 |

## How to re-run

```bash
bun benchmarks/terminal-bench/run.ts
```

Requires Docker, Harbor CLI, NVIDIA_API_KEY in gitignored `.env`. Never print the key.

## Notes

- Locked subset, k=5, both arms through wrap. Full 89×5×2 was not run.
- Wrap `--no-coding` so the Δ is memory inject, not stretch compile.
- Harbor OPENAI_API_KEY is a local wrap stand-in (`sk-eden-tb-wrap-only`); upstream NVIDIA key stays in the wrap process.
- Wrap injectBodyThenObserveTools: EDEN_MEMORY=0 identity=true; on mark=true fact=true.
- Accuracy is Harbor's own mean over n_total_trials (errored trials counted as 0 in that mean). n_resolved/n_trials is also published. Errored trials are named exceptions, not silent reward 0.0.
- regex-log tmux failures (off, all 5): regex-log__b3RgyFu, regex-log__Lf6EEiy, regex-log__qPytXfL, regex-log__Xm8pM4Y, regex-log__zpqXUWp — Command timed out after 120 seconds.
- regex-log tmux failures (on): regex-log__BcwytpQ, regex-log__Mm2Scjo, regex-log__qfD8wrn, regex-log__UmRDdnn, regex-log__xXmPirh — Command timed out after 120 seconds.
- NVIDIA hosted trial list price is $0/MTok; token counts are reported, $ Δ is $0.0000.

Cite: Terminal-Bench [arxiv:2601.11868]; memory exam slot [arxiv:2607.08716] via Plan §11.1. Harbor dataset: https://github.com/harbor-framework/terminal-bench-2-1
