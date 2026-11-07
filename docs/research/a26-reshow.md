# A26: the decider for re-showing a candidate (D340 `pushReshow`)

Session A26, 2026-11-07, branch `claude/a26-reshow` from `claude/lucid-hypatia-v9wqk5` (A17 merged). Decision D380.
Every paid call went to the Anthropic API with `HAIKU_API_KEY` through the lab provider (D97), `OPENROUTER_API_KEY`
unset: **Anthropic-direct lab figures**, not the OpenRouter route the servers ship. Train only. **Spent: $0.759** of
the $1.20 cap.

## In plain words

- A17 found that Eden sometimes shows the agent a useful fact at the wrong moment (for an unrelated request), and
  then, because it never repeats itself, does not show it again when it matters. The fix, `pushReshow`, shows such a
  fact once more. A17 measured +6.8 points of hidden facts raised, but its interval reached below zero, so it set a
  rule (written down here before running): one fresh run on new users decides.
- **The fresh run did not confirm it.** On four new users over eight days each, both notice modes, the fix raised
  hidden facts by **+2.7 points (−1.8..+7.3, n 110)**: positive, but less than half of A17's gain. Pooled with A17, **+3.9
  (+0.01..+7.72)**: the interval clears zero by a hair (on the rounded bounds it touches it). A stronger grader (Sonnet 5.5) confirmed one more false concern
  with the fix than without (1 against 0, all from 16 Haiku-flagged answers).
- The fix also costs: +$0.018 per 1,000 tasks of agent tokens under payload notices, and extra connector reads under
  signal notices (5.48 → 5.56 Eden calls a task).
- **Decision: deleted (D380, under D112).** The concern condition failed as pre-registered; the pooled-interval
  condition sits on its edge (passes on exact bounds, fails on rounded ones), so the deletion rests on the concerns. The switch, its session
  state, its tests and its fuzz variant are gone; the default is unchanged (it was off).
- **One caveat.** The new users' cards had to be made in-run and no intent requests exist for them (the checked-in
  ones cover users 41–44 only), so both arms ran with intent inert; the comparison is paired, but it is not the exact
  shipped default with a key.

Status: decided (section 0 was written and pushed, commit `A26: pre-register…`, before any paid run).

## 0. Pre-registration

A17 (docs/research/a17-long-quality.md) left `pushReshow` an off trial: +6.8 points of hidden facts raised
(−0.5..+14.1, n 220, the shared baseline resampled as one cluster), concerns flat, +$0.013 per 1,000 tasks of agent
tokens on 8-day days. It named one fresh paired run as the decider. This is that run.

**Run.** `pi-ab --days 8 --tenant-prompt`, train suite only (never heldout9–17), arms `eden` and `eden+pushReshow`
in one process (paired task by task by `days.py`), Haiku 5.5 in every role through the Anthropic lab provider (D97),
`OPENROUTER_API_KEY` unset, ledger `.local/a26/ledger.jsonl` with a hard cap of $1.20. Fresh users: seeds 61–64 (w61–
w64), none of which A17 used (A17 ran w41–w44; D340's text named w41–w44, the task brief asked for new users, so the
decider departs from D340 on that point only). Payload notices on all four users; signal notices on the same users if
the ledger allows (each set is its own paired run against its own baseline arm, so no baseline is shared and no alias
is needed inside A26).

**Rule, fixed now:**

