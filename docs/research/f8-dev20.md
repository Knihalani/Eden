# F8: the dev20 tuning suites (D1100)

Status: adopted (tooling), 2026-11-12. Coverage recorded the same day (D1102, below). Four new tuning suites, `dev20a`–`dev20d` (`--suite dev20`). They target the
weak points the F-sessions are working on, which train1–6, the reworded suites and longtail cover only thinly. They
are tuning suites, not held out.

## How they were written

The suites were written the way heldout19 was (D870). Each suite had its own isolated Opus subagent, and each
subagent saw only these:

- a format scaffold: heldout19's helpers and planting function, with no templates;
- the `HiddenTask` interface;
- the sim world API (`world.ts`, `names.ts`, `text.ts`, `rng.ts`, `rare-sources.ts`);
- a brief with exact targets and a self-check script that enforced them.

No author saw another suite, any engine code or any doc, and none ran the funnel or a model. To keep the situations
apart, each author had its own theme and language set:

| Suite  | Theme             | Non-English requests (10 each)                                                                    |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------- |
| dev20a | work and admin    | German 2, Spanish 2, French, Polish, Swedish, Turkish, Japanese (romaji), Brazilian Portuguese    |
| dev20b | family and health | Italian 2, Hindi (Latin) 2, Dutch, Indonesian, Czech, Danish, Romanian, Tagalog                   |
| dev20c | money and home    | French 2, European Portuguese, Spanish, Norwegian, Finnish, Hungarian, Catalan, Malay, Swahili    |
| dev20d | travel and social | Spanish 2, Italian, German, Japanese, Korean, Russian, Greek, Arabic, Vietnamese (native scripts) |

Each suite has 40 templates, five in each of the eight life areas, with `hidden`, `control` and `neutral` variants.
Above each template is a labelled comment: overlap, decoy kind, phrasing, source, anchored, silent, rare, knowledge
and language. The lists `DEV20X_{ANCHORED,RARE,SILENT,NON_ENGLISH,INDIRECT,QUESTION,KNOWLEDGE,NO_OVERLAP}` carry the
same categories, and `dev20xBefore` gives each silent edit's earlier copy. The authors' counts:

|                                                           | a        | b        | c        | d        |
| --------------------------------------------------------- | -------- | -------- | -------- | -------- |
| imperative / plan or statement / question                 | 12/18/10 | 12/18/10 | 12/18/10 | 12/18/10 |
| no word overlap / name only / one topic word              | 27/7/6   | 28/10/2  | 27/7/6   | 27/8/5   |
| decoy (a) resolved / (b) other entity / (c) condition met | 13/14/13 | 13/14/13 | 13/14/13 | 13/14/13 |
| anchored / rare (all 8 connectors) / silent edits         | 14/12/10 | 14/12/10 | 14/12/10 | 14/12/10 |
| needs world knowledge                                     | 8        | 11       | 7        | 10       |

`suites.test.ts` checks the following for seeds 41 and 44:

- the counts and ids;
- that refs are equal in hidden and control, and that no item carries a marker;
- the exact category counts;
- that the anchored requests are 12 words or fewer;
- that rare items sit in rare connectors, all eight used;
- each silent edit's `before` copy.

## Coverage: served by subagents per item, on the world's clock (D1102)

