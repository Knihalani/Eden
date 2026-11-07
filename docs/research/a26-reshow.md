# A26: the decider for re-showing a candidate (D340 `pushReshow`)

Status: pre-registered (this section was written and committed before any paid run).

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
