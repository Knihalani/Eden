# W2b: where Eden's false concerns come from (RealUse-1 weak point 2, continued)

Status: results, 2026-11-07. Follows [fix-s2-rules.md](fix-s2-rules.md) (rule-path decoys are not what the agent
raises; D195–D197). Decisions D230, D231.

**Spent: $3.3193** of a hard $4 (ledger `.local/ledger.jsonl`, every label `w2b-*`; Anthropic direct,
`claude-haiku-5-5` in every role, `claude-sonnet-5-5` only for the regrade, `OPENROUTER_API_KEY` unset,
`--spend-cap 4 --spend-headroom 0.3`). Lab transport (D97), not the shipped OpenRouter route. By label: cards and
intent top-up $0.0579, phase 1 $0.5208, phase 2 $1.7842, phase 3 $0.9016, Sonnet regrades $0.0203 + $0.0344.
Held-out 15 was not run.

## The question

With Eden the agent raised false concerns on 3.1% of held-out 10–13 control tasks against 0.6% for the agent with
its own tools (RealUse-1), and on 7/128 against 2/128 neutral held-out 14 tasks. S2 showed rule-path decoys are not
the cause. Which way does the item behind each false concern reach the agent?

## Method

- **Records.** pi-ab's per-task line now keeps each proactive packet's way (`ways`: its reason's kind, `reader` for
  the reader push, else the rule path, with the ids it cited) and each `ask_context` answer's text (`asks[].text`,
  whose `Eden's reader:` lines mark what the reader flagged) beside the ids already kept (`uptake.ts`).
  `packages/sim/lab/fix-w2b/attribute.py` reads a run and attributes each concern's planted decoy, first match wins:
  **push-flagged** (a reader-push packet cited it), **rule-path** (another packet did), **ask-flagged**, **ask-listed**
  (an answer cited it with, or without, a reader note), **none**. Neutral tasks plant nothing and were read by hand.
- **Runs.** Pi harness, `--config default`, direct market profile, `--push signals`, time scale 1, cards and intent
  replayed from caches topped up for held-out 10–12 seeds 43–44 (`w2b-enrich`, `w2b-intent*`). One seed per process
  (`packages/sim/lab/fix-w2b/run.sh`, `jobs.txt`). 0 errors, 0 ungraded, `overBudget: reader 0, cards 0` in every
  process. Phase 1: `eden` only, control on held-out 10–13 and control + neutral on held-out 14, seeds 41–44 (640
  control, 128 neutral). Phase 2 (the first trial's pair) gives a second sample of the same tasks' `eden` arm.
- **Grader check.** `regrade.ts --only-concerns` (new) regraded every concern with `claude-sonnet-5-5`, and I read
  every concern's request, decoy and answer by hand ("real": the answer claims the decoy's false concern as a fact or
  a reason to change plan).

## 1. Attribution

Phase 1 `eden`: control 13/640 (2.0%; held-out 10 4, held-out 11 9, 12–14 none), neutral 3/128. Phase 2 `eden`:
control 21/640 (3.3%), neutral 2/128. Both samples (`attribution.json`, every task with its three verdicts):

| way the decoy reached the agent | Haiku-graded concerns | Sonnet agrees | real by hand | grader's error by hand |
| --- | --- | --- | --- | --- |
| reader-flagged item delivered by push | 11 | 3 | 10 | 1 |
| reader-flagged item in an ask answer (first way) | 0 | 0 | 0 | 0 |
| rule-path item (grounded-conflict, grounded-card, sources) | 7 | 1 | 3 * | 3 (+1 unclear) |
| unflagged, listed-only ask item | 15 | 9 | 10 | 5 |
| no Eden item (control) | 1 | 0 | 0 | 1 |
| neutral tasks (nothing planted) | 5 | 0 | 0 | 5 |
| **total** | **39** | **13** | **23** | **15 (+1)** |

\* all three are `recording-retention`: delivered by grounded-conflict, then flagged by the reader in an ask
("blocks: ... permanently deleted"), so a reader flag stands behind them too.

