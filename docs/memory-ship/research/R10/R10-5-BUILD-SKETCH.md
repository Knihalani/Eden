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

- **Per-turn effect on replies over today's plugin** (0–3 judge scale), two independent runs per world:
  - coding: +0.1011 [+0.0085, +0.1988];
  - personal assistant: +0.1342 [+0.0415, +0.2275] (C6-E2, C7-E3).
- **Where memory is needed:** about +0.5. Where it isn't: no measurable harm.
- **No-model alternatives:** none matched it (C6-E3, C7-E1, C7-E2).

## What it costs

- **One model call per turn that has a shortlist.**
  - Input is about 1.7k tokens at the median and about 2.1k at p95 (C8-T1 inputs, measured as characters / 4); the
    CLI calls of C8-E6 carried 3.3k–4.2k, with CLI overhead.
  - Output is about 15 short scores.
- **Latency budget:** the call must finish before the turn's first tool call, or that turn gets nothing.
  - Nothing ever waits for the call; the turn goes on without it (fail-open).
  - **Measured in real headless Claude Code sessions (C8-E4, n = 12, 10 with a tool call):** the first tool call
    comes about 3 s after Submit at the median (2.92 s by index, 2.77 s conventional; p90 14.13 s). Even
    delivering at any later tool call of the turn, a checker that takes 10 s reaches 3 of 12 turns, and one that
    takes 40 s reaches none. **The check needs to answer in about
    3 seconds.**
- **The measured checker is about twice too slow as run here** (C8-E6, 20 calls through the CLI): p50 5.6 s,
  p90 8.4 s, mostly ~600 tokens of thinking the CLI keeps on. Turning thinking off and asking only for the kept rows
  would help, but a fit of the 20 calls shows about 2.4 s fixed per call (the one no-thinking call took 3.5 s), so it
  may still miss through this route; a direct API call is unmeasured, and a new prompt needs its quality re-measured.
- **A short reply passes 3 of 4 quality tests** (C9-E1, retrieval level, weak evidence): asking only for the kept
  rows is close to the full-score checker, though it fires on a few more no-need turns, with a reply of about 1–2 rows. Through the CLI it is still p50 5.0 s
  (C9-E2), because thinking (≈ 560 tokens) stays on; with thinking off it would land near the 3 s edge by
  extrapolation, unmeasured.
- **Turns with no tool call get nothing.** On personal-assistant turns that need memory this is 11 of 49 (questions
  like "remind me what I said…"). A rough ceiling for fixing it is about +0.022 per turn (C8-E1).

## How much of the gain survives a slower check (estimate)

Post hoc, from C8-E4's 10 sessions with a tool call: the share that still has a tool call at or after the check's
latency, times the measured per-turn gain over today's plugin. It assumes the gain is spread evenly over turns and
that delivery can use any later tool call of the turn.

| Check latency | Turns still reachable | Coding gain kept | Personal-assistant gain kept |
|---|---|---|---|
| ≤ 2 s | 10 of 10 | +0.101 | +0.134 |
| 3 s | 8 of 10 | +0.080 | +0.107 |
| 5 s | 5 of 10 | +0.050 | +0.067 |
| 10 s | 3 of 10 | +0.030 | +0.040 |
| 20 s | 1 of 10 | +0.010 | +0.013 |

## What the user decided (2026-10-19)

The user amended D37: the in-turn, off-hook checker is allowed, opt-in per repo, on TypeSafe Jev or a fast NIM
model, chosen by measurement (LEDGER C10-E1). The decision points as they were put:

1. **Allow an in-turn model call off the hook.**
   - D37 today allows models only offline (sleep, evals), opt-in, on sanitized rows, never on a hook path.
   - This call is off the hook, but it runs during the turn and sees the turn's text.
2. **Which provider.**
   - **A small Claude model (haiku):** what was measured. It is not a D37 provider.
   - **TypeSafe Jev** (a non-generative decision model; added 2026-10-19): one request answers a yes/no question
     per candidate with a calibrated probability; the vendor reports 70–500 ms, and an independent test saw about
     140 ms on the server plus 0.7–0.9 s of network. Published attacks can flip its verdicts, so it needs an A6
     security review before shipping. **Measured (C10-E1/E2):** p50 0.21–0.27 s end to end from the container,
     about ten times inside the budget. With precise criteria and the candidate list in the state (threshold 0.7)
     its picks are close to the calibrated haiku checker (short by about 0.05 recall on code-rt1, ahead on
     life-rt1; post hoc). **On replies (C10-E3, one run):** it matches the haiku checker (−0.0117 code,
     −0.0262 life per turn) and beats today's plugin by +0.1017 / +0.0873, with CIs just touching 0.
     **Two runs (C10-E4):** matches haiku (+0.0015 code, +0.0122 life); beats today's plugin firmly on code
     (+0.122 [+0.0392, +0.2039]), not firmly on life (+0.0632 [−0.0186, +0.1499]).
   - **An NVIDIA NIM model:** none usable (C10-E1): three of the five candidates return 404, one failed to connect,
     and Nemotron 3.5 Lightning ran at p50 14.3 s with unparseable replies.
     - The repo records hosted p50 1–20 s and p95 40–70 s (EXECUTION.md). Against C8-E4's timings that would reach
       some turns at best and miss at least 5% of calls entirely; the re-measure gives the real numbers.
     - `verify_nim.py` runs the re-measure in one command once `NVIDIA_API_KEY` is in the environment (C8-T1). It
       prints the quality numbers and p50/p95 latency.

## What does not get around the 3-second budget

- **Checking late and delivering at the next turn** (C8-E5): on this benchmark a need turn never shares a need with
  the turn before it (code 0 of 37, life 0 of 59).
- **A model-free copy of the checker** (C7-E2): it picks no better than the hook's matcher.
- So the choice is a fast hosted small model during the turn, or no checker.

## Not measured yet

- The checker's latency with thinking off and a short reply, and on NIM (C8-E6 measured haiku through the CLI only).
- Any non-Claude responder or judge.
- Real user transcripts. Every number above comes from synthetic worlds.
