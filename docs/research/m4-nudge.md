# M4: keep or delete the ask nudge (askNudge, D317), Sonnet-graded at four seeds

Status: 2026-11-10, branch `claude/m4-nudge` (from `claude/lucid-hypatia-v9wqk5` at 638a36c3, M1 merged). Decisions
D455–D458 (D459 not used). **Result: the rule says delete, and `askNudge` is deleted (D455).**

## 0. Pre-registration (committed and pushed before any paid call)

**Why.** D317 put `askNudge` in the default on +9.2 points Sonnet-graded (+5.8 Haiku-graded) on A12's 91 targeted
train templates, seeds 41–44; A29 (D396) found +12.5 blind on heldout17. M1 (D441, D442) measured it at eight seeds
on the whole train suites, Haiku-graded: +1.3 points (−0.6..+3.3) pooled, at $0.012/1k over a user's days and 0.18 s
a request. M1 did not regrade the hidden answers, and the nudge's gain was largest Sonnet-graded. This run regrades
every hidden answer with Sonnet and decides by a fixed rule.

**Suites and seeds.** `train` (train1–6) only; no held-out suite is run or read. Seeds **41–44** only: the
checked-in cards (`cards-v2`, `cards-train`, `cards-train-4344`) and intent requests (`intent-v2.jsonl.gz`) replay
there. Seeds 45–48 are left out (with cards made in-run they scored about 11 points lower, D444).

**Harness.** Pi (`pi-ab.ts`), `--config default`, `--tenant-prompt` (D271), market `direct` source profile, time
scale 1, `--push payload`, `claude-haiku-5-5` as agent, grader, card, intent and reader model. Arms, in one process a
shard, paired task by task: `eden` (the shipped default) and `eden~minus-nudge` (`--variant-config
'{"minus-nudge":{"askNudge":false}}'`, the `nudge` part of `PARTS`).

**Runs** (`lab_fanout.py`, one seed a shard, at most two Anthropic shards running at a time, D440):

1. **Short** (one request a session): `--variants hidden,control`, all six train suites in one shard, seeds 41–44
   (4 shards; 192 hidden and 192 control tasks a seed an arm).
2. **Long** (a user's days): `--days 8` (default day sizes), seeds 41–44 (4 shards; about 14 hidden, 14 control and
   104 neutral tasks a user an arm).
3. **Regrade** (local, `regrade.ts`, on the pulled-back `out.json`): **every hidden answer in both arms**, short and
   long, with `claude-sonnet-5-5` (`--kinds hidden`), and every control and neutral answer the Haiku grader called a
   concern, in both arms, with Sonnet (`--only-concerns`). Sonnet's verdict replaces Haiku's wherever Sonnet graded;
   an answer Sonnet failed to grade (error or unreadable) keeps Haiku's verdict and is counted.

