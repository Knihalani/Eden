# Proof

Campaign cells are paired and counterbalanced, with an A/A self-check, in `packages/measure`. WIN and LOSS are `decide()` verdicts. Negative-control parity is ±1%, registered once and never moved after seeing a result. Every number on this page links the file that measured it.

Nothing public without methodology. UNCERTIFIED is never a win. Analogue cents are labeled analogue, not a live Claude Code invoice. Limits and retired claims print with the same file path as the wins.

The live page is `/proof`. Graphite only. Numbers are rows in `packages/measure/src/claims.ts` (`PUBLIC_CLAIMS`). Do not quote a figure that is not on that table.

## Wins

Campaign WINs from `packages/measure`. Replica analogue cents are not in this table.

| Name | Claim | File |
|---|---|---|
| short-support | Live program, one stretch: 6.67× fewer turns, 1.78× faster, 4.17× cheaper (p=0.0005, n=12). | `benchmarks/campaign/bench-campaign.ts` |
| long-desk | Desk lifecycle: 1.36× turns, 1.16× wall, 1.31× cheaper (p=0.016). | `benchmarks/campaign/bench-campaign.ts` |
| long-orders | Fan-out loop + refund: 1.19× turns, 1.12× wall, 1.19× cheaper (p=0.016). | `benchmarks/campaign/bench-campaign.ts` |
| long-etl | Read fan-out then report: 1.43× turns, 1.28× wall, 1.36× cheaper (p=0.016). | `benchmarks/campaign/bench-campaign.ts` |
| long-incident | Flaky reads and retries: 1.35× turns, 1.13× wall, 1.32× cheaper (p=0.016). | `benchmarks/campaign/bench-campaign.ts` |
| thrash-enforce | Runaway loop halted: 5.14× less spend, 5.29× faster (p=0.002, n=10). | `benchmarks/campaign/bench-campaign.ts` |
| fastdesk-live | Instant tools, program live: 7.0× turns / 6.4× wall — think-time, not tool time. | `benchmarks/campaign/bench-negative.ts` |

## Analogue

Headless replica TURN_CENTS. Not a live Claude Code invoice. Not a campaign WIN.

| Name | Claim | File |
|---|---|---|
| S1b headless analogue | Hook-path remainder deny on a headless replica that always drops updatedToolOutput: −9.1% cents vs raw (3.3 → 3.0, n=8). Analogue TURN_CENTS, not a live Claude Code invoice. | `benchmarks/campaign/SILENT-DROP.md` |

## Parity

Negative-control parity at ±1%. Same files, same rigor as the wins.

| Name | Claim | File |
|---|---|---|
| unique-work | Nothing repeats: parity (+0.2% wall = recorded overhead). | `benchmarks/campaign/bench-negative.ts` |
| creative | All-judgment stretches: compile refuses honestly; parity. | `benchmarks/campaign/bench-negative.ts` |
| micro | Sub-minimum 2-call stretches ×16: exact parity. | `benchmarks/campaign/bench-negative.ts` |
| chaos-observe | 67% failures, observe mode: parity — a broken Eden does not halt the agent. | `benchmarks/campaign/bench-negative.ts` |

## Limits

OOD, oblivious agents, certification bounds, host limits, JIT default. Equal weight with the wins.

| Name | Claim | File |
|---|---|---|
| oblivious-long | Wrap skipRest when the model never early-stops: +2.8% cents and +3.2% wall. Retired from the win table. Island spend with no turn savings. | `docs/ROADMAP.md` |
| ood-long | Every goal out of envelope against a live program: steering misses; parity expected; corruption fails. | `benchmarks/campaign/bench-campaign.ts` |
| certification bounds | Soak go-live 11/14 rounds. The 3 misses are witness-efficiency, not quoted as certified savings. UNCERTIFIED is never a win. | `docs/ROADMAP.md` |
| replica host-drop | Live Claude Code does not ack an always-drop of a correct native rewrite. Replica host-drop is a permanent host limit, not a live ack. | `benchmarks/campaign/HOST-DROP.md` |
| JIT soak default | Wave 19 remeasure of bun run bench:jit-soak printed FAIL precision=0.789 n=38 (shape 30/30; name-only/campaign 0/8). Unique-work empty-catalog held. Default EDEN_SURFACE stays all. Not a win. | `benchmarks/campaign/JIT-SOAK.md` |

## Retired

Claims withdrawn in public until a file parses. Retired is a result.

| Name | Claim | File |
|---|---|---|
| S1b live Claude Code invoice | No live Claude Code invoice file is in the tree. The analogue −9.1% cell is not a live bill. This quote is retired until an invoice parses as live-invoice. | `benchmarks/campaign/LIVE-AB.md` |

Case studies (campaign fixtures, customer-approved count 0) live in [cases](cases.md).
