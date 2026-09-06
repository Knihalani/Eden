# Fixture verticals

These are campaign fixture verticals, not customers. Customer-approved measured studies: 0. Unpublished slots stay empty. No company names. Kind and Source use the same table chrome as the wins table so this cannot be read as a second unlabeled win board. The live heading on `/proof` is **Fixture verticals**, not Case studies.

The live page is `/proof`. Graphite only. Numbers are rows in `packages/measure/src/claims.ts` (`PUBLIC_CLAIMS` via `fixtureStudies()`). Do not invent a company.

| Vertical | Kind | Source | Tag | Label | Claim | File |
|---|---|---|---|---|---|---|
| support | win | campaign | fixture | Campaign measurement | Live program, one stretch: 6.67× fewer turns, 1.78× faster, 4.17× cheaper (p=0.0005, n=12). | `benchmarks/campaign/bench-campaign.ts` |
| desk | win | campaign | fixture | Campaign measurement | Desk lifecycle: 1.36× turns, 1.16× wall, 1.31× cheaper (p=0.016). | `benchmarks/campaign/bench-campaign.ts` |
| orders | win | campaign | fixture | Campaign measurement | Fan-out loop + refund: 1.19× turns, 1.12× wall, 1.19× cheaper (p=0.016). | `benchmarks/campaign/bench-campaign.ts` |
| etl | win | campaign | fixture | Campaign measurement | Read fan-out then report: 1.43× turns, 1.28× wall, 1.36× cheaper (p=0.016). | `benchmarks/campaign/bench-campaign.ts` |
| incident | win | campaign | fixture | Campaign measurement | Flaky reads and retries: 1.35× turns, 1.13× wall, 1.32× cheaper (p=0.016). | `benchmarks/campaign/bench-campaign.ts` |

Customer-approved measured studies: **0**.