There is no Anthropic API credit (the owner confirmed it), so the shipped-coverage cards (D872's recipe) were made
with no API call at all:

1. **The clock.** `cold-start.ts` gave `buildPartner` no clock, so every recording ran on the wall clock, weeks past
   the worlds' 27 October 2026, and lean carding's 7-day window skipped almost every past item (F5's check: train1:41
   36 request-only reads against 179). The partner and its session events now run on the world's clock, advancing in
   real time (`--clock world`, the default; `--clock wall` reproduces the old recordings).
2. **The transport** (`card-queue.ts`, `card-queue-cli.ts`, `cold-start.ts --queue-dir D`). The shipped enricher runs
   as usual; each card call is answered from per-item answers, and any item without one is written to `D/pending`
   and its call fails. A subagent reads `D/brief.md` (the card call's own system prompt) and a batch of 40 items, and
   writes one line per item (the card or null, and up to four requests). `card-queue-cli.ts check` reads every answer
   as the engine would (`parseCards`, `parseRequests`). Replies are composed in the card call's own JSON and parsed
   by the real maker, so `--cards-out` records them exactly as a model call's. Answers are per item, not per call:
   the enricher's batches depend on timing (lanes, gather), so whole prompts rarely repeat between runs, while an
   item's block does.
3. **The run.** One dump pass over every world (dev20 seeds 41–44 every variant and the `user:41`–`user:44` days
   users; train1–6 and longtail seeds 41–44 every variant), 2,977 distinct items, answered by Haiku-model subagents
   in 76 batches of up to 50. Six answer files left an item out or mistyped a key; those items were offered again
   and answered. Then one recording pass per prompt form over the 136 worlds: form 3 (the default) made 2,068 card
   calls and form 0 made 2,065, with 0 failures and no new item pending. 1,780 of the 2,977 answers are cards (kind
   not none).

`cards-shipped.jsonl.gz` now holds, in order: heldout19's own planted items as D872 recorded them (205 lines, Haiku
5.5 on the wall clock: heldout19 is read and left alone), dev20's lines (3,858), then train's and longtail's (3,918,
last, so they win on a shared base item, as before). Every other old line (train, reworded and longtail on the wall
clock) was dropped. Label any figure from it "served by subagents per item (D1102), world clock".

What differs from a real recording: each item is answered alone, not among the nine others of a real batched call;
and the answers are a subagent's, not the API's. The two changes (clock and transport) were not separated: a
subagent-served recording on the wall clock was not made.

## Baselines

### No model, coverage none (D1100's first baseline)

Run on 2026-11-12, main 006b505c plus this change. Settings: default preset, seeds 41–44, stub reader, `--jobs 1`.

```bash
bun run funnel --suite dev20 --seeds 41,42,43,44 --jobs 1 -- --neutral
```

| Suite  | Hidden surfaced | Decoys surfaced | Neutral: any packet |
| ------ | --------------- | --------------- | ------------------- |
| dev20a | 35/160          | 31/160          | 87/160              |
| dev20b | 42/160          | 36/160          | 80/160              |
| dev20c | 43/160          | 29/160          | 79/160              |
| dev20d | 35/160          | 29/160          | 67/160              |
| total  | **155/640**     | **125/640**     | 313/640             |

Of the 155 hidden surfaced, 126 came by a rule path (candidates 114, grounded-conflict 8, fallback 4) and 29 were
listed only. Nothing reached the reader's pool, because intent is inert.

For comparison, train in the same shape (`--cards none --intent none`, seeds 41–44) surfaces hidden 456/768 (59%)
against dev20's 155/640 (24%). dev20 at `--cards none` is identical to the default run (155/125). So dev20 is much
harder than train for the no-model paths, as intended.

Correction (2026-11-12, after the merge): this note first reported a funnel bug, saying the NEUTRAL lines merged only
one shard under parallel `--jobs`. That was a misread. Each process prints its own `NEUTRAL` lines for its block of
seeds (/40 a suite here), and a grep for lines starting `NEUTRAL` picked up some of those. The run's figures are the
`merged NEUTRAL` lines, which read 87/80/79/67 (313/640), exactly as `--jobs 1`. `funnel-flags.test.ts` now checks
that the JSON's neutral block under `--jobs 2` equals one process's, and the funnel's note on per-process lines now
names NEUTRAL.

### At shipped coverage (D1102)

`bun run funnel --suite dev20 --seeds 41,42,43,44 -- --neutral`, default preset, stub reader: hidden 293/640, decoys
216/640 (dev20a 66/48, dev20b 79/58, dev20c 77/44, dev20d 71/66), neutral any packet 385/640. The enricher never
reads 54 hidden and 123 decoy planted items at shipped coverage, as for the other suites.

The re-record moved every shipped baseline (old file, then new; default preset, stub reader):

| Suite, seeds                     | Old (wall clock, Haiku API) | New (world clock, subagents) |
| -------------------------------- | --------------------------- | ---------------------------- |
| train, 41–42 (the main baseline) | 295/268                     | 318/299                      |
| train, 41–44                     | 597/541                     | 645/597                      |
| reworded, 41–42                  | 275/246                     | 298/290                      |
| longtail, 41–44                  | 64/50                       | 71/60                        |

Hidden and decoys both rise: the world's clock lets the enricher read the past week's items for intent, as a
deployment would, so the old shipped baselines understated what shipped coverage holds.
