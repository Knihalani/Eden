# The distilled reader: a no-model cascade in front of the ask-time reader

Status: in progress (2026-11-03). Lab only, simulated data.

## Pre-registered bar (written before the blind run)

The blind check runs once, on held-out 10 and 11, seeds 41–42 (128 hidden and 128 control tasks), with the scorer,
its thresholds and its features frozen from train. Held-out 12 and 13 are not run. Nothing is tuned after it.

- **Configuration under test:** NEW (D98) with `askReaderWaitMs` 60,000 (as haiku-opt.md, so latency does not decide
  what is read), with the reader behind the cascade (`--distill cascade:model.json`). Escalated calls go to Haiku 5.5
  (replayed from the NEW run's reader cache where the prompt is the same, live otherwise).
- **Baseline:** NEW, same settings, reader on every call, same suites and seeds, run in the same session.
- **Adopt behind a flag only if both hold:**
  1. hidden surfaced (delivered or ask-cited) ≥ NEW's − 2 points;
  2. reader calls ≤ NEW's / 1.5 (escalation rate ≤ 66.7% of the reader calls NEW makes).
- **Reported whatever happens:** decoys surfaced against NEW (a rise above +2 points is reported as a failure of
  precision even if 1 and 2 hold), local-silent and local-bind counts, and the implied reader cost and latency saving.
- Otherwise the direction is recorded as rejected.
