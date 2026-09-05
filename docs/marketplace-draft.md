Not published. Arc 8 numbers first.

# eden-routines (unpublished draft)

Withheld until a real customer n exists. This file is not a public listing and is not submitted anywhere. This draft is not a Determinism Index.

Every multiplier and percent below is a row in `packages/measure/src/claims.ts` (`PUBLIC_CLAIMS`), with the file that measured it. A number that is not on that table must not be printed here. The word certified in a limits row means a shadow go-live PASS, not a SOC 2 attestation.

## Wins

- **short-support** (`6.67× turns`) — Live program, one stretch: 6.67× fewer turns, 1.78× faster, 4.17× cheaper (p=0.0005, n=12). File: `benchmarks/campaign/bench-campaign.ts`.
- **long-desk** (`1.36× turns`) — Desk lifecycle: 1.36× turns, 1.16× wall, 1.31× cheaper (p=0.016). File: `benchmarks/campaign/bench-campaign.ts`.
- **long-orders** (`1.19× turns`) — Fan-out loop + refund: 1.19× turns, 1.12× wall, 1.19× cheaper (p=0.016). File: `benchmarks/campaign/bench-campaign.ts`.
- **long-etl** (`1.43× turns`) — Read fan-out then report: 1.43× turns, 1.28× wall, 1.36× cheaper (p=0.016). File: `benchmarks/campaign/bench-campaign.ts`.
- **long-incident** (`1.35× turns`) — Flaky reads and retries: 1.35× turns, 1.13× wall, 1.32× cheaper (p=0.016). File: `benchmarks/campaign/bench-campaign.ts`.
- **thrash-enforce** (`5.14× spend`) — Runaway loop halted: 5.14× less spend, 5.29× faster (p=0.002, n=10). File: `benchmarks/campaign/bench-campaign.ts`.
- **fastdesk-live** (`7.0× turns`) — Instant tools, program live: 7.0× turns / 6.4× wall — think-time, not tool time. File: `benchmarks/campaign/bench-negative.ts`.
- **JIT soak default** (`PASS precision=1.000 n=38`) — Wave 22.2 bun run bench:jit-soak printed PASS precision=1.000 n=38 (gh 18/18, kubectl 12/12, name-only 4/4, campaign 4/4). Hold-outs jit-id / jit-cli / jit-url each printed PASS precision=1.000. Unique-work empty-catalog held. Default EDEN_SURFACE is jit. EDEN_SURFACE=all is the opt-out. File: `benchmarks/campaign/JIT-SOAK.md`.

## Parity

- **unique-work** (`parity +0.2% wall`) — Nothing repeats: parity (+0.2% wall = recorded overhead). File: `benchmarks/campaign/bench-negative.ts`.
- **creative** (`parity (refuses)`) — All-judgment stretches: compile refuses honestly; parity. File: `benchmarks/campaign/bench-negative.ts`.
- **micro** (`exact parity`) — Sub-minimum 2-call stretches ×16: exact parity. File: `benchmarks/campaign/bench-negative.ts`.
- **chaos-observe** (`parity`) — 67% failures, observe mode: parity — a broken Eden does not halt the agent. File: `benchmarks/campaign/bench-negative.ts`.

## Analogue

- **S1b headless analogue** (`−9.1% cents (analogue)`) — Hook-path remainder deny on a headless replica that always drops updatedToolOutput: −9.1% cents vs raw (3.3 → 3.0, n=8). Analogue TURN_CENTS, not a live Claude Code invoice. File: `benchmarks/campaign/SILENT-DROP.md`.

## Limits

- **oblivious-long** (`+2.8% cents / +3.2% wall`) — Wrap skipRest when the model never early-stops: +2.8% cents and +3.2% wall. Retired from the win table. Island spend with no turn savings. File: `benchmarks/campaign/OBLIVIOUS-LONG.md`.
- **ood-long** (`parity (miss)`) — Every goal out of envelope against a live program: steering misses; parity expected; corruption fails. File: `benchmarks/campaign/bench-campaign.ts`.
- **certification bounds** (`11/14 soak certified`) — Soak go-live 11/14 rounds. The 3 misses are witness-efficiency, not quoted as certified savings. UNCERTIFIED is never a win. File: `benchmarks/campaign/WITNESS-ECON.md`.
- **replica host-drop** (`host limit (replica-only)`) — Live Claude Code does not ack an always-drop of a correct native rewrite. Replica host-drop is a permanent host limit, not a live ack. File: `benchmarks/campaign/HOST-DROP.md`.

## Retired

- **S1b live Claude Code invoice** (`retired`) — No live Claude Code invoice file is in the tree. The analogue −9.1% cell is not a live bill. This quote is retired until an invoice parses as live-invoice. File: `benchmarks/campaign/LIVE-AB.md`.

## Fixture verticals

Customer-approved measured studies: 0. Fixture verticals (support, desk, orders, etl, incident) are campaign measurements, not customers. Do not invent a company.

## Determinism Index

The Determinism Index public page stays unpublished. It needs an n we do not have. ROADMAP §6 keeps it pruned. This draft is not that page and does not stand in for it.
