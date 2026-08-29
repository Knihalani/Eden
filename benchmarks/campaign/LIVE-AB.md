# Live A/B study (Wave 8.1)

Pre-registered 2026-08-27 via `bun run benchmarks/campaign/live-ab.ts`.
Paired protocol. Expect field recorded **before** any invoice parse or cell.

## Protocol

| Field | Value |
|---|---|
| name | `live-s1b` |
| question | Is S1b billed from a live Claude Code invoice, or is that quote retired? |
| expect | live-S1b cell is live-invoice or retired; replica host-drop is a permanent host limit; oblivious-long stays a limit not a win |
| paired | control vs treatment |
| arms | control / treatment |

Materiality for negative-control parity is unchanged: ±1%. Simulator turns are arithmetic. Wall-clock is the sampled meter.

## Retired vs measured

| Cell | Status | Source | Note |
|---|---|---|---|
| live-S1b invoice | **retired** | missing | No invoice file. Live-invoice claim retired. |
| analogue S1b −9.1% cents | measured (analogue) | analogue-headless | `benchmarks/campaign/SILENT-DROP.md`. The analogue −9.1% cell is not a live Claude Code invoice. |
| replica host-drop | host limit | replica-only | `benchmarks/campaign/HOST-DROP.md`. Live Claude Code cannot ack always-drop of a correct rewrite. |
| oblivious-long | limit | campaign wrap | +2.8% cents / +3.2% wall. Retired from the win table. |

No live Claude Code invoice file is in the tree. The analogue −9.1% cell is not a live bill. This quote is retired until an invoice parses as live-invoice.

Wave 19 pin: landing, `/proof`, whitepaper, and digest still have no live Claude Code invoice claim. The billed S1b cell stays retired. Analogue −9.1% stays labeled analogue.

## Methodology

Every public number below cites a campaign file. UNCERTIFIED is never a win. Analogue cents and replica host-drop cannot be quoted as live Claude Code facts.

Paired, counterbalanced, A/A-checked campaign cells live in `benchmarks/campaign/bench-campaign.ts` and `bench-negative.ts`. Decision rule: `@eden/measure` `decide()`.

## Win table (campaign — not live invoices)

| Scenario | Printed | File |
|---|---|---|
| short-support | 6.67× turns | `bench-campaign.ts` |
| long-desk | 1.36× turns | `bench-campaign.ts` |
| long-orders | 1.19× turns | `bench-campaign.ts` |
| long-etl | 1.43× turns | `bench-campaign.ts` |
| long-incident | 1.35× turns | `bench-campaign.ts` |
| thrash-enforce | 5.14× spend | `bench-campaign.ts` |
| fastdesk-live | 7.0× turns | `bench-negative.ts` |

## Analogue (replica — not a campaign WIN)

| Scenario | Printed | File |
|---|---|---|
| S1b headless analogue | −9.1% cents (analogue) | `SILENT-DROP.md` |

## Parity table

| Regime | Printed | File |
|---|---|---|
| unique-work | parity +0.2% wall | `bench-negative.ts` |
| creative | parity (refuses) | `bench-negative.ts` |
| micro | exact parity | `bench-negative.ts` |
| chaos-observe | parity | `bench-negative.ts` |

## Limits (not wins)

| Item | Printed | File |
|---|---|---|
| oblivious-long | +2.8% cents / +3.2% wall | `docs/ROADMAP.md` |
| ood-long | parity (miss) | `bench-campaign.ts` |
| certification bounds | 11/14 soak certified | `docs/ROADMAP.md` |
| replica host-drop | host limit (replica-only) | `HOST-DROP.md` |
| S1b live Claude Code invoice | retired | this file |

oblivious-long is a limit / loss, retired from the win table. Wrap skipRest when the model never early-stops bills island spend with no turn savings.

## Invoice parse

`EDEN_LIVE_INVOICE` path → `parseInvoice`. Missing file or analogue TURN_CENTS / ISLAND_CENTS → retired. Status this run: **retired** (missing).
