# M5: a narrower trigger for the ask nudge (`askNudgeDeep`, D460)

Status: 2026-11-10, branch `claude/m5-nudge-narrow` (from `claude/lucid-hypatia-v9wqk5` at 9be15991). Decisions
D460–D462 (D463, D464 not used). §0 and §1 are the pre-registration, committed and pushed (dbf215af) before any paid
call; §2 onwards came after. **Result: the rule says promote, and `askNudgeDeep` is in the default (D461).**

## In plain words

**Spent: $3.06 Anthropic** of the $4 cap (runs $1.258 from the shards' manifests, Sonnet regrade $1.805 from its
ledger, 1,644 answers at about $0.0011 each), **Modal $0.14** billed for this session's four apps (`modal billing
report --for today`, complete hours only). Anthropic-direct lab figures (D97). Eight containers, two at a time; no
shard hit its cap, no task was dropped, no answer failed to regrade.

- **What tells the tasks apart (D462).** Where the nudge helps, the planted fact sits 6th–15th in the push's pool or in
  no pool; where it fires for nothing, the fact is already in the packet (322 of 421 nudged hidden tasks at $0). The
  ask's deeper look can only help when the pool past the handed items holds something anchored to the request.
- **The narrower trigger keeps the gain and drops the empty asks.** Firing only then (`askNudgeDeep`), against the
  current nudge, pooled over both horizons and four seeds, Sonnet-graded: targeted-template hidden **+2.1 points
  (−1.3..+5.5, n 382)**, all hidden +0.7 (−1.8..+3.4, n 814); **asks −0.062 a task (−0.086..−0.038)**, **−$0.005 per
  1,000 tasks (−0.009..−0.000)**, **−0.062 s a task (−0.097..−0.027)**; Sonnet kept no concern in either arm.
- **Caveats.** Haiku-graded the targeted subset reads −0.8 (−4.5..+2.9); Sonnet changed 118 of 1,628 hidden verdicts
  (62 raised → missed, 56 missed → raised). Over a user's days (n 46 hidden) the switch saves no asks (+0.002) and
  costs +0.065 s (+0.022..+0.108): the gain is in one-request sessions, where the nudge fired most.
- `bun run eval` unchanged (0.65/0.52/0); funnel unchanged task by task (314/273 at 41–42; 633/550 at 41–44).

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

## 2. Runs

Pi on Modal, `packages/sim/lab/m5/go.sh` at commit dbf215af (the review's comment and test fix after it change no
behaviour), arms `eden` and `eden~deep`, as pre-registered. Manifests: `packages/sim/lab/m5/manifest-*.json`.

| run     | seeds  | tasks an arm                         | $      | wall a shard |
| ------- | ------ | ------------------------------------ | ------ | ------------ |
| short-a | 41, 42 | 384 a seed (192 hidden, 192 control) | 0.474  | 108–131 s    |
| short-b | 43, 44 | 384 a seed                           | 0.472  | 119–122 s    |
| long-a  | 41, 42 | a user's 8 days (`--days 8`)         | 0.149  | 219–252 s    |
| long-b  | 43, 44 | a user's 8 days                      | 0.163  | 255–273 s    |
| regrade | local  | 1,628 hidden, 16 concerns (both arms) | 1.805 |              |

## 3. The effect (`eden~deep − eden`; bootstrap 95%, 5,000 draws, within shard and kind)

From `packages/sim/lab/m5/narrow.txt` (`narrow.py`). Points for hidden and concerns; `*` the interval excludes zero.

| scope                       | hidden, Sonnet       | hidden, Haiku        | asks a task                | $/1k                       | wall s                    |
| --------------------------- | -------------------- | -------------------- | -------------------------- | -------------------------- | ------------------------- |
| **targeted templates (rule)** | **+2.1 (−1.3..+5.5)** | −0.8 (−4.5..+2.9)  |                            |                            |                           |
| other templates             | −0.5 (−4.4..+3.2)    |                      |                            |                            |                           |
| **pooled**                  | +0.7 (−1.8..+3.4)    | −1.2 (−3.9..+1.5)    | **−0.062 (−0.086..−0.038)\*** | **−0.005 (−0.009..−0.000)\*** | **−0.062 (−0.097..−0.027)\*** |
| short (n 768 hidden)        | +0.8 (−1.7..+3.4)    | −1.0 (−3.8..+1.6)    | −0.082 (−0.113..−0.051)\*  | −0.006 (−0.012..−0.000)\*  | −0.101 (−0.146..−0.058)\* |
| long (n 46 hidden)          | +0.0 (−15.2..+15.2)  | −4.3 (−15.2..+6.5)   | +0.002 (−0.023..+0.027)    | +0.000 (−0.005..+0.005)    | +0.065 (+0.022..+0.108)\* |

Asks a task, pooled: 0.444 with the current nudge, 0.382 with the narrower one (short 0.556 → 0.474). Concerns:
Haiku called 16 (11 current, 5 narrower) of 2,404 control and neutral answers; Sonnet kept none.

**The rule, applied.** (a) targeted point +2.1 ≥ −1.0 and the interval not wholly below zero; (b) concerns not up;
(c) asks, $/1k and wall points all below zero: **promote** (D461).

## Reproduce

```bash
python3 -m venv .venv-modal && .venv-modal/bin/pip install 'modal[api-proxy-support]==1.6.3'
export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt
bun run funnel --suite train --seeds 41,42,43,44 -- --pool-dump .local/m5/pool.jsonl     # §1, $0
python3 -I packages/sim/lab/m5/screen.py .local/m5/pool.jsonl
EDEN_COMMIT=dbf215af packages/sim/lab/m5/go.sh m5-short-a 41,42 0.6 --variants hidden,control   # then 43,44 as -b
EDEN_COMMIT=dbf215af packages/sim/lab/m5/go.sh m5-long-a 41,42 0.24 --days 8                    # then 43,44 as -b
# per shard: Sonnet on every hidden answer and every Haiku-called concern, both arms
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results SHARD/out.json --graders claude-sonnet-5-5 \
  --kinds hidden --conditions eden,eden~deep --spend-ledger .local/m5/regrade-ledger.jsonl --spend-cap 2.32 \
  --spend-headroom 0.02 --run-label m5-regrade --out SHARD/regrade-hidden.json   # and --only-concerns → regrade-concerns.json
python3 -I packages/sim/lab/m5/narrow.py --templates packages/sim/lab/a2/targeted-templates.txt \
  --group short=.local/modal/m5-short-a,.local/modal/m5-short-b --group long=.local/modal/m5-long-a,.local/modal/m5-long-b
```

After D461 the default has `askNudgeDeep` on, so `go.sh`'s `eden` arm is the narrower nudge too: reproduce from
commit dbf215af, or give the old arm `--variant-config '{"wide":{"askNudgeDeep":false}}'`.
