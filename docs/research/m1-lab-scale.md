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

## In plain words

**Spent: $7.66 Anthropic** of the $10 cap (runs $7.57, regrade $0.09; `manifest-*.json`, ledgers), **Modal
$1.54** of credits for this session's apps (`modal billing report`, workspace figures, hourly buckets). Anthropic-direct
lab figures (D97), Haiku 5.5 in every role. 53 Modal containers in all; the long horizon's 8 seeds took 5–8 minutes
of wall time (one container a seed), the short runs 3–10.

- **No part measurably hurts.** Taking out the nudge, plan alerts, fewer candidates or freshness never raised hidden
  facts or lowered regraded concerns with an interval clear of zero, on either horizon or pooled. Nothing is flagged
  as hurting.
- **Eight seeds show the parts are much smaller than their two-seed estimates.** Pooled over both horizons and 8
  seeds (n = 1,496 hidden pairs), removing each part moves hidden facts by **nudge −1.3 points (−3.3..+0.6), plans
  +1.2 (−0.6..+3.0), fewer +0.1 (−1.8..+1.9)**; freshness (long only, n = 101) +3.0 (−2.0..+8.9). D317's train
  estimate for the nudge was +5.8 Haiku-graded (+1.9..+9.9) and +9.2 Sonnet-graded; here its gain is at most about
  3 points (Haiku-graded; the hidden answers were not regraded, see below).
