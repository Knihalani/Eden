# M4: keep or delete the ask nudge (askNudge, D317), Sonnet-graded at four seeds

Status: 2026-11-10, branch `claude/m4-nudge` (from `claude/lucid-hypatia-v9wqk5` at 638a36c3, M1 merged). Decisions
D455–D459.

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
