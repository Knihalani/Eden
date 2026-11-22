# Offline push-check proxies

Measured from main `d997514da` plus the lab-only oracle implementation. No engine behavior or feature defaults changed.

Historical default-off measurements: D2106 now defaults both seat flags on using
the later signature fix's evidence in [check-seat-defaults.md](check-seat-defaults.md).
To reproduce the seat arms below on current main, explicitly set both flags
false for `default`, only stem true for `stem`, only org true for `org`, and both
true for `both`; an omitted flag now defaults true.

## Modes

`hidden-funnel --check oracle|noisy` feeds JSON through the real `PushChecker` parser, verdict cache and delivery path.
Neither mode needs a key or `--check-cache`. Each check snapshots the session's task labels and candidate IDs in
async-local context; overlapping checks do not share mutable current-task state. Only the current task's planted
hidden item is positive; the control decoy, neutral items and other candidates are negative.

Oracle uses TP=1/FP=0. Noisy defaults to `--check-tp .85 --check-fp .05`, matching quality's rates. A deterministic
draw hashes suite/seed/variant/template/item ID, independent of pool order and noise size. FP applies to all negative
candidates, not just the planted decoy. Sheet-only rules use the same labels and draws. Every model reply reports
`costUsd: 0`; its generic `on: "oracle proxy"`, `hits: "this request"` never quotes gold details.

JSON summaries now include `total.hidden.pool` and `total.control.pool`; the console prints a `POOL` line. Ledger
metrics include `hiddenPool`/`decoyPool`. Proxy runs recorded deliberately use a proxy-specific default label and
note, not the ordinary baseline label. All measurements below used **`--no-record`**, without ledger labels.

## Measurement

Direct ten-template hidden suite, seeds 41–44, default engine config except the named seat flags. No cards, ask,
reader or live judge; simulated source latency zero. Each row has **40 hidden and 40 control tasks**. Calls/task is
connector request-window calls (searches and on-demand listings) over all 80 tasks, not checker calls or background sync.

| Noise sources | Checker | Seats   | Hidden returned | Cached | Pool | Delivered | Decoy delivered | Calls/task |
| ------------: | ------- | ------- | --------------: | -----: | ---: | --------: | --------------: | ---------: |
|           995 | oracle  | default |               4 |     40 |   32 |        32 |               0 |     6.8500 |
|           995 | oracle  | stem    |               4 |     40 |   36 |        36 |               0 |     6.8500 |
|           995 | oracle  | org     |               4 |     40 |   34 |        34 |               0 |     6.8500 |
|           995 | oracle  | both    |               4 |     40 |   38 |        38 |               0 |     6.8500 |
|           995 | noisy   | default |               4 |     40 |   32 |        27 |               1 |     6.8750 |
|           995 | noisy   | stem    |               4 |     40 |   36 |        30 |               1 |     6.9000 |
|           995 | noisy   | org     |               4 |     40 |   34 |        28 |               1 |     6.8500 |
|           995 | noisy   | both    |               4 |     40 |   38 |        31 |               1 |     6.9000 |
|          3000 | oracle  | default |               4 |     40 |   32 |        32 |               0 |     6.0625 |
|          3000 | oracle  | stem    |               4 |     40 |   36 |        36 |               0 |     6.1250 |
|          3000 | oracle  | org     |               4 |     40 |   34 |        34 |               0 |     6.1250 |
|          3000 | oracle  | both    |               4 |     40 |   38 |        38 |               0 |     6.1250 |
|          3000 | noisy   | default |               4 |     40 |   32 |        27 |               1 |     6.1750 |
|          3000 | noisy   | stem    |               4 |     40 |   36 |        30 |               1 |     6.1250 |
|          3000 | noisy   | org     |               4 |     40 |   34 |        28 |               1 |     6.1750 |
|          3000 | noisy   | both    |               4 |     40 |   38 |        31 |               1 |     6.1250 |

All 16 runs made active checker calls, with zero failures and zero model cost. Stem seats recover all four
discount-cap tasks under the perfect oracle; org seats recover legal-hold for seeds 41/42. With both, legal-hold
for seeds 43/44 still misses the pool. Under noisy draws, net delivery gains are +3/+1/+4 for stem/org/both.

Reproduce each row with N=995/3000, MODE=oracle/noisy and CONFIG equal to `{}`,
`{"pushConstraintStemSeats":true}`, `{"pushPartyOrgLink":true}`, or both keys true:

```sh
bun packages/sim/src/lab/hidden-funnel.ts \
  --suite hidden --seeds 41,42,43,44 --noise-sources "$N" \
  --serial --time 0 --no-record --check "$MODE" --config "$CONFIG" \
  --json "$OUT.json" --check-dump "$OUT-checks.jsonl"
```

For noisy rows explicitly add `--check-tp .85 --check-fp .05`. Original artifacts are under
`~/diag-1122/oracle-{995,3000}-{oracle,noisy}-{default,stem,org,both}.{json,log}`, with check dumps alongside them.

## Limits

These are **retrieval/applicability ceilings, not uptake or checker-accuracy measurements**. Perfect rejection of
decoys is by construction; noisy errors are synthetic and pool-independent, not calibrated model errors. The
oracle judges IDs even if a real checker could not read enough evidence in a truncated excerpt. Zero latency does
not test late-check behavior. Generic links exercise checked-why framing but cannot establish explanation quality.
Delivered means citation delivery, not that an agent understood or acted on it. No agent ran here; these are not
lh10's heldout ten-day results. Returned counts only request-time connector search, excluding sync/local answers,
so it is not total acquisition recall. These pre-signature-fix results alone did not justify adoption;
D2106 records the later free check-only evidence and its no-paid-confirmation caveat.