- **Two parts cost without a measured gain (the rule's second flag).** The **nudge** costs $0.012/1k over a user's
  days (−0.015..−0.009 without it) and **0.18 s a task** one request a session (−0.27..−0.10, from the clean wall
  rerun); one request a session it is not dearer (removing it costs +$0.005, +0.001..+0.009). **Freshness** costs
  $0.004/1k over days (−0.008..−0.000), about a fortieth of a cent per user-day; its purpose (recaps that name
  dropped times, D342) is not graded by this design.
- **`fewer` is confirmed with eight seeds:** it saves **$0.011/1k pooled (+0.008..+0.015 without it)**, $0.015
  short and $0.000 over days, with hidden facts level (+0.1, −1.8..+1.9).
- **`plans` is not exercised here.** Plan alerts fire on items stored after a request; the runs used no `--late`
  arrivals, so its null is no evidence either way. D301's evidence (`--late`, 7 of 16 against 0) stands untested.
- **The default against the agent alone holds with eight seeds** (long, 8 seeds): hidden **+55.4 points
  (+45.5..+64.4)**, **0.70 s faster** (−0.86..−0.55), **+$0.035/1k** first-party (+0.028..+0.044), regraded concerns
  0; short, seeds 41–44: +55.6 (+51.7..+59.5), +$0.011/1k (+0.003..+0.019); short clean wall rerun (41–44): **1.17 s
  faster** (−1.36..−0.97). Every per-call connector plan makes the default cheaper (Composio −$0.29/1k long, −$0.44
  short; Zapier MCP −$26.8/1k long, −$38.8 short).
- **1,000 sources: hidden facts held, but Eden is on the critical path and the connector bill explodes.** At 995
  noise sources against 5 (same tasks, seeds 41–44): hidden 65.2% against 66.1% (−0.9, −4.4..+2.8, n = 543); Eden's
  path **+555 ms** (+497..+614) a task and **~42 connector calls** a task against 0; first-party $/1k +$0.18
  (+0.17..+0.20). The clean rerun: the agent **0.75 s slower** than at 5 sources (+0.50..+0.99), Eden's path +670 ms.
  On per-call plans the default at 1,000 sources costs $16.7/1k (Composio) and $1,393/1k (Zapier MCP) steady, against
  $0.42 and $16.2 at 5.
- **Seeds 45–48 (cards made in-run) score lower than 41–44 (replayed)** in every arm with Eden: hidden 53.7% against
  64.5% for `eden` short, Eden's path 44 ms against 11 (live card calls running beside the requests). The part
  effects do not differ by group (all intervals overlap zero in both).

## 1. Runs

Pi, `--config default`, `--suite train`, `--tenant-prompt`, `direct` profile, time scale 1, `--push payload`, Haiku 5.5
in every role; `--variant-config` from `PARTS` (`.local/m1/go.sh`). One seed a shard; the main runs put all six train
suites in one shard (the fan-out was invoked with `--suites train`, one suite name), the 1,000-source run one suite
a shard.

| run                 | shards | arms                                                    | tasks a seed an arm          | $       | notes                                          |
| ------------------- | ------ | ------------------------------------------------------- | ---------------------------- | ------- | ---------------------------------------------- |
| smoke               | 1      | tools, eden                                             | 8 (`--limit 4`)              | 0.006   | image, Secret, merge                           |
| long                | 8      | tools, eden, minus nudge/plans/fewer/freshness          | ~132 (`--days 8`)            | 1.907   | ~5% requests retried (429), 1 ungraded         |
| short 41–44         | 4      | tools, eden, minus nudge/plans/fewer                    | 384 (hidden, control)        | 2.202   | 1,500–1,900 retried a shard; 238 lost          |
| short 45–48         | 4      | eden, minus nudge/plans/fewer                           | 384                          | 1.926   | 384–896 retried; 47 ungraded                   |
| 1,000 sources       | 24     | eden, `--noise-sources 995`                             | 32 a suite (hidden)          | 0.322   | shard caps hit: 208 of 768 not run             |
| wall rerun          | 8      | tools, eden, minus nudge/plans/fewer, `--limit 6`       | 72                           | 0.930   | one shard at a time, 0 retried; 65 cut by caps |
| wall 1,000 sources  | 4      | eden, `--noise-sources 995`, `--limit 6`                | 72                           | 0.182   | one at a time                                  |
| regrade             |        | Haiku + Sonnet, concerns only (77 answers)              |                              | 0.090   | Sonnet kept 8 of 77                            |

## 2. Part effects (`eden~minus-X − eden`; bootstrap 95%, 5,000 draws, tasks resampled within seed and kind)

Hidden and concerns in points; $ per 1,000 tasks (agent billed + Eden per task + background cards); wall s. `*` the
interval excludes zero. Short = seeds 41–48 pooled from the two main runs (n 1,395 hidden, 1,407 control); long = 8
users (101 hidden, 101 control, 786 neutral); wall = the clean rerun (n 260 hidden, 251 control).

| part      | hidden, short          | hidden, long          | hidden, pooled         | regraded concerns, short / long | $/1k short               | $/1k long                 | wall s (clean rerun)       |
| --------- | ---------------------- | --------------------- | ---------------------- | ------------------------------- | ------------------------ | ------------------------- | -------------------------- |
| nudge     | −1.5 (−3.5..+0.6)      | +1.0 (−5.0..+6.9)     | −1.3 (−3.3..+0.6)      | −0.2 (−0.5..0) / 0 (0..0)       | +0.005 (+0.001..+0.009)\* | −0.012 (−0.015..−0.009)\* | −0.18 (−0.27..−0.10)\*     |
| plans     | +1.3 (−0.6..+3.2)      | 0.0 (−5.9..+5.9)      | +1.2 (−0.6..+3.0)      | −0.1 (−0.4..0) / +0.1 (0..+0.3) | −0.002 (−0.007..+0.002)  | +0.001 (−0.003..+0.005)   | +0.03 (−0.04..+0.11)       |
| fewer     | −0.3 (−2.2..+1.7)      | +5.0 (−1.0..+10.9)    | +0.1 (−1.8..+1.9)      | −0.2 (−0.5..0) / 0 (0..0)       | +0.015 (+0.011..+0.020)\* | +0.000 (−0.004..+0.003)   | −0.03 (−0.11..+0.06)       |
| freshness | —                      | +3.0 (−2.0..+8.9)     | —                      | — / +0.2 (0..+0.6)              | —                        | −0.004 (−0.008..−0.000)\* | —                          |

By seed group (short): seeds 41–44 nudge −0.7 (−3.7..+2.2), plans +2.5 (0.0..+5.2), fewer +0.7 (−2.4..+3.8); seeds
45–48 nudge −2.2 (−4.9..+0.4), plans +0.1 (−2.6..+2.8), fewer −1.3 (−3.9..+1.4) (`short-parts-41-44.txt`,
`short-parts-45-48.txt`). Eden's path does not move with any part (≤1 ms).

**The rule, applied.** Hurts on hidden facts: none. Hurts on concerns: none (no regraded interval is entirely below
zero). Costs: nudge (long $), freshness (long $); slows: nudge (short wall). Helps on hidden facts: none with an
interval clear of zero. So **nudge and freshness are flagged "a cost without a measured gain"**; nothing is flagged as
hurting.

## 3. Today's two-seed figures against eight seeds

| part      | earlier estimate (seeds, suite)                                         | eight seeds, train (this run)                 | direction kept? | now excludes zero? |
| --------- | ----------------------------------------------------------------------- | --------------------------------------------- | --------------- | ------------------ |
| nudge     | D317: +5.8 Haiku (+1.9..+9.9), +9.2 Sonnet; A29 blind: +12.5 (+1.4..+23.6) | +1.3 (−0.6..+3.3) pooled, Haiku               | yes, smaller    | no                 |
| fewer     | D404: hidden +5.8 (−0.6..+12.3); $ −0.008 short, −0.013 long             | hidden −0.1 (−1.9..+1.8); $ −0.015 short\*, 0.000 long | $ yes (short); long no | $ short yes |
| plans     | D301: late facts 7/16 vs 0 (`--late`)                                    | not exercised (no late arrivals)              | —               | —                  |
| freshness | D342: hidden −1.1 (−8.7..+6.5), $ −0.001 (−0.004..+0.002)                | hidden −3.0 (−8.9..+2.0), $ +0.004\*          | level           | $ yes (small)      |

(Signs here are the part's effect, `eden − eden~minus-X`.)

## 4. The default against the agent alone, and at 1,000 sources

| horizon / run                    | hidden (points)        | regraded concerns | $/1k first-party       | wall mean s             | Eden path ms | conn a task |
| -------------------------------- | ---------------------- | ----------------- | ---------------------- | ----------------------- | ------------ | ----------- |
| long, 8 users                    | +55.4 (+45.5..+64.4)\* | 0.0               | +0.035 (+0.028..+0.044)\* | −0.70 (−0.86..−0.55)\* | 8            | −1.19\*     |
| short, seeds 41–44 (main)        | +55.6 (+51.7..+59.5)\* | 0.0               | +0.011 (+0.003..+0.019)\* | (429-bound, not read)  | 11           | −2.12\*     |
| short, clean wall rerun 41–44    | +66.7 (+58.3..+75.0)\* | +2.1 (graded only) | +0.029 (+0.011..+0.047)\* | −1.17 (−1.36..−0.97)\* | 14 | −2.19\*     |

Connector plans (`cost-*.txt`, `pi-cost-report.ts`, list prices, assumed), eden − tools steady $/1k: long first-party
+0.023, Composio −0.289, Zapier MCP −26.8; short (41–44) +0.011, −0.441, −38.8.

**1,000 sources** (`scale.txt`; eden at 995 against eden at 5, same tasks, seeds 41–44):

| pair                         | n   | hidden (points)    | Eden path ms           | conn a task        | $/1k first-party        | wall mean s             |
| ---------------------------- | --- | ------------------ | ---------------------- | ------------------ | ----------------------- | ----------------------- |
| main runs (hidden)           | 543 | −0.9 (−4.4..+2.8)  | +555 (+497..+614)\*    | +41.6 (+40.1..+43.1)\* | +0.184 (+0.171..+0.197)\* | (base 429-bound)     |
| clean rerun, hidden          | 144 | −5.6 (−13.9..+2.8) | +670 (+557..+781)\*    | +32.1\*            | +0.302 (+0.280..+0.324)\* | +0.75 (+0.50..+0.99)\* |
| clean rerun, control (decoy) | 144 | −0.7 (−3.5..+2.1)  | +815 (+700..+935)\*    | +34.6\*            | +0.288\*                | +0.83 (+0.59..+1.07)\* |

The rule: hidden facts **held** at 1,000 sources (no interval entirely below zero). Per call, the default at 995
sources costs $16.7/1k on Composio and $1,393/1k on Zapier MCP (steady, `cost-scale.txt`) against $0.42 and $16.2 at
5 sources (`cost-short-a.txt`).

## 5. Concerns

77 answers the Haiku grader called a concern were regraded (Haiku + Sonnet; Sonnet's verdict decides): Sonnet kept 8
(4 long, 4 short 45–48), none of them in a pair that moves a part's interval off zero. The default against the agent
alone: regraded concerns 0.0 on both horizons (Haiku-graded +0.7 long, +0.6 short: grader errors, as fix-w2b found).
The wall rerun's concerns were not regraded (graded only; they are a wall measurement).

**Not regraded:** the hidden answers. The nudge's earlier gain was largest Sonnet-graded (D317: +9.2 against +5.8
Haiku-graded), so this run's Haiku-graded hidden pairs may understate it. A Sonnet regrade of the 1,395 short hidden
pairs of `eden` and `eden~minus-nudge` would cost about $4 (estimate) and did not fit the cap.

## 6. Recommendations (nothing changed here)

1. **Nudge (D317): a trial to re-measure, not a removal.** Eight seeds put its Haiku-graded hidden gain at +1.3
   (−0.6..+3.3), against its cost ($0.012/1k over days) and 0.18 s a request. Before changing the default, regrade
   the nudge pairs' hidden answers with Sonnet (the grade that showed its gain) on these eight seeds; if the gain stays
   under about 3 points, take it out under D112 (no measured gain at a paid cost).
2. **Freshness (D342): keep; measure its purpose.** Its cost is about $0.004/1k over days; its job (recaps naming
   dropped times) needs the recap grading A17 used, at eight seeds.
3. **Plans (D301): measure at eight seeds with `--day 4 --late`**, the only design that exercises it.
4. **Fewer (D404): confirmed**; no action.
5. **1,000 sources:** the remaining work is the agent's asks searching cut copies live (B1's note): +0.75 s a task and
   ~32–42 connector calls, which is prohibitive on any per-call connector plan. That is the next scale lever.
6. **Lab: run Anthropic shards one or two at a time,** or give each shard's streams a concurrency limit: four runs at
   once on one key spent its concurrent-request limit and made the short runs' wall time useless (D440).

## Reproduce

```bash
python3 -m venv .venv-modal && .venv-modal/bin/pip install 'modal[api-proxy-support]==1.6.3'
export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt     # behind the container proxy
# go.sh RUN SEEDS CAP CONDITIONS EXTRA...: lab_fanout pi-ab, train, payload, Haiku everywhere, --variant-config from PARTS
.local/m1/go.sh m1-long 41,42,43,44,45,46,47,48 3.2 tools,eden,eden~minus-nudge,eden~minus-plans,eden~minus-fewer,eden~minus-freshness --days 8
.local/m1/go.sh m1-short-a 41,42,43,44 3.2 tools,eden,eden~minus-nudge,eden~minus-plans,eden~minus-fewer --variants hidden,control
python3 -I packages/sim/lab/m1/parts.py --arms tools,eden,eden~minus-nudge .local/modal/m1-long
python3 -I packages/sim/lab/m1/scale.py --arm eden --kind hidden .local/modal/m1-scale .local/modal/m1-short-a
```

`go.sh` is the command in §1 (kept in `.local/m1/`, not committed); its body is the README's pi-ab example with
`--variant-config '{"minus-nudge":{"askNudge":false},"minus-plans":{"planConflict":false},"minus-fewer":{"pushCandidatesSettled":0},"minus-freshness":{"verifyDelivery":false,"readerVerifyAfter":false,"revisionNotice":false,"revisionDiff":false}}'`,
`--cards packages/sim/lab/cards/cards-v2.jsonl,packages/sim/lab/cards/cards-train.jsonl,packages/sim/lab/cards/cards-train-4344.jsonl`,
`--tenant-prompt --push payload --source-profile packages/sim/lab/before-after/market-profiles/direct.json` and
Haiku 5.5 in every role. Summaries: `packages/sim/lab/m1/`.
