# M1: the lab at scale on Modal (power for today's part decisions)

Status: 2026-11-10, branch `claude/m1-lab-scale` (from `claude/lucid-hypatia-v9wqk5` at 322a5585, which carries M0's
`packages/sim/modal/`). Decisions D440–D444. **Measurement only: no engine file changes, no default changed.**

## 0. Pre-registration (committed and pushed before any paid call)

**Why.** Most of the parts promoted on 2026-11-07 rest on two seeds, with intervals that touch zero (askNudge D317,
planConflict D301, pushCandidatesSettled D404, revisionDiff D342). Modal's parallel CPU containers make eight seeds
affordable in wall time. This run measures each part's paired effect on the train suites with eight seeds and
reports whether any part now measurably hurts. It changes nothing in the default: a part that hurts is listed as a
recommendation for its own trial.

**Suites.** `train` only (train1–6). No held-out suite is run or read.

**Harness.** Pi (`pi-ab.ts`), `--config default`, `--tenant-prompt` (D271) in every arm, market `direct` source
profile, time scale 1, `--push payload`, `claude-haiku-5-5` in every role (agent, grader, cards, intent, reader),
`claude-sonnet-5-5` only to regrade concerns (`regrade.ts --only-concerns --graders
claude-haiku-5-5,claude-sonnet-5-5`). Anthropic only, the Modal Secret `HAIKU_API_KEY`, one seed a shard
(`lab_fanout.py`), each shard on its own ledger with cap/N.

**Seeds.** 41–48. Cards: the three checked-in card files concatenated (`cards-v2`, `cards-train`,
`cards-train-4344`) are replayed; they and the checked-in intent requests (`intent-v2.jsonl.gz`) cover seeds 41–44.
**For seeds 45–48 no cache covers the worlds: every card and its intent requests are made in-run by Haiku** (each
shard makes its own, shared by its arms), and the header labels those runs `[intent inert: no replay]` because no
file is replayed, though the live card calls write requests for the items they card. So 45–48 measure the default
with in-run enrichment (closer to production, and dearer), 41–44 with replayed enrichment; both are reported per seed
group as well as pooled.

**Arms** (one process runs all arms of its shard, paired task by task). The variants are `--variant-config` entries
copied from `PARTS` in `@eden/engine` (`default minus <part>`, D112):

| arm                    | what                                                                                                              | short | long |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ----- | ---- |
| `tools`                | the agent alone with its source tools                                                                             | yes   | yes  |
| `eden`                 | the shipped default                                                                                               | yes   | yes  |
| `eden~minus-nudge`     | minus `nudge` (`askNudge` off, D317)                                                                              | yes   | yes  |
| `eden~minus-plans`     | minus `plans` (`planConflict` off, D301)                                                                          | yes   | yes  |
| `eden~minus-fewer`     | minus `fewer` (`pushCandidatesSettled` 0, D404)                                                                   | yes   | yes  |
| `eden~minus-freshness` | minus `freshness` (`revisionDiff`, `revisionNotice`, `verifyDelivery`, `readerVerifyAfter` off; D342, D205, D126) | no    | yes  |

`parties` (`partyCheck`, D376) is **skipped**: plain pi-ab gives the agent no acting tools and calls `checkAction` only
in `-act-firewall` conditions, so the part is inert in these runs. `freshness` runs on the long horizon only (an
"updated:" packet needs a change between requests of one user).

**Runs.**

1. **Short** (one request a session): `--variants hidden,control`, 384 tasks a seed an arm (192 hidden, 192
   control), one suite a shard: 6 suites × 8 seeds = 48 shards. Neutral tasks are left out of the short horizon to
   fit the cap; the long horizon carries the neutral concerns (104 a user).
2. **Long** (a user's days): `--days 8` (default day sizes), one user a seed: 8 shards, about 132 tasks a user
   (about 14 hidden, 14 control, 104 neutral).
3. **1,000 sources**: the default (`eden` only) at `--noise-sources 995`, short, hidden + control, seeds 41–44, one
   suite a shard (24 shards, 24 GiB). Its 5-source pair is run 1's `eden` arm on the same tasks (cross-run, same
   commit and harness; labelled so).
4. **Regrade**: every control and neutral answer the Haiku grader called a concern, in every arm, Haiku + Sonnet
   (`regrade.ts --only-concerns`); kept when both keep it, Sonnet's verdict on disagreement.

