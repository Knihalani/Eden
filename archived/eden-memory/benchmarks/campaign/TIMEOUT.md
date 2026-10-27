# Timeout default (Wave 4.4)

Measured 2026-08-27T06:44:33.092Z on this machine. Gated: exactly-once on every sweep cell.

## Fast-tool distribution

Campaign-class tools sleep ~8ms. Measured p50 **10.04 ms**, p99 **12.02 ms**.

A compiled stretch of 4 such tools is ~48 ms p99. The wrap ceiling must sit **above** that, or healthy stretches deopt after a write (P3 class).

## Sweep (slowJudge = 80 ms)

| timeout_ms | writes | notified | class | wall_ms |
|---|---|---|---|---|
| 40 | 1 | 0 | deopt-claim | 52 |
| 80 | 1 | 0 | deopt-claim | 82 |
| 400 | 1 | 1 | complete | 84 |
| 8000 | 1 | 1 | complete | 84 |

Deopt-claim (timeout < slow) is **correctness-WIN**: applyCredit once, email not guessed. Completing (timeout > slow) is **turns-WIN**: the compiled run finishes.

## Justified default

`DEFAULT_WRAP_TIMEOUT_MS = 60000` (60s).

- Must exceed p99 of a healthy compiled stretch. Campaign p99×4 ≈ 48 ms; production HTTP p99 is seconds.
- 8s is the hook self-cap (R5), a different path.
- 60s matches `ARM_TTL_MS` so a settled arming and the run share a clock; the 300s cap remains the hard ceiling.
- Test/campaign probe is `CAMPAIGN_WRAP_TIMEOUT_MS` (default 120 ms) — **not** the product default. Short timeouts exist to pin P3, not to ship.

Lowering the default to the probe (120 ms) would deopt every compiled stretch whose tools sum past 120 ms. That cell is a LOSS on wall and a correctness-only WIN. The product default stays 60s because the complete-cell at 8s/60s is the gated benefit of waiting for a healthy run.
