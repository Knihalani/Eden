# M6: `heldout18`, a fresh blind suite for the askNudge question

Status: 2026-11-10, branch `claude/m6-heldout18` (from `claude/lucid-hypatia-v9wqk5` at `9be15991`). Decisions
D465–D466. **Lab only: no engine file changed.** Paid calls went to the Anthropic API with `HAIKU_API_KEY`,
`claude-haiku-5-5`, through the lab provider (D97), with `OPENROUTER_API_KEY` unset, on one ledger
(`.local/m6/ledger.jsonl`) with a hard cap of $0.3: **Anthropic-direct lab figures. Spent: $0.0346** (83 calls).

**Unrun. No funnel or agent has run on `heldout18`, and nobody has read Eden's output on it.** It is in
`UNREAD_BLIND`; never tune on it.

## In plain words

- Held-out 9–17 have all been read, so a blind check needed a new suite. `heldout18` is that suite: 32 everyday
  requests, four in each of eight life areas, each with a hidden, a control and a neutral variant, as heldout14–17.
- Eight templates (one per area) read naturally as their fact arriving later the same day, for `pi-ab --late`.
- Thirteen templates are short requests (12 words or fewer) that name one person, thing or date, where the planted
  item names it the way real messages do (a surname, "your sister", "Mr Price", "Fri 06/11", "Account ending 4402")
  rather than echoing the request. These are the cases the askNudge question (D455–D457) turns on: a request that
  names something specific, which the first candidates may not hold. The author picked them from the brief alone,
  without knowing how the engine searches or ranks.
- Its cards and intent requests are cached for seeds 41–44 for $0.0346, and every planted item (256 of 256 across
  hidden and control) has requests.

## 1. How it was written

As A19 wrote heldout17 (docs/research/a19-heldout17.md), with one tightening: the author saw **no** held-out suite.
`packages/sim/src/lab/hidden-heldout18.ts` was written by an author subagent that read only:

- a scaffold this session cut from `hidden-heldout17.ts`: its imports, item helpers (`mail`, `notice`, `chat`,
  `event`, `doc`), `Ctx`/`Spec` types and planting function, and one example template marked "format only, do not
  reuse" (no other template body, no late list);
- two training suites as examples of style, `hidden-train1.ts` (all) and `hidden-train2.ts` (head, plus its template
  names and requests so it would not reuse a situation);
- the `HiddenTask` interface (hidden-context.ts lines 1–30);
- the sim world API (`world.ts`, `names.ts`, `text.ts`, `rng.ts`);
- a brief: 32 templates over 8 areas, overlap and decoy mixes as heldout17's, 8 late arrivals, at least 12 short
  anchored requests (at least 4 on a person, 4 on a date), and the leak rule.

It opened no engine, ranking, reader, prompt, card, intent, docs, research or cache file. It also grepped the root
`package.json` and read the head of `scripts/typecheck.sh` to find the typecheck command; the harness showed it
`packages/sim/CLAUDE.md` and `packages/sim/src/lab/CLAUDE.md` (lab rules, no engine logic). It ran the typecheck,
prettier and its own planting check, no model, funnel or agent. This session read the file's header, exports and the
author's report (template names, lists, counts), and no template body.

By the author's count:

- **Templates:** 32, four per area (work, family, health, money, travel, home, admin, social); every source kind is
  used (mail, service notifications, Slack, calendar, Drive).
- **Word overlap with the request:** 10 share no content word, 11 share only a name, 11 share one topic word.
- **Decoys:** 11 resolved, expired or superseded; 11 about another entity or date; 10 where the condition is met or
  the item allows the request.
- **Late arrivals** (`HELDOUT18_LATE`, one per area): `pricing-deck-via-supplier-portal`, `class-trip-early-coach`,
  `repeat-prescription-on-hold`, `transfer-before-late-payroll`, `airport-cab-flight-retimed`,
  `washer-install-water-off`, `tenancy-papers-e-sign`, `dinner-friends-drop-out`. Hidden item and decoy are dated 27
  October 2026, 08:12–08:52 UTC, before the world's NOW. The format and `--late` behave as A19 §2 describes
  (`--templates` filters tasks, not the world; `--days` has no late mode).
- **Short anchored requests** (`HELDOUT18_ANCHORED`, 13, every area; fixed before any run, D466):

