# RealUse-1 part C: Hermes Agent with and without Eden

Status: 2026-11-06. Anthropic-direct lab transport (D97): `claude-haiku-5-5` for the agent, the grader and Eden's
cards, intent and reader, `HAIKU_API_KEY`, every call on a spend ledger. Hermes Agent at commit 06433066f4, market
`direct` connector profile, change notifications on (`--push signals`), time scale 1, 3 concurrent streams.

**Where it ran.** The cloud session assigned to part C could not run Hermes: its permission check refused
`uv sync` in the hermes-agent checkout, then the run itself ("Code from External"). The parent session, which has a
working checkout, ran both Hermes suites instead, from the same tree (`heldout14` from the part A branch at 98125a0fc).
A container restart at about 15:37 UTC killed the first `heldout14` attempt part-way ($0.20 spent, no results kept);
it was rerun in full.

## Held-out 13 (read before), seeds 41–42, 64 hidden and 64 control tasks per arm

| | Hermes alone | Hermes + Eden | Difference (paired bootstrap 95%) |
| --- | --- | --- | --- |
| Hidden facts raised | 3.1% | 81.3% | +78.1 points (+67.2..+87.5) |
| False concerns (control) | 0.0% | 0.0% | 0 |
| Wall p50 / p90, hidden | 5.24 / 9.13 s | 4.10 / 10.50 s | +0.42 s (−0.39..+1.20) |
| Wall p50 / p90, control | 5.36 / 7.97 s | 5.99 / 11.53 s | +1.25 s (+0.28..+2.13) |
| $ per 1k tasks all-in, hidden / control | 0.367 / 0.354 | 0.655 / 0.658 | +0.319 (+0.274..+0.365), all tasks |
| Eden's per-task calls, $ per 1k | | 0.283 / 0.286 | |

Eden on the critical path: 1,735 ms mean per task (28% of wall); the reader is 74.5% (hidden) and 87.5% (control) of
it, p50 1,120 ms over 145 calls. Spend $0.1956.

## heldout14 (blind, written for RealUse-1), seeds 41–42, 64 tasks per variant and arm

| | Hermes alone | Hermes + Eden | Difference (paired bootstrap 95%) |
| --- | --- | --- | --- |
| Hidden facts raised | 15.6% | 67.2% | +51.6 points (+37.5..+64.1) |
| False concerns (control) | 0.0% | 3.1% | +3.1 (+0.0..+7.8) |
| Any concern (neutral, nothing planted) | 0.0% | 1.6% | +1.6 (+0.0..+4.7) |
| Wall p50 hidden / control / neutral | 4.53 / 4.81 / 4.23 s | 3.69 / 4.33 / 5.93 s | hidden +0.40 s (−0.30..+1.07), control +0.21 s (−0.40..+0.75), neutral +1.58 s (+1.03..+2.10) |
| $ per 1k tasks, hidden / control / neutral | 0.351 / 0.382 / 0.343 | 0.604 / 0.614 / 0.665 | +0.269 (+0.237..+0.300), all tasks |

Traffic mix (assumed: 1 hidden, 1 control, 8 neutral in 10): Hermes alone raises the hidden fact on 1.6% of all
tasks and a wrong concern on 0.0%; with Eden 6.7% and 1.6%; cost $0.348 → $0.654 per 1k tasks; wall p50 4.49 → 5.80 s.
Eden on the critical path: 1,331 ms mean per task (25%). Spend $0.2134 for the complete run ($0.4112 with the killed
first attempt).

## Reproduce

```bash
H="--card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5"
P="--source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals"
bun packages/sim/src/lab/hermes-ab.ts --hermes-src $HERMES --concurrency 3 --suite heldout13 \
  --variants hidden,control --time-scale 1 --config default --conditions hermes,hermes+eden --budget 1 --seeds 41 \
  --cards packages/sim/lab/cards/cards-v2.jsonl $H $P --spend-ledger L --spend-cap 4 --out h-41.json
# heldout14: --suite heldout14 --variants hidden,control,neutral --budget 1.4; then pi-ab-report.ts on both seeds.
```

Reports: `packages/sim/lab/realuse-1/C/hermes-heldout13-report.txt`, `hermes-heldout14-report.txt`.
