# Bounded rule retention (2026-11-22)

`syncKeepRules` is adopted, on by default. It uses the reader gate's cached constraint-wording test (`gateOf`, without
visits) to reserve up to one quarter of `syncMaxItems`, newest first. The existing engaged-source reserve then takes
up to half the cap; at least a quarter remains for recency. This adds a linear pass, not another sort, to the trim's
existing recency sort. It does not enlarge the cap, extend TTLs, change admission or fetch older pages to find rules.
The signal is deliberately heuristic, not a determination that a rule remains applicable.

## Offline measurement

Base: `49fb22b9f`. Four independent seeds, ten hidden tasks and ten controls each, at each scale. No ledger writes.
The direct hidden funnel isolates push/sync behavior without card or intent replay, explicit ask or a model checker.
These are not live-reader uptake measurements. Calls/task includes hidden and control task windows, not initial
backfill. Sources use `--time 0`.

```sh
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden --seeds 41,42,43,44 --noise-sources 995 --serial --time 0 --config '{"syncKeepRules":false}' --label diag-1122-trim --no-record --json before.json
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden --seeds 41,42,43,44 --noise-sources 995 --serial --time 0 --config '{"syncKeepRules":true}' --label diag-1122-trim --no-record --json after.json
```

Repeat with `--noise-sources 3000` (3,005 total sources). The adopted default flag value is true. An external preload
observed trim victims and cache presence at each user-message arrival; the harness's `hiddenCached` is later, after
the request's work, so background/probe recovery can make it higher than arrival-time cache presence.

| Noise sources | Hidden cached | Hidden delivered | Decoy delivered | Calls/task      |
| ------------- | ------------- | ---------------- | --------------- | --------------- |
| 995           | 38/40 → 40/40 | 32/40 → 32/40    | 12/40 → 12/40   | 9.5625 → 7.1875 |
| 3000          | 37/40 → 40/40 | 32/40 → 32/40    | 12/40 → 12/40   | 7.8250 → 6.2375 |

Counts below are planted hidden items ever trimmed before their request / trimmed and still absent at arrival.
Each cell has ten hidden tasks. An item can be fetched again between trim and its request.

| Noise | Seed | Before | Flag on |
| ----- | ---- | ------ | ------- |
| 995   | 41   | 3 / 0  | 0 / 0   |
| 995   | 42   | 3 / 1  | 0 / 0   |
| 995   | 43   | 2 / 1  | 0 / 0   |
| 995   | 44   | 1 / 0  | 0 / 0   |
| 3000  | 41   | 10 / 3 | 3 / 1   |
| 3000  | 42   | 10 / 3 | 3 / 1   |
| 3000  | 43   | 10 / 1 | 3 / 1   |
| 3000  | 44   | 10 / 1 | 3 / 1   |

At 995, the two unrecovered losses were legal-hold (42/43). At 3000, the eight arrival-time losses were calendar-clash
(all seeds), legal-hold (41/42), and discount-cap (41/42). Flag on leaves only calendar-clash absent at arrival; those
calendar items lack the constraint wording this reserve uses. The legal policies remain undelivered even when kept:
their request names a person and SSO, while the policy names the company and MSA. Retention alone does not bridge
that lexical gap. Both discount-cap misses likewise persist in this no-card push screen.

Quality commands, each with `--config '{"syncKeepRules":false}'` and `--config '{"syncKeepRules":true}'`:

```sh
bun packages/sim/src/quality-cli.ts --users 4 --sessions 10 --seed 13 --judge local --brief
bun packages/sim/src/quality-cli.ts --users 4 --sessions 10 --seed 7 --judge local --brief
```

| Seed | Recall      | Precision   | False-fire rate |
| ---- | ----------- | ----------- | --------------- |
| 13   | .826 → .826 | .532 → .532 | .071 → .071     |
| 7    | .753 → .753 | .513 → .513 | .067 → .067     |

All quality overall metrics were unchanged. Adopted default-on: at 3000 noise sources, hidden cached rises from
37/40 to 40/40 and request-window calls fall from 7.8250 to 6.2375 (20.3%), with delivery and precision flat. There is
**no delivered recall gain** on either scale. These synthetic noise sources contain no policy language; the
bounded-reserve test, not this corpus, covers an adversarial abundance of constraint wording.
