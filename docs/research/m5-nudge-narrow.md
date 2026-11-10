# M5: a narrower trigger for the ask nudge (`askNudgeDeep`, D460)

Status: 2026-11-10, branch `claude/m5-nudge-narrow` (from `claude/lucid-hypatia-v9wqk5` at 9be15991). Decisions
D460–D464. §0 to §1 are the pre-registration, committed and pushed before any paid call.

## 0. Pre-registration

**Why.** M4 (D455–D457) measured the ask nudge (`askNudge`, D316, D317) at +1.7 points hidden (−0.9..+4.3) on the
whole train suites, +4.5 (+0.8..+8.4) on A12's 91 targeted templates and −0.7 elsewhere, for +$0.022 per 1,000 tasks
and +0.21 s a task; it was kept on the blind heldout17 result (D455). The gain sits where the push's candidates decide
the outcome; elsewhere the nudge makes the agent ask for nothing. M4's per-task rows are not in the repository
(`.local/` is not committed), so §1's $0 screen asks what distinguishes those tasks.

**The trial (D460).** `askNudgeDeep` (off; needs `askNudge`): the nudge fires only when, besides the handed
candidates leaving the request unsettled (`settles`), the push pool past the handed candidates holds an item that is
not bulk mail and names one of the request's anchors (`anchored`): exactly what the ask's deeper look would list.
With nothing anchored past the handed items the deeper look has nothing to add. No model call, no new state.

**Harness.** Pi (`pi-ab.ts`) on Modal (`lab_fanout.py`, one seed a shard, at most two Anthropic shards at a time,
D440), `--config default`, `--tenant-prompt`, `direct` source profile, time scale 1, `--push payload`,
`claude-haiku-5-5` as agent, grader, card, intent and reader model, cards `cards-v2` + `cards-train` +
`cards-train-4344` and intent requests replayed. Arms in one process a shard, paired task by task: `eden` (the
shipped default, the current nudge) and `eden~deep` (`--variant-config '{"deep":{"askNudgeDeep":true}}'`).
`packages/sim/lab/m5/go.sh` is the command.

**Runs.** Train (train1–6) only, seeds **41–44** only (the checked-in cards and intent requests replay there; D444).

1. **Short**: `--variants hidden,control`, all six suites a shard, seeds 41–44 (4 shards, two runs of two).
2. **Long**: `--days 8`, seeds 41–44 (4 shards, two runs of two).
3. **Regrade** (local, `regrade.ts`): every hidden answer in both arms, short and long, with `claude-sonnet-5-5`
   (`--kinds hidden`), and every control and neutral answer Haiku called a concern, both arms (`--only-concerns`).
   Sonnet's verdict replaces Haiku's where Sonnet graded; a failed regrade keeps Haiku's and is counted. If the cap
   would be hit first, targeted-template hidden answers are graded first (seed, then task id), the rest reported
   ungraded.

**Metric.** The paired effect `eden~deep − eden`, pooled over both horizons and four seeds, bootstrap 95% (5,000
draws, tasks resampled within each (shard, kind) stratum), by `packages/sim/lab/m5/narrow.py` (M4's `nudge.py` with
the arms swapped and the agent's asks added: `toolCalls`, the eden arm's one tool being `ask_context`). Reported:
hidden (Sonnet and Haiku) on the targeted templates (`packages/sim/lab/a2/targeted-templates.txt`), on the others and
overall; concerns (control + neutral, Sonnet-regraded); asks a task; $ per 1,000 tasks (agent + Eden + background);
wall s a task. A task an arm did not finish is dropped from both arms.

**Rule (mechanical).** **Promote `askNudgeDeep` into the default** (D112) if all of:
(a) hidden on the targeted templates is not worse: the pooled Sonnet-graded effect's point ≥ −1.0 point and its 95%
interval not wholly below zero;
(b) concerns not up: the pooled Sonnet-regraded concern effect's point ≤ 0 or its interval includes zero;
(c) asks, $/1k and wall fall overall: each pooled point estimate below zero.
**Otherwise delete it**: the switch, its config check, `anchoredPast`, its tests and its trials row. The lab-only
`anchored`/`anchorKinds` fields of `PushPoolReport` stay (they feed the screen in §1).

**Spend.** Anthropic hard cap **$4 in all**: short runs $0.60 each ($1.20), long $0.24 each ($0.48), regrade at most
$2.32 on its own ledger. Modal under $10. A shard that hits its cap stops; its unfinished tasks drop from both arms
and the note says how many.

## 1. The $0 screen (before the trial was built)

`bun run funnel --suite train --seeds 41,42,43,44 -- --pool-dump F` (the shipped default; cards and intent
replayed, reader stub), with the push's report extended by lab-only flags: each pool item's `anchored` and the
request's anchor kinds (`PushPoolReport.anchored`, `anchorKinds`). `packages/sim/lab/m5/screen.py` reads it;
`screen.txt` holds its output. The planted item's place: **handed** (in the packet), **deep** (6th–15th of the
pool, not handed), **notpool**.

| trigger                                              | hidden fires | handed | deep | notpool | deep, planted anchored | targeted | control fires |
| ---------------------------------------------------- | -----------: | -----: | ---: | ------: | ---------------------: | -------: | ------------: |
| current (`askNudge`)                                 |          421 |    322 |   43 |      56 |                     23 |      250 |           423 |
| + an anchored item past the handed ones (screen)     |          185 |    129 |   34 |      22 |                     23 |      158 |           202 |
| + that item also constraint-like                     |           97 |     68 |   19 |      10 |                     15 |       86 |           119 |
| + a constraint-like item past the handed ones        |          375 |    281 |   42 |      52 |                     22 |      229 |           381 |
| + the request names a day                            |          357 |    264 |   42 |      51 |                     23 |      238 |           375 |
| **`askNudgeDeep` as built (engine, bulk-mail test)** |      **202** |    140 |   34 |      28 |                     23 |      161 |       **231** |

Of 768 hidden tasks, 636 had a push; the nudge fired on 421, and in **322 of them the planted fact was already in
the packet**. What sets the targeted templates apart is the deep pool: 37 of their 250 nudged tasks hold the planted
item 6th–15th (6 of 171 elsewhere) and 40 hold it in no pool (16 elsewhere). A day in the request separates nothing
(the "no day" fires are 58 of 64 handed, but only 64). Requiring an anchored item past the handed ones keeps every
task where the deeper look can show the planted fact (23 of 23) and 34 of 43 deep tasks, and halves the fires on
control tasks (where every ask is cost). The screen's row counts `automated` senders; the engine's own test is
`bulkMail`, so the built switch fires a little more (202 against 185). The constraint-like variant loses 8 of the 23.

`bun run funnel` with the switch on against the default, task by task: **+0 −0 hidden, +0 −0 decoys** (633/768,
550/768 at seeds 41–44; 314/273 at 41–42): the funnel always asks, and where the switch silences the nudge the
deeper look had nothing anchored to add. Its effect is only on whether the live agent asks, which is what §0 measures.