1. **Promote** `pushReshow` into `DEFAULT_CONFIG` if all three hold:
   - (a) the fresh run's paired hidden difference (eden+pushReshow − eden, all fresh sets pooled, bootstrap by task)
     is **≥ 0**;
   - (b) the **pooled** estimate (A17's n 220 + the fresh pairs) has a 95% interval that **excludes zero**;
   - (c) concerns are **not up** after a Sonnet 5.5 regrade of every control and neutral answer the Haiku grader
     called a concern in either arm (`regrade.ts --only-concerns --graders claude-sonnet-5-5`): "up" means the arm's
     confirmed concern count over control + neutral tasks exceeds the baseline's.
2. Otherwise **delete** the switch with its code and tests (D112): `pushReshow` in config.ts and config-check.ts,
   `handedBefore` and `Session.handedIn` in partner.ts, `push-reshow.test.ts`, the fuzz `reshow-flaky` variant, and
   the trials-table row.

**Pooling (b).** A17's per-task records (`.local/a17/runs`) are not in the repository, so they cannot be re-bootstrapped
here. The pooled estimate is therefore the fixed-effect inverse-variance combination of two independent estimates,
each already clustered: A17's +6.8 (−0.5..+14.1), SE = width / 3.92 = 3.72 points, and the fresh run's paired
bootstrap (no shared baseline task across the two, since the users differ). Pooled mean = Σ wᵢ·dᵢ / Σ wᵢ with
wᵢ = 1/SEᵢ², SE = 1/√Σwᵢ, interval ±1.96·SE. This treats A17's interval as normal; it is the honest substitute for
`days.py --alias` when one side's records are gone, and it is stated before the fresh number is known.

Cost and connector calls are reported, not part of the rule (A17 measured the price; D112's "no extra paid cost"
bar is met only by a measured gain, which is what (a)–(c) test).

## 1. Runs

```bash
packages/sim/lab/a26/run.sh a26-pay-61 payload --seeds 61 --days 8 --budget 0.2        # and 62, 63, 64
CARDS=.local/a26/cards-sig.jsonl packages/sim/lab/a26/run.sh a26-sig-61 signals --seeds 61 --days 8 --budget 0.2
python3 -I packages/sim/lab/a17/days.py --pair eden,eden+pushReshow .local/a26/runs/a26-{pay,sig}-6{1,2,3,4}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results .local/a26/runs/a26-pay-61.json \
  --graders claude-sonnet-5-5 --only-concerns --spend-ledger .local/a26/ledger.jsonl --spend-cap 1.2 ...  # each run
python3 -I packages/sim/lab/a26/concerns.py .local/a26/runs/a26-rg-*.json
python3 -I packages/sim/lab/a17/reshown.py .local/a26/runs/a26-{pay,sig}-6{1,2,3,4}       # reshown.txt
python3 -I packages/sim/lab/a26/pool.py 2.727 -1.818 7.273                               # pool.txt
bun packages/sim/src/lab/pi-cost-report.ts .local/a26/runs/a26-pay-6{1,2,3,4}.json      # and the sig runs
```

Users w61–w64: 8 days of 12–20 requests (1:1:8), 523 tasks an arm a mode (55 hidden, 55 look-alike, 413
nothing-to-add) and 32 recap days; Pi harness, Haiku 5.5 in every role, `--tenant-prompt`, direct market profile.
The payload runs made the 1,085 cards the checked-in files lacked (in-run, both arms alike); the signals runs replayed
them. Intent requests: none cover seeds 61–64, so both arms ran `[intent inert: no replay]`. Outputs in
`packages/sim/lab/a26/` (`days-pay.txt`, `days-sig.txt`, `days-all.txt`, `cost-*.txt`, `concerns.txt`, `pool.txt`, `reshown.txt`).

## 2. Results

Paired task by task (eden+pushReshow − eden, bootstrap 95%; each mode has its own baseline arm, no alias):

| set | hidden n | hidden Δ | control Δ | neutral Δ | agent $/1k Δ | wall Δ s |
| --- | --- | --- | --- | --- | --- | --- |
| payload | 55 | +0.0 (−7.3..+7.3) | +0.0 | +0.7 (−0.2..+1.9) | +0.018 (+0.013..+0.022) | +0.05 |
| signals | 55 | +5.5 (+0.0..+12.7) | +1.8 (+0.0..+5.5) | +0.5 (−0.7..+1.9) | −0.000 (−0.004..+0.004) | −0.02 |
| **both (fresh)** | 110 | **+2.7 (−1.8..+7.3)** | +0.9 (+0.0..+2.7) | +0.6 (−0.2..+1.5) | +0.009 (+0.006..+0.012) | +0.01 |
| **A17 + fresh, pooled (§0)** | 330 | **+3.9 (+0.01..+7.72)**¹ | | | | |

¹ From the fresh bootstrap's exact bounds (+0.0273, −0.0182..+0.0727: multiples of 1/110); on the bounds rounded as
`days.py` prints them, +3.8 (−0.01..+7.71). A17's own interval is rounded to 0.1, so (b) is on the rounding edge
(`pool.txt`).

- **By position.** Requests 1–4: +13.6 (+0.0..+27.3, n 22); requests 5 onward: +0.0 (−4.5..+4.5, n 88). A17 put the
  gain in requests 5 onward; here it is not there.
- **Mechanism.** A re-shown planted item was raised 5 of 5 times (A17: 45 of 55), but the opening is small on these
  users: a planted item left only earlier in the day was 31 of 110 hidden tasks in the baseline (28%; A17's 8-day
  days: 30%), and the switch moved few of them into the request's packet (payload: earlier-only 15 → 12,
  packet-now 25 → 28; signals 16 → 13, 24 → 27).
