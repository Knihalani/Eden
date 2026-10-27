# What the committed benchmark results support

Short version: **none of the headline numbers in this directory are claims the
data can carry.** Run `bun run bench:verdict` to reproduce the analysis below.

This is not a statement that Eden does not work. It is a statement that these
runs cannot tell us either way, and that the numbers quoted in commit messages
and result files were read off an instrument with no error bars.

## The measurement problem

Every horizon bench passes `mcp: i > 0`, so on **task 1 the treatment arm has an
empty MCP config** — it is configured identically to control apart from the hook
file. Task 1 is therefore a free placebo cell, and whatever it measures is
noise by construction.

Pooled across the five committed runs:

```
Noise floor (A/A, n=5)
  mean relative  -4.5%   sd 28.9 percentage points
```

A ±29-point standard deviation on a cell where the treatment is switched off is
larger than any effect these benches were built to detect.

## Per-run verdicts

| run | reported | n | verdict |
|---|---|---|---|
| `bench-horizon-results.json` | −19.1% wall | 2 | no call |
| `bench-horizon-hard-results.json` | +17.2% wall | 2 | no call |
| `bench-horizon-harder-results.json` | **−45.0% wall** | 3 | no call |
| `bench-horizon-product-results.json` | **+15.8% wall** | 2 | no call |
| `bench-workshop-results.json` | −4.3% wall | 3 | no call |

Two independent reasons, either of which is sufficient:

1. **The design cannot reach significance.** These are paired comparisons over
   2–3 blocks. A paired sign test over *n* blocks has 2^*n* possible sign
   assignments, so its smallest attainable two-sided p is 2/2^*n* — 0.25 at
   three blocks. No arrangement of three tasks can clear α=0.05. Six blocks is
   the minimum at which significance is even reachable.

2. **The observed effects are inside the noise.** At n=3 the smallest detectable
   effect is roughly 75% of the control mean. The "45% faster" result is smaller
   than the error bar around it.

`bench-replicate.ts` already reached the same conclusion by brute force and
recorded `{"ok": false, "n": 3, "fair_wins": 1, "hard_wins": 1}`.

## Other things that make these runs hard to use

- **Arm ordering is confounded with the treatment.** Every control session runs
  before every treatment session, against a live API, so rate-limit and cache
  drift accumulate onto whichever arm goes last. `@eden/measure`'s `runPlan`
  interleaves and counterbalances instead, which costs no extra sessions.
- **The quality metric never discriminated.** It returned a perfect tie in every
  cell of every run — including one where the compiled tool fabricated every
  field it returned and still scored 3/3. `@eden/measure`'s `scoreRecords`
  scores per required field and puts a wrong value below an omitted one.
- **The surviving artifacts are selected.** `.WIN.json` files are written by no
  code in this repo; they are manual copies, and there is no `.LOSS.json` for
  any bench. `bench-rerun-with.ts` re-runs only the treatment arm against a
  frozen control, which at the measured run-to-run spread is enough on its own
  to flip a result.
- **The workshop domain cannot show a benefit.** `/shop/*` is served in-process
  by `forge.ts` on localhost, so there is no network round-trip for a compiled
  tool to save.

## What a run needs before it can be quoted

- ≥6 paired blocks (tasks × repeats), which is the resolution floor above.
- Interleaved, counterbalanced arm ordering.
- A reported confidence interval and a minimum detectable effect next to every
  point estimate.
- An A/A cell, with its own power stated — an A/A that merely fails to find bias
  has not shown there is none.

`@eden/measure` implements all four. `decide()` returns `INSUFFICIENT_DATA`,
`INDISTINGUISHABLE` or `UNTRUSTWORTHY_INSTRUMENT` in preference to a verdict it
cannot support.
