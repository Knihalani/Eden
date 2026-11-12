# F2: the push check, towards recall

Status: 2026-11-12, branch `claude/f2-push-recall` (from main 006b505c), session F2. **Trial `pushCheckRecall` open
(off), pre-registered in §4, waiting on credit.** The first pass (§0–§3) stopped on spend, not on a result: the Anthropic account behind `HAIKU_API_KEY` ran out of credit during the first screen ("Your credit balance
is too low", HTTP 400 on every call from then on). The first pass made no engine change. Tuning data only: train1–6, reworded (train1r–6r) and longtail. heldout19 was not run or read, and heldout20
was not looked for. Anthropic-direct lab calls (D97), ledger `.local/f2/ledger.jsonl`: **$1.00 of the $40 cap**. No
OpenRouter, no Modal.

Brief (from the integrator, after docs/research/h19-diagnosis.md): raise hidden facts reaching the agent through the
push check, without more confirmed false concerns or neutral packets; and check whether rare connectors are
under-served.

## 0. In plain words

- **On train the check loses little of what it reads.** On seeds 41–42 (train, reworded, longtail), the planted item was
  in the check's pool on 645 hidden checks, and the check dropped it on 31 (4.8%). heldout19's diagnosis found about 17%
  (15 of 90). The losses that matter on train sit before the check: in 138 of 783 checked hidden tasks the planted item
  was not among the 15 items the check reads.
- **Why it drops what it drops.** Of the 31: 17 entries said the item lands on the request and still answered `act`
  false; 11 items were not listed at all; 3 were judged to land on nothing. The `act`-false ones are mostly the
  request's own job already done (a certificate already renewed, an invoice already paid, an incident resolved, logs
  already purged, a claim already approved). Haiku reads these as go-aheads. Another clear case is a plain clash it
  wrote down and then passed: "LCY closed 14–22 November" against a flight from London City on 18 November.
- **Handing every item that lands is far too loose.** At $0 on the recorded replies, a parse that keeps an item whenever
  `hits` is not none, whatever `act` says, would add 17 planted facts (614 to 631 of 783). It would also add 303
  look-alikes (164 to 467 of 762) and 60 neutral packets (209 to 269 of 737, +8.1 points). Dead on the silence clause.
- **The prompt screen got 277 rows in before the credit ran out.** Those rows covered hidden and control only, with no
  neutral rows. Arm A says "already done" and "covers its day" are reasons to stop: planted 115 → 115 of 145,
  look-alikes 35 → 42 of 132. Arm R adds a lean when unsure, plus clauses for people facts and short group notices:
  planted 119 of 145, look-alikes 54 of 132, and 28% more items named. That is too few rows to choose an arm on. Read as
  it stands, both arms pay in look-alikes for little or no planted gain on train.