| Anchor | Templates |
| --- | --- |
| person (7) | `pricing-deck-via-supplier-portal`, `leave-during-cutover-week`, `sister-away-sleepover`, `crown-invoice-cancelled`, `gig-tickets-already-repaid`, `accountant-on-leave`, `leaving-drinks-moved` |
| date (4) | `retro-vs-company-offsite`, `paris-train-already-booked`, `carpet-clean-vs-floor-sanding`, `summit-vs-jury-service` |
| thing (2) | `card-zero-percent-ending`, `armchair-return-window` |

The author flags `summit-vs-jury-service` as the weakest date anchor (the item gives a range from a start date rather
than the request's own day).

## 2. Registration and tests

- `SUITES.heldout18`, `UNRUN_BLIND` (kept out of `all`), `UNREAD_BLIND` (`["heldout18"]`: the funnel calls a run
  naming it the blind read) and `NEUTRAL_SUITES`; `INTENT_COVERS.heldout18` = seeds 41–44.
- `suites.test.ts`, at seeds 41 and 44: 32 tasks per variant and 32, 32, 0 planted items; the same text, detail and
  template across variants; ids `w<seed>:heldout18[-variant]:`, unique, and unique template names; refs of the base
  world's `<kind>-<index>` shape, equal in hidden and control, and no template name, `heldout`, `h18`, `planted` or
  `decoy` in any item's ref, id, title or meta; `HELDOUT18_LATE` 8 and `HELDOUT18_ANCHORED` at least 12, all of the
  suite's templates, every anchored request at most 12 words; out of `all`. A new registry test: suite names unique,
  every `UNRUN_BLIND` name a suite, every `UNREAD_BLIND` name in `UNRUN_BLIND`.
- `cards-disk.test.ts`: every planted item has requests at seeds 41 and 44 (now 24 worlds; timeout 150 s → 180 s).
- `cards-distill.test.ts`: heldout18's planted items are guarded from distillation training.

## 3. Caches

Made with `cards-enrich.ts --funnel heldout18 --seeds 41,42,43,44 --model claude-haiku-5-5` into a copy of the
checked-in files; the new lines were appended, and each old file is an exact prefix of the new one (`cmp`).

| Ledger run | What | Calls | $ |
| --- | --- | --- | --- |
| `m6-h18-cards` | cards, +139 items, into `cards-v2.jsonl` (5,320 → 5,459 lines) | 14 | 0.0104 |
| `m6-h18-intent` | intent, 140 items of 190 | 19 | 0.0176 |
| `m6-h18-intent-topup-b1` | the 50 items that came back without requests, one per call | 50 | 0.0066 |
| **Total** | | **83** | **0.0346** |

`intent-v2.jsonl.gz` now holds 8,433 lines (plain md5 `170bf7bb488b3cc46c6efcf5aa390d17`); dry runs find 0 items
left for cards or intent. A one-off script over all four seeds: 256 planted items (hidden and control), 256 with
non-empty requests; all items of each world 1,496/1,502 to 1,509/1,510 covered.

Commands (repo root):

```bash
D=.local/m6/cards; mkdir -p $D
cp packages/sim/lab/cards/cards-v2.jsonl $D/
gunzip -c packages/sim/lab/distilled/intent-v2.jsonl.gz > $D/intent-v2.jsonl
C="--dir $D --funnel heldout18 --seeds 41,42,43,44 --model claude-haiku-5-5 --spend-ledger .local/m6/ledger.jsonl \
  --spend-cap 0.3 --spend-headroom 0.02 --cap 0.28 --spend $D/spend.jsonl"
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cards-enrich.ts $C --run-label m6-h18-cards
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cards-enrich.ts $C --intent --run-label m6-h18-intent
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cards-enrich.ts $C --intent --batch 1 \
  --run-label m6-h18-intent-topup-b1
cp $D/cards-v2.jsonl packages/sim/lab/cards/cards-v2.jsonl
gzip -9 -n -c $D/intent-v2.jsonl > packages/sim/lab/distilled/intent-v2.jsonl.gz
```

## 4. For the blind read (D466)

The read that spends heldout18 should pre-register its rule before it runs, report the whole suite (the primary
figure) and the `HELDOUT18_ANCHORED` subset separately, and move `heldout18` out of `UNREAD_BLIND` in the same change.
Thirteen templates at seeds 41–44 give 52 hidden tasks in the subset: enough for a direction, wide intervals; the
whole suite gives 128.

## 5. Merge notes

- The two cache files are append-only. If another branch also appended, merge by concatenating the new lines after
  the common prefix (unzip the intent file, then gzip again with `-9 -n`). Do not take one side's file.
- D465–D466 were the numbers this session was given; renumber on merge if they clash.
