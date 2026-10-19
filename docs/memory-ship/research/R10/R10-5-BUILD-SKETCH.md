# R10-5 build sketch: the off-hook memory checker

A plain description of what R10-5 would add to Eden, what it costs, and what the user has to decide. It is not a
slice spec. If R10-5 is approved, a slice turns this into one under the normal lifecycle. Every number is from
`LEDGER.md` or from the command named next to it.

## What it does (three steps per user turn)

1. **At UserPromptSubmit (no model, as today).** The hook shortlists up to 15 memories with its existing matchers
   (lexical with compiled cues, plus the self-play bank). It injects nothing and returns at once.
2. **Off the hook (one small-model call).** A background process sends the turn, a little recent context, some of
   the user's ordinary earlier turns (for calibration), and the 15 candidates to a small model. The model gives
   each candidate a probability that the assistant needs it for this turn. Rows at p ≥ 0.6 are kept (at most 4).
3. **At the turn's first tool call (PreToolUse or PostToolBatch).** The kept rows are delivered, each prefixed with
   its date ("[as of 2026-08-27] …"). Eden still decides, unasked; the agent never has to call anything.

## What it buys (measured, synthetic StreamBench turns, every model a Claude model)

- **Per-turn effect on replies** (0–3 judge scale, against no memory), two independent runs per world:
  - coding: +0.1011 over today's plugin [+0.0085, +0.1988];
  - personal assistant: +0.1342 [+0.0415, +0.2275] (C6-E2, C7-E3).
- **Where memory is needed:** about +0.5. Where it isn't: no measurable harm.
- **No-model alternatives:** none matched it (C6-E3, C7-E1, C7-E2).

## What it costs

- **One model call per turn that has a shortlist.**
  - Input is about 1.7k tokens at the median and about 2.1k at p95 (C8-T1 inputs, measured as characters / 4).
  - Output is about 15 short scores.
- **Latency budget:** the call must finish before the turn's first tool call, or that turn gets nothing.
  - Nothing ever waits for the call; the turn goes on without it (fail-open).
  - The harness cannot measure the time from Submit to the first tool call. A headless Claude Code run can.
- **Turns with no tool call get nothing.** On personal-assistant turns that need memory this is 11 of 49 (questions
  like "remind me what I said…"). Fixing it would add at most about +0.015 per turn (C8-E1).

## What the user decides

1. **Allow an in-turn model call off the hook.**
   - D37 today allows models only offline (sleep, evals), opt-in, on sanitized rows, never on a hook path.
   - This call is off the hook, but it runs during the turn and sees the turn's text.
2. **Which provider.**
   - **A small Claude model (haiku):** what was measured. It is not a D37 provider.
   - **An NVIDIA NIM model:** the D37 provider, not yet measured here.
     - D37 records hosted p95 latency of 40–70 s, which would miss most first tool calls.
     - `verify_nim.py` runs the re-measure in one command once `NVIDIA_API_KEY` is in the environment (C8-T1). It
       prints the quality numbers and p50/p95 latency.

## Not measured yet

- Latency from Submit to the first tool call in real sessions, and the checker's own latency on either provider.
- Any non-Claude responder or judge.
- Real user transcripts. Every number above comes from synthetic worlds.