Before the full fan-out one tiny shard runs end to end (train1, seed 41, `--limit 4`, `tools,eden`, cap $0.05) to
prove the image, the Secret and the merge.

**Spend.** Anthropic hard cap **$10 in all**, as per-shard caps that sum to at most $10 (smoke $0.05; the shard caps
of runs 1–3 are set from the smoke's measured cost per task, with the largest share to seeds 45–48's in-run cards;
regrade capped at what is left, at most $0.30). Modal spend is reported from the dashboard/billing figures and kept
under $60. A shard that hits its cap stops early; its tasks are dropped from the pairs it did not finish and the note
says how many.

**Amendment before the main runs (after the smoke shard, before any main-run call).** The smoke shard (train1 seed 41,
`--limit 4`, `tools,eden`, 16 task runs) spent $0.0058, about $0.00036 a task run. At that rate the plan above costs
about $10 before cards and the regrade, so: the short horizon runs `tools` on seeds 41–44 only (its four part arms on
all eight seeds; part effects are read against `eden`, which every shard has), and the 1,000-source check runs hidden
tasks only (`--variants hidden`). Caps: short 41–44 $3.20 (24 shards), short 45–48 $2.80 (24 shards), long $3.20 (8
shards), 1,000 sources $0.45 (24 shards), regrade at most $0.30; with the smoke, $9.96 at most.

**Deviation during the runs (recorded before the short part pairs on 45–48 were read).** All four runs went at once on
one key, so each short shard (about 60 agent streams: 12 worlds × 5 arms) met Anthropic's concurrent-request limit:
1,500–1,900 retried 429s a shard, 122 tasks lost to it and mean wall about 11 s (p50 4.3 s) against 2 s over days.
Hidden facts and concerns stay paired (a task an arm did not finish is dropped from every arm's pair), but the short
runs' wall time is the retry backoff, not the agent. The long horizon (about 5% of requests retried) and the
1,000-source run (almost none) are not affected. So the short horizon's wall and the 1,000-source wall pair come from
a **wall-only rerun**: one shard at a time, `--limit 6` a world (72 tasks a seed), all short arms, seeds 41–48, and the
default at 995 sources on seeds 41–44 with the same tasks; its hidden and concern counts are not pooled with the
main runs. The 1,000-source shards also hit their $0.018 caps (Eden's card calls for noise items cost more than
estimated): 208 of 768 hidden tasks did not run, so its hidden pair rests on the 543 tasks both runs graded.

**Metrics.** Hidden facts raised; false concerns on control (short and long) and neutral (long), Haiku-graded and
after the regrade; $ per 1,000 tasks (agent billed + Eden per task + background cards spread over the arm's task
runs; the short horizon over its hidden + control tasks, the long horizon over the user's mixed days) and the
connector-plan rows of `pi-cost-report.ts`; wall mean and p50; Eden on the critical path (ms a task, the union of its
path spans); connector calls a task. Per part: the paired difference `eden~minus-X − eden` (and every arm against
`tools`) with **bootstrap 95% intervals, 5,000 draws, tasks resampled within each seed (and kind)**, pooled over the
8 seeds, per horizon, and for hidden facts pooled over both horizons. 41–44 and 45–48 are also shown apart.

**Rules (applied mechanically).** For each part X, read `eden~minus-X − eden` (removing the part):

- The part **helps on hidden facts** if the hidden interval is entirely below zero; **hurts on hidden facts** if
  entirely above.
- It **hurts on concerns** if the regraded control + neutral concern interval is entirely below zero (fewer concerns
  without it); it **helps on concerns** if entirely above.
- It **costs** if the $/1k interval is entirely below zero (cheaper without it); it **slows** if the wall-mean
  interval is entirely below zero.
- A part is **flagged as hurting** if it hurts on hidden facts or on concerns (pooled where pooled, else on either
  horizon). A part that costs or slows but is not shown to help on hidden facts is **flagged as a cost without a
  measured gain**. Each flag becomes a recommendation (a trial to remove or reshape it), never a change made here.
- The 1,000-source check: hidden facts at 995 against 5 (`eden` both): **held** unless the interval is entirely
  below zero; latency and connector calls reported with intervals.
- Today's two-seed estimates are compared side by side with the eight-seed ones (direction kept or not; interval
  now excluding zero or not).
