# F8: the dev20 tuning suites (D1100)

Status: adopted (tooling), 2026-11-12. Four new tuning suites, `dev20a`–`dev20d` (`--suite dev20`). They target the
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

## Coverage: not recorded (blocked)

The brief asked for the shipped-coverage cards (D872: `cold-start.ts --cards-out`, Haiku 5.5, seeds 41–44, every
variant and the days users). They could not be made. On 2026-11-12 every call through `HAIKU_API_KEY` returned 400
"credit balance is too low" ($0 spent), and OpenRouter is not allowed for the lab (D818). So dev20 is not in
`SHIPPED_COVERS`. A funnel on dev20 replays the checked-in cards only for the base world's items, gets no card for a
planted item, and runs intent-inert. Every line it prints says `[intent inert: no replay] [coverage: none]`.

The recipe, once the key has credit (about $0.35 a form for 48 worlds, at D872's rate):

```bash
U=$(for x in a b c d; do for s in 41 42 43 44; do for v in hidden control neutral; do printf "dev20$x:$s:$v,"; done; done; done)
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts --users ${U%,} --cards-out .local/f8/dev20-f3.jsonl \
  --spend-ledger .local/f8/ledger.jsonl --spend-cap 2 --run-label f8-dev20-f3            # form 3, the default (D1062)
# the same with --set '{"cardsRequestsFix":false}' --cards-out .local/f8/dev20-f0.jsonl for the shipped form's lines
```

Then:

1. Put both files' lines ahead of the existing lines in `cards-shipped.jsonl.gz`, so train's cards still win on
   shared base items.
2. Add dev20 to `SHIPPED_COVERS` and `SHIPPED_FORM_COVERS[3]`.
3. Re-record the baseline below at shipped coverage.

## Baseline (no model, coverage none)

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
