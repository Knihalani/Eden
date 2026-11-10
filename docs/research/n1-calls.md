# N1: fewer connector calls at 1,000 sources (learned source yield, a lazy push, search reuse, batched probes)

Status: 2026-11-10, branch `claude/n1-calls` (from `claude/lucid-hypatia-v9wqk5` at 3e10a6fe). Decisions D505–D509.
Paid calls: Anthropic API only, the Modal Secret `HAIKU_API_KEY`, `claude-haiku-5-5` in every role, lab provider
(D97): **Anthropic-direct lab figures**, not the OpenRouter route the servers ship. Train suites only; `heldout18` is
not run or read. The local-copy approach (F1's cold tier) is rejected by the owner and is not used or extended here:
nothing in this note keeps an item past the user's cap.

## 0. Pre-registration (committed and pushed before any paid call)

**The problem.** With about 1,000 connected sources Eden makes ~40 connector calls a task (A21, C4, F1), which on a
connector platform that bills per call is ~$1,100 per 1,000 tasks on Zapier MCP against ~$91 for the agent alone.

**What the $0 screens already showed (section 2; every figure there is from a command run in this session).** Four
hypotheses were built as trial switches and screened with no model:

| Hypothesis | Switch | $0 result | Goes live? |
| --- | --- | --- | --- |
| H1 learned per-source yield | `sourceYield` | calls 47.3 → 27.3 and 48.0 → 25.2 a task (short), 57.2 → 9.7 a request (8 days), no hidden fact lost, stale and deleted deliveries not up | yes |
| H2 lazy push | `pushLazy` 1 | calls 47.3 → 29.3 and 48.0 → 29.5 (short), 57.2 → 32.6 (8 days); surfaced facts level only because the screen asks once a request; stale deliveries 15 → 19 of 142 | yes, to measure what the push's searches buy; it already fails the stale rule |
| H3 search reuse within N minutes | `searchFreshMs` 30 min | calls 47.3 → 47.3, 57.2 → 57.2: a user's searches do not repeat | no: deleted (D507) |
| H4 one search of a source a lookup | `probeBatch` | calls 47.3 → 49.3, 48.0 → 49.8: the probes' budget is spent on other sources | no: deleted (D508) |

**Harness.** Pi (`pi-ab.ts`), `--config default`, `--tenant-prompt`, market `direct` source profile, time scale 1,
`--push payload`, `--noise-sources 995`, `--connector-mix 0.05,0.05` (5% of connectors push and have a change feed, 5%
a feed only, 90% neither: the owner's estimate, an assumption), `claude-haiku-5-5` in every role, cards `cards-v2` +
`cards-train` + `cards-train-4344` and the checked-in intent requests replayed. Suites `train`, one seed a shard on
Modal (`packages/sim/lab/n1/go.sh`), at most two Anthropic shards at a time.

**Arms** (one process runs all arms of its shard, paired task by task):

| arm | settings over the default |
| --- | --- |
| `eden` | none (the shipped default) |
| `eden~yield` | `{"sourceYield":true}` |
| `eden~lazy` | `{"pushLazy":1}` |

**Runs.**

1. **Short** (one request a session): `--limit 16 --variants hidden,control`, six train suites, seeds 41–44: 96 hidden
   and 96 control tasks a seed an arm (384 hidden pairs an arm).
2. **Long**: `--days 8`, one user a seed, seeds 41–46 (about 132 requests a user: about 14 hidden, 14 control, 104
   neutral).
3. **Regrade**: every control and neutral answer the Haiku grader called a concern, in every arm, with
   `claude-sonnet-5-5` (`regrade.ts --only-concerns`); Sonnet's verdict replaces Haiku's.

**Metrics** (effect = arm − `eden`, paired): hidden facts raised (points); regraded concerns on control and neutral
tasks; Eden's connector calls a task (in the task's window, and with its background); $ per 1,000 tasks first-party
and priced on the connector plans (`pi-cost-report.ts`, market.py's list prices, assumed); wall mean and Eden's time
on the agent's path. Intervals: 95% bootstrap with **templates resampled as clusters** (`bench_report.py`, 5,000
draws) for hidden facts, concerns, $ and wall; the task-level paired bootstrap of `a8/pair.py` for connector calls.
Reported per horizon and pooled.

**Rule (applied mechanically, per lever).** Promote into the default only if all hold:

- **hidden not worse:** the pooled hidden effect's point estimate is ≥ −2.0 points and its template-clustered
  interval is not entirely below zero;
- **calls fall:** the paired effect on Eden's connector calls a task has an interval entirely below zero on both
  horizons;
- **stale and deleted deliveries do not rise:** `quality-cli` (16 users × 20 sessions, 213 updates, 128 deletions,
  5/5/90, signal-only notices, 0% and 20% of notices lost): stale delivered, deleted delivered and deleted cited each
  at or below the default's count (already measured at $0: section 2);
- **concerns not up:** the pooled regraded concern effect's interval is not entirely above zero;
- **no extra paid cost (D112):** the pooled first-party $/1k interval is not entirely above zero.

Otherwise the switch, its code and its tests are deleted in this branch and the result stays in this note. With
about 470 hidden pairs the hidden interval will be several points wide: "not worse" means no sign of a loss at that
resolution, and the note will say what the run could have detected.

**Spend.** Anthropic hard cap $8 in all for this session, as per-shard caps: short $2.4 (4 shards), long $2.4 (6
shards), regrade at most $0.3. Modal credits under $15.