What the table says:

- **No concern was the agent's own invention from an Eden item it was not given.** The one control "none" and all
  five neutral concerns are the grader counting a hedge ("I'd check your allowance", "confirm the end date") or an
  answer that says the opposite; Sonnet rejects all six. Held-out 14's neutral excess (7/128 against 2/128 in
  RealUse-1) did not reproduce: 3/128 and 2/128 here, none of them real.
- **The grader inflates the rate.** 15 of 39 concerns (16 with the unclear one) are the Haiku grader's errors by hand (the washer warranty
  answer says it *expired*; the export-ticket answer says the fix *ships*). Sonnet is stricter still: it also rejects
  answers that raise the decoy's concern with the decoy's own details (Bass Rock's 400 mm limit applied to a Farne
  Islands trip), because the listed fact names the other place.
- **Two real causes of about equal size.** Reader-flagged look-alikes (13 real: the hide-lens limit for another
  place, a neighbour consent already given, last year's deleted recording, a vendor bill already corrected) and
  listed-only items (10 real: a fee quoted for the user's sister, another supplier's day rate). By the shipped
  grader and by Sonnet, listed-only is the larger (15 and 9 of 39 and 13).
- **Every listed-only concern (15 of 15) came from an ask the reader never read.** The agent's asks were information
  questions ("What is Owen charging for my tax return this year?", "Who is Aiko Tanaka, what is her email?"), which
  `readAsk` does not read (only an acting request or a blocker question is read), so the answer is the plain ranked
  list with no `Eden's reader:` line at all.

## 2. The trials

Both are wording-only: no call, no item dropped, so the $0 screen (LAB.md recipe 2a, the paid Haiku reading
replayed, `{"replayed":643,"sent":0,"missed":0,"failed":0}`) is a check that nothing else moves: TOTAL hidden
314/384 and decoys 132/384 in every arm, the same per task.

- **`askUnflaggedNote` (D230).** An ask answer whose reader read its pool says before each item it read and did not
  flag `Eden's reader: not flagged: may be another person, thing or date`. Chosen from phase 1's Haiku counts
  (listed-only 7 of 13) before the "never read" finding above. $0: ask answer bytes +19.5% (622,281 → 743,551 over
  train). Live, paired by task in each process, held-out 10–14 seeds 41–44 (`live-unflagged.json`):

| suites (n per kind) | measure | eden | note − eden (95% CI) |
| --- | --- | --- | --- |
| held-out 10–13 (512) | hidden facts raised | 70.1% | −0.4 (−3.5..+2.7) |
| | false concerns (control) | 3.7% | −0.8 (−2.2..+0.6) |
| held-out 14 (128) | hidden facts raised | 66.4% | −3.9 (−10.9..+3.1) |
| | false concerns (control) | 1.6% | +0.8 (−2.3..+4.7) |
| | neutral concerns | 1.6% | +1.6 (−2.3..+5.5) |
| all (640) | false concerns (control) | 3.3% | −0.5 (−1.7..+0.8) |
| | Eden $/1k, agent $/1k (control) | 0.249, 0.341 | +0.001 (−0.007..+0.008), +0.002 (−0.007..+0.011) |

  The trial arm's listed-only concerns had no note on them: in 4 of 5 the answer carries no reader line at all, the
  asks it was meant for are not read.

- **`askUnreadNote` (D231).** An ask answer with items that no reading checked (an unread question, a gated pool, a
  late, failed or refused call, no reader wired) ends with `Eden found these items by search and did not check them
  against the request: confirm each is about the same person, thing and date before relying on it.` $0: bytes +3.1%
  (most train asks are read). Live, paired, held-out 10–14 seeds 41–42 (the remaining budget;
  `live-unread.json`):

| suites (n per kind) | measure | eden | note − eden (95% CI) |
| --- | --- | --- | --- |
| held-out 10–13 (256) | hidden facts raised | 71.1% | +1.2 (−3.1..+5.5) |
| | false concerns (control) | 2.7% | +0.4 (−1.2..+2.3) |
| held-out 14 (64) | hidden facts raised | 70.3% | −4.7 (−15.6..+6.3) |
| | false concerns / neutral | 1.6% / 1.6% | 0.0 (−4.7..+4.7) / −1.6 (−4.7..0.0) |
| all (320) | hidden; false concerns (control) | 70.9%; 2.5% | 0.0 (−4.1..+4.1); +0.3 (−1.3..+1.9) |
| | Eden $/1k, agent $/1k (control) | 0.250, 0.347 | +0.002 (−0.011..+0.016), 0.000 (−0.013..+0.013) |

  Listed-only concerns in its arm: 4 against the default's 3. Where the note is visible in the record
  (accountant-fee, seed 41) the agent read it, wrote "one caveat: that email is addressed as being for my sister
  Ellie", and still gave the sister's fee as the user's.

## Outcomes

Neither trial meets the bar (false or neutral concerns lower, no significant hidden loss, no paid-cost rise): both
are deleted with their code and tests (D230 in commit 34b94133, D231 in commit 14968b2b). What stays is lab tooling:
the per-task `ways` and `asks[].text` records, `regrade.ts --only-concerns`, and `fix-w2b/attribute.py`.

What this says about issue 2:

- About two fifths of measured false concerns are the Haiku grader's errors; a stronger grader on the concerns
  alone ($0.05 here) should be standard before a false-concern difference is acted on.
- The real ones come from two places, each about half: the reader flagging a look-alike (another place, a resolved
  prerequisite, last year's item), delivered by the push before the agent asks; and the agent's own information
  questions, which the reader does not read, answered with whatever ranks. Framing either kind of answer does not
  change what the agent writes. The next things to try are upstream: a reader prompt that names the look-alike
  shapes seen here (same rule for another place, consent already given, a dated item from another year), screened on
  the paid replay with a metered top-up; and reading an information ask when its answer would name a fee, rate, date
  or rule (a reader call per such ask: a cost decision first, docs/COST-MODEL.md).
- None of the false concerns was invented by the agent from nothing, and Eden's neutral excess on held-out 14 did not
  reproduce on these seeds.

## Reproduce

```bash
L="--spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3"
mkdir -p .local/w2b/enrich && cp packages/sim/lab/cards/cards-v2.jsonl .local/w2b/enrich/
gunzip -c packages/sim/lab/distilled/intent-v2.jsonl.gz > .local/w2b/enrich/intent-v2.jsonl
E="env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cards-enrich.ts --dir .local/w2b/enrich --model claude-haiku-5-5 $L"
$E --run-label w2b-enrich --funnel heldout10,heldout11,heldout12,heldout13 --seeds 41,42,43,44
$E --run-label w2b-intent --funnel heldout10,heldout11,heldout12,heldout13 --seeds 41,42,43,44 --intent  # twice
# cards-merged.jsonl: cards-v2 then each intent-file card not in it (realuse-1/B-pi-continuity.md's Reproduce)
xargs -P 4 -L 1 packages/sim/lab/fix-w2b/run.sh < packages/sim/lab/fix-w2b/jobs.txt   # p1, p2, p3 lines
python3 -I packages/sim/lab/fix-w2b/attribute.py .local/w2b/attr-p1.json .local/w2b/p1/w2b-p1-*[0-9].json
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results F --graders claude-sonnet-5-5 \
  --only-concerns $L --run-label w2b-regrade-X --out X.json
python3 -I packages/sim/lab/fix-w2b/analyze.py out.json h10_13=<files> h14=<files> all=<files>
gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz > .local/reader-haiku-train-4142-intent.jsonl
bun run funnel --jobs 4 --allow-misses --set '{"askUnreadNote":true}' -- --reader replay \
  --reader-model claude-haiku-5-5 --reader-cache .local/reader-haiku-train-4142-intent.jsonl   # on 14968b2b
```

The p2 and p3 lines of `jobs.txt` name the deleted trials: run them on their commits. Phase 2's regrade ran on
eden-only copies of its results files (regrade.ts reads one file and every condition in it).
