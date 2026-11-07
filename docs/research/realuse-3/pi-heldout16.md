# RealUse-3 on Pi: the CL wave's blind check on heldout16

## Pre-registered rule (written and committed before any heldout16 result was read)

The final product keeps `pushCandidates` 5 unless, pooled over the short and long payload runs (seeds 41–44),
`eden − eden~reader` hidden raised has a 95% interval entirely below zero with a point estimate worse than −5 points,
or the regraded false + neutral concerns (`eden − eden~reader`, pooled over control and neutral tasks, paired by task)
rise with a 95% interval excluding zero. In either case the recommendation is to revert to `pushCandidates` 0. The
rule is applied mechanically.

Arms: `tools` (the agent alone with its source tools), `eden` (the default: candidates, D237), `eden~reader`
(`pushCandidates` 0: the reader's push with D240's stop-early). Long mode: `--days 2 --day-size 16` (heldout16 holds
32 templates and pi-user draws each once per user: 4 hidden, 4 control, 24 neutral a user).

(Results below.)