**Metric and analysis.** The paired effect of removing the nudge, `eden~minus-nudge − eden`, on hidden facts raised
(points), Sonnet-graded, and on concerns (control + neutral, Sonnet-regraded); bootstrap 95%, 5,000 draws, tasks
resampled within each (shard, kind) stratum; pooled over both horizons and four seeds, and per horizon. Haiku-graded
figures are reported beside them. A task an arm did not finish is dropped from both arms. Also reported: $/1k and
wall (as M1's `parts.py`), and the same hidden effect on the subset of tasks whose template is one of A12's 91
targeted templates (`packages/sim/lab/a2/targeted-templates.txt`), if task ids name their template.

**Rule (applied mechanically; the nudge's effect is `eden − eden~minus-nudge`, the sign flipped).** **Keep askNudge**
if the Sonnet-graded pooled paired hidden effect's 95% interval is entirely above zero, **or** its point estimate is
≥ +2 points with concerns not up (the pooled Sonnet-regraded concern effect's point estimate ≤ 0, or its interval
includes zero). **Otherwise delete it** under D112: the switch, its code and its tests, the `nudge` part and
`docs/profiles/minus-nudge.json`, with the eval and funnel re-run and CLAUDE.md's expected numbers updated. The
targeted-template subset is reported, not part of the rule.

**Spend.** Anthropic hard cap **$4 in all** (Sonnet regrades included): short shards $0.30 each ($1.20), long shards
$0.12 each ($0.48), the regrade at most what is left (≤ $2.32), each on its own spend ledger. Modal under $10. A
shard that hits its cap stops early; its unfinished tasks drop from both arms and the note says how many. If the
regrade cap would be hit before every hidden answer is graded, the short horizon's hidden answers are graded in a
fixed order (seed, then task id) and the rest are reported ungraded rather than sampled.

## In plain words

**Spent: $3.08 Anthropic** of the $4 cap (runs $1.256 from the shards' manifests, Sonnet regrade $1.822 from its
ledger, 1,645 answers at about $0.0011 each), **Modal $0.14** billed for this session's four apps (`modal billing
report --for today`, complete hours only, read before the last hour closed). Anthropic-direct lab figures (D97).
Eight containers, at most two at a time; no shard hit its cap, no task was dropped, no answer failed to regrade.

- **The rule says delete, and the nudge is deleted (D455).** Pooled over both horizons and four seeds, every hidden
  answer regraded by Sonnet, the nudge raises hidden facts by **+1.7 points (−0.9..+4.3, n 814)**: the interval
  includes zero and the point is under +2. It costs **+$0.022 per 1,000 tasks (+0.017..+0.027)** and **+0.21 s a
  task (+0.17..+0.25)**. Funnel 314/273 → 305/267 (D317's own "before"); `bun run eval` unchanged (0.65/0.52/0).
- **Sonnet does not find the larger gain D317 reported.** Haiku-graded the same pairs read +2.2 (−0.4..+4.8);
  Sonnet changed 148 of 1,628 hidden verdicts (77 raised → missed, 71 missed → raised) and moved the effect down, not
  up. One request a session +1.4 (−1.3..+4.3, n 768); over a user's days +6.5 (−2.2..+15.2, n 46).
- **On A12's 91 targeted templates the gain is real; on the other templates it is nil.** Targeted: **+4.5 (+0.8..+8.4,
  n 382)**, Haiku +3.9; the other train templates: −0.7 (−4.4..+3.0, n 432). The targeted templates are the ones whose
  packet A2's re-rank changed, picked because the push's candidates matter there, so D317's +9.2 measured the nudge
  where it helps most; spread over the suites it is under the rule's bar.
- **Concerns are not up.** Sonnet-regraded control and neutral concerns: 1 of 1,202 with the nudge, 0 without (+0.1,
  +0.0..+0.2); Haiku called 13 and 4, and Sonnet kept 1 of those 17.

## 1. Runs

Pi, `--config default`, `--suite train`, `--tenant-prompt`, `direct` profile, time scale 1, `--push payload`, Haiku 5.5
in every role, cards `cards-v2` + `cards-train` + `cards-train-4344` replayed (5,956 cards) and intent requests
replayed; arms `eden` and `eden~minus-nudge` in one process a shard (`.local/m4/go.sh`, the M1 recipe with two arms).

| run          | shards (seeds)  | tasks an arm                                   | $      | wall a shard |
| ------------ | --------------- | ---------------------------------------------- | ------ | ------------ |
| short-a      | 2 (41, 42)      | 384 a seed (192 hidden, 192 control)           | 0.479  | 118 s        |
| short-b      | 2 (43, 44)      | 384 a seed                                     | 0.470  | 118–119 s    |
| long-a       | 2 (41, 42)      | a user's 8 days (`--days 8`)                   | 0.145  | 218–265 s    |
| long-b       | 2 (43, 44)      | a user's 8 days                                | 0.163  | 244–245 s    |
| regrade      | local           | 1,536 + 92 hidden, 17 concerns (both arms)     | 1.822  |              |

Over days the four users had 46 hidden, 46 control and 388 neutral tasks an arm, all graded (the plan gives 11–12
hidden a user; pre-registered as "about 14"). No 429s in any shard's log (two shards at a time).

## 2. The nudge's effect (`eden − eden~minus-nudge`; bootstrap 95%, 5,000 draws, within shard and kind)

Points for hidden and concerns; $ per 1,000 tasks (agent billed + Eden per task + background cards); wall s. `*` the
interval excludes zero. From `packages/sim/lab/m4/nudge.txt` (`nudge.py`).

| scope                       | hidden, Sonnet          | hidden, Haiku          | concerns, Sonnet  | $/1k                      | wall s                  |
| --------------------------- | ----------------------- | ---------------------- | ----------------- | ------------------------- | ----------------------- |
| **pooled (rule)**           | **+1.7 (−0.9..+4.3)**   | +2.2 (−0.4..+4.8)      | +0.1 (+0.0..+0.2) | +0.022 (+0.017..+0.027)\* | +0.21 (+0.17..+0.25)\*  |
| short (n 768 hidden)        | +1.4 (−1.3..+4.3)       | +2.6 (+0.0..+5.2)      | +0.0 (+0.0..+0.0) | +0.025 (+0.019..+0.031)\* | +0.24 (+0.20..+0.29)\*  |
| long (n 46 hidden)          | +6.5 (−2.2..+15.2)      | −4.3 (−15.2..+6.5)     | +0.2 (+0.0..+0.7) | +0.012 (+0.007..+0.017)\* | +0.10 (+0.06..+0.15)\*  |
| targeted templates (n 382)  | +4.5 (+0.8..+8.4)\*     | +3.9 (+0.0..+7.9)      |                   |                           |                         |
| other templates (n 432)     | −0.7 (−4.4..+3.0)       |                        |                   |                           |                         |

Rates (pooled): hidden Sonnet 0.633 with the nudge, 0.615 without; Haiku 0.639 and 0.617.

**The rule, applied.** The pooled Sonnet interval is not above zero, and the point (+1.7) is under +2: **delete**.

## 3. Against the earlier estimates

| estimate                                        | grade  | suites, seeds                        | nudge's hidden effect   |
| ----------------------------------------------- | ------ | ------------------------------------ | ----------------------- |
| D317 (A12)                                      | Sonnet | 91 targeted templates, 41–44         | +9.2 (+6.0..+12.6)      |
| D396 (A29, blind)                               | mixed  | heldout17                            | +12.5 (+1.4..+23.6)     |
| M1 (D442)                                       | Haiku  | whole train, 41–48                   | +1.3 (−0.6..+3.3)       |
| **M4, this run**                                | Sonnet | whole train, 41–44                   | **+1.7 (−0.9..+4.3)**   |
| M4, the targeted templates only                 | Sonnet | 91 targeted templates, 41–44         | +4.5 (+0.8..+8.4)       |

The targeted subset reproduces the direction of D317 at half its size; the whole suites do not. A29's blind +12.5
rests on one held-out suite whose interval reaches +1.4; it is not re-run here (every held-out suite is read).

## 4. What was deleted (D455)

`askNudge` in `EngineConfig`, `DEFAULT_CONFIG`, the config check and the `reader`/`candidates` parts; the `nudge`
part and `docs/profiles/minus-nudge.json`; `ASK_NUDGE`; `Session.nudged` and the ask's deeper look; the candidates'
`unsettled` flag (`candidatesOf`, `PushPoolReport`, the funnel's `pushUnsettled`); `settle.ts`'s `anchored`; the
nudge's tests in `ask-nudge.test.ts`. `settle.ts` stays: `pushCandidatesSettled` (D404) uses `settles` and
`settledCut`, and their tests move to `settle.test.ts`. The code is in commit 638a36c3. `packages/sim/lab/a12/run.sh`,
`a29/run.sh` and `m1/parts.py`'s usage line are history: they name `askNudge` (or its `minus-nudge` arm), which no
longer exists, and now stop on `unknown key "askNudge"`; reproduce them from commit 638a36c3. A deployment whose
`EDEN_ENGINE_CONFIG` sets `askNudge` (for example a copy of the old `minus-reader.json` or `minus-candidates.json`)
now refuses to start (`checkEngineConfig` rejects unknown keys): drop the key.

## Reproduce

```bash
python3 -m venv .venv-modal && .venv-modal/bin/pip install 'modal[api-proxy-support]==1.6.3'
export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt
# go.sh RUN SEEDS CAP EXTRA...: lab_fanout pi-ab, train, Haiku everywhere, arms eden,eden~minus-nudge (M1's recipe)
.local/m4/go.sh m4-short-a 41,42 0.6 --variants hidden,control    # then 43,44 as m4-short-b
.local/m4/go.sh m4-long-a 41,42 0.24 --days 8                     # then 43,44 as m4-long-b
# per shard: Sonnet on every hidden answer (--kinds hidden) and every Haiku-called concern (--only-concerns)
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results SHARD/out.json --graders claude-sonnet-5-5 \
  --kinds hidden --conditions eden,eden~minus-nudge --spend-ledger .local/m4/regrade-ledger.jsonl --spend-cap 2.32 \
  --spend-headroom 0.02 --run-label m4-regrade --out SHARD/regrade-hidden.json
python3 -I packages/sim/lab/m4/nudge.py --templates packages/sim/lab/a2/targeted-templates.txt \
  --group short=.local/modal/m4-short-a,.local/modal/m4-short-b \
  --group long=.local/modal/m4-long-a,.local/modal/m4-long-b
```

`go.sh` and `regrade.sh` are kept in `.local/m4/` (not committed); `go.sh` is the README's pi-ab example with
`--conditions eden,eden~minus-nudge --variant-config '{"minus-nudge":{"askNudge":false}}'` and M1's cards, profile and
flags. After D455 the `minus-nudge` variant names a switch that no longer exists: reproduce from commit 638a36c3.