- **Concerns (rule c).** Haiku called 5 answers concerns in the eden arm and 11 with the switch; Sonnet 5.5 confirmed
  0 and 1 (`concerns.txt`). One is within noise, but the pre-registered bar was "not up", and it is up.
- **Recaps.** Stale recaps 16 → 13 over 64 paired days (−0.05 a day, −0.19..+0.09), fresh 112 → 112.
- **Cost, per plan (steady state $/1k).** Payload: first-party 0.249 → 0.258, Composio 0.290 → 0.300, Unified.to
  0.352 → 0.362. Signals: agent tokens flat, Eden connector calls 5.48 → 5.56 a task (plus 0.31 in the background in
  both), Composio 1.976 → 1.999, Zapier MCP 149.66 → 151.64; first-party 0.239 both.

**Rule:** (a) +2.7 ≥ 0, holds. (b) pooled +3.9 (+0.01..+7.72) on exact inputs, (−0.01..) on rounded ones: on the
edge, not a clear pass. (c) Sonnet-confirmed concerns 0 → 1, against a pre-registered bar of "not up": fails. **Delete**
(D380), on (c). The first draft of this note read (b) from the rounded inputs and called it failed; the review
caught it.

## 3. What was deleted

`pushReshow` (config.ts, config-check.ts), `Session.handedIn`, `MAX_HANDED_IN`, `handedBefore` and the hand-out
bookkeeping in `handOut` (partner.ts), `candidatesOf`'s `like` set (only the re-show read it), `push-reshow.test.ts`,
the fuzz `reshow-flaky` variant and the harness's request counter that only it needed (fuzz-world.ts), the trials-table
row; ARCHITECTURE.md and the engine's CLAUDE.md say it is gone. The lab scripts (`days.py`, `reshown.py`) stay: they
read any `pi-ab --days` run.

## 4. Checks

- `bun run check`: green (2,299 tests, 0 fail) on the final tree.
- `bun run eval`: identical to the base apart from latency (precision 0.591, recall 0.52, falseFireRate 0).
- `bun run funnel --jobs 4`: hidden surfaced 314, decoys 273, as the base.

## 5. Spend

| label | what | $ |
| --- | --- | --- |
| a26-pay-6x | payload, eden vs eden+pushReshow, 4 users (incl. in-run cards) | 0.4046 |
| a26-sig-6x | signals, same | 0.3365 |
| a26-rg-* | Sonnet 5.5 regrade of 16 concern answers | 0.0176 |
| total | | 0.7587 |