- **Rare connectors are not under-served by the push, the ask or freshness.** On longtail (seeds 41–42, $0 funnel,
  shipped coverage) 16 of 48 hidden facts were neither handed nor cited by an ask. Every one was in Eden's cache
  (`cached: true`, so sync and the weekly sweep had it), and 15 of them never entered the push's pool (one ranked 15th).
  That is the request-to-item match (F1's intent bridge, h19-diagnosis §1), not the connector. Where the planted item
  was in the check's pool, the check kept it every time (60 of 60 answered checks, seeds 41–44). That includes the two
  longtail analogues of heldout19's dropped notices, `lt-sofa-delivery-lift-out` and `lt-visitor-parking-suspended`
  (both residents' portal), 4 of 4 each.

## 1. What was run

1. **Base recordings** (`packages/sim/lab/f2-recall/base.sh SUITE SEED`: `bun run funnel --suite S --seeds N --jobs 1 --
--neutral --check live --check-dump …`). One process for each of train, reworded and longtail × seeds 41, 42, giving
   2,349 check rows. The shipped check ran live on Haiku 5.5. 82 rows failed open (null), as the shipped check does at
   about that rate. Seeds 43–44 also ran, but the credit ran out under them: 65% of their checks failed open, so they
   are not used.
2. **$0 readings of those replies:** `drops.py` (why each dropped planted item was dropped) and `offline.py` (the loose
   parse, H).
3. **Live screen** (`screen.ts --arms W,A,R`; arms in `arms.ts`, each the shipped `CHECK_SYSTEM` with the `act` sentence
   replaced, the shipped user turn and parser). Every row was re-asked under each arm, interleaved row by row in 12
   lanes. It stopped after 882 answered calls (277 rows with all three arms answered). From then on every call returned
   400 (the credit), and the script counted those as failed checks, so its printed totals are meaningless; the 277-row
   reading above comes from its `--out` rows.
4. **Longtail, no check** (`bun run funnel --suite longtail --jobs 4 --json …`, $0): where each missed rare-source fact
   stopped.

## 2. Numbers

Seeds 41–42, train + reworded + longtail, per task (the union of a task's checks), shipped check as recorded:

| reading              | planted (hidden) | look-alike (control) | neutral with a yes | items |
| -------------------- | ---------------: | -------------------: | -----------------: | ----: |
| W, shipped parse     |        614 / 783 |            164 / 762 |          209 / 737 | 2,402 |
| H, landed, any `act` |        631 / 783 |            467 / 762 |          269 / 737 | 3,220 |

Dropped while read (31 checks): `act` false 17, unlisted 11, `hits` none 3. By source: gmail 16, slack 7, drive 6,
calendar 2. Notes, whatsapp, residents, school, health, bank, tasks and trips were in the pool 30 times and never
dropped.

Live screen, 277 rows answered by all three arms (hidden and control rows only):

| arm                                                            | planted named | look-alike named | items named |
| -------------------------------------------------------------- | ------------: | ---------------: | ----------: |
| W (shipped)                                                    |     115 / 145 |         35 / 132 |         368 |
| A (already done and day clashes are reasons to stop)           |     115 / 145 |         42 / 132 |         354 |
| R (A + people facts, short group notices, "when unsure, true") |     119 / 145 |         54 / 132 |         472 |

## 3. What this points at, and what is left

- **Whether to resume.** The screen needs credit. With credit it is about $1.8 for seeds 41–42 with neutral rows, then a
  Pi pair. Expect little from a prompt lean on train: the check already keeps 95% of the planted items it reads there,
  and the pre-registered bar (hidden lower bound above 0 on a Pi pair) cannot be met when the room on train is a few
  facts. Arm A's targeted fix ("already done is a reason to stop") is the cleanest candidate and would be screened
  first. Arm R's look-alike cost (+54% on the partial screen) is the price of leaning.
- **heldout19's 17% versus train's 5% is a generalisation gap, and train cannot measure it.** The suites the check was
  written on are the ones it does well on. Closing that gap needs a fresh, unread suite as the measure (heldout20's
  role), with the arm still chosen on train.
- **The bigger lever is upstream.** 138 of 783 hidden tasks never put the planted item in front of the check, and all 16
  rare-source misses on longtail are retrieval misses with the item already cached. That belongs to F1's work on intent
  and meaning.
- **Lab note:** `screen.ts` counts a refused call as a failed check. A run that hits a billing or auth error should stop
  rather than continue (not built).

## 4. Pre-registration (committed before any paid call of this stage)

**The switch.** `pushCheckRecall` (engine, off; `CHECK_SYSTEMS` in push-check.ts). Form 1 is arm A and form 2 is arm R
above, word for word (`arms.ts` reads them from the engine). The shipped instructions are byte-identical at 0, and the
reply's format and parser are unchanged. Eval at 0: precision 0.65, recall 0.52, falseFireRate 0.

**Stage 1, the screen.** `screen.ts --arms W,W2,A,R` re-asks every answered row of the seed 41–42 base dumps (train,
reworded, longtail, recorded at 006b505c) and, if F8's dev20a–d have landed, of their base dumps recorded with
`base.sh` first. W2 is the shipped check asked again. Per task (a task's checks unioned), against W:

- noise = |W2 − W| in planted named;
- an arm passes if its planted named exceed W's by more than noise + 4, and its neutral tasks with a yes exceed W's by
  at most 3% of the neutral tasks;
- look-alikes named are reported, not barred: the agent rejects most of them, and the Pi pair guards confirmed concerns;
- if both arms pass, form 1 goes to Pi unless form 2's planted gain is at least twice form 1's;
- if neither passes, no Pi run, and the switch and its code are deleted (D814).

**Stage 2, the Pi pair** (only for the arm that passed; `pi.sh LABEL FORM`, one process a run, two at a time):

- runs: `--suite train`, `--suite reworded` and `--suite longtail`, seeds 41–44, `--variants hidden,control,neutral`;
  then dev20a–d seeds 41–44 if they are on main by then;
- regrade: `bun packages/sim/src/lab/i3-regrade.ts --results <out.json…> --conditions eden,eden~R --spend-ledger
.local/f2/ledger.jsonl --spend-cap 60 --run-label f2-sonnet`;
- report: `python3 -I packages/sim/lab/p3/report.py --pair eden~R:eden --cluster template <run dirs>`;
- **the bar**, all three on the pooled pair:
  - hidden raised (Sonnet), arm − default, template-clustered 95% lower bound above 0;
  - Sonnet-confirmed concerns (control and neutral) not up;
  - neutral tasks given a packet up by at most 3 points.
- pass: `pushCheckRecall` takes the form in `DEFAULT_CONFIG` (part `check`). Fail: deleted with its code and tests;
- no seed is added after a result is read. If the day ends before the credit returns, the switch is deleted.
