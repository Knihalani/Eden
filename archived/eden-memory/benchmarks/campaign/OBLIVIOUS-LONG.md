# Oblivious-long wrap-path limit (Wave 21.1)

Wrap skipRest when the model never early-stops. **Limit, not a win.** Island spend with no turn savings.

This file is the measurement close for `PUBLIC_CLAIMS` id `oblivious-long`. Isolation, `/proof`, `eden claims`, and the unpublished marketplace draft cite **this file**, not `docs/ROADMAP.md`.

## Printed

```
+2.8% cents / +3.2% wall
kind=limit source=campaign
n=8 pairs (noise floor)
verdict=limit (not a win)
file=this close
```

Wave 19.2 registered the wrap-path loss. Wave 21.1 moved the public `file` here. Deltas are unchanged. Do not retune them.

Kind: `limit`. Source: `campaign` (in-process wrap, not a Claude Code invoice, not analogue TURN_CENTS).

## What was measured

Campaign scenario 8 in `benchmarks/campaign/bench-campaign.ts` (`oblivious-long`).

- World: desk lifecycle (`createDesk`).
- Agent: **oblivious** (`aware: false`) — issues the full script after the head call was steered.
- Wrap: skipRest suppresses tail executions; the model still decided to issue those calls, so **turns still bill**.
- Island/tool work still runs on the compiled path, so cents and wall can rise while turns stay ~parity.

Pre-registered expect (campaign): `ms WIN via suppressed calls; turns ~parity (honest bound)`. The wrap-path cell did **not** clear a win on cents/wall. It is retired from the win table into this pin.

Runner: `bun run benchmarks/campaign/bench-campaign.ts` scenario 8. Noise-floor for the same named cell: `benchmarks/campaign/NOISE-FLOOR.md` (`oblivious-long`, n=8 pairs).

## Why this is a loss

Turn cost is charged per *decision*. SkipRest stops duplicate raw executions; it does not erase the turns the oblivious agent already spent. Island work on the compiled stretch is extra spend with no turn savings. That is the wrap-path bound. It is not S1b (S1b is hook-path remainder deny on a headless replica — analogue, `SILENT-DROP.md`).

## Honesty

- Not a win table row.
- Not a live Claude Code invoice.
- Not the analogue −9.1% cell.
- Wave 21.1 moved the public `file` here so a reader can open the close without treating the roadmap as a measurement.

Do not retune the printed deltas in this file to invent a wrap-path win.
