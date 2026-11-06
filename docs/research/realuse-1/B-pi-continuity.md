# RealUse-1 part B: live Pi tier on the continuity suites (held-out 10–13, read)

Status: results, 2026-11-06. Design: [benchmark-realuse-1.md](../benchmark-realuse-1.md) (T1, continuity suites,
attribution, hosted connectors). Held-out 10, 11, 12 and 13 have all been read before (LAB.md, D72–D98, D112), so
every figure here is on **read** suites: comparable with earlier runs, not a blind result.

Every paid call went to the Anthropic API with `HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent, grader,
cards, intent, reader), through the lab provider (D97), with `OPENROUTER_API_KEY` unset in every process. These are
**Anthropic-direct** lab figures, not the shipped OpenRouter route (D12). The agent is the **Pi harness**
(`@earendil-works/pi-agent-core@1.3.0`).

## Headline (pooled over held-out 10–13, direct connectors, 320 paired tasks per kind)

|                                                                 | tools (agent alone) | eden          | both          |
| --------------------------------------------------------------- | ------------------- | ------------- | ------------- |
| hidden facts raised                                             | 13.1%               | **74.4%**     | 65.6%         |
| false concerns on controls                                      | 0.6%                | 3.1%          | 1.6%          |
| wall p50 hidden / control (s)                                   | 4.51 / 4.54         | 4.40 / 5.52   | 5.37 / 5.61   |
| Eden's share of the critical path, hidden / control             | 0%                  | 41% / 42%     | 21% / 18%     |
| $ per 1,000 tasks all-in (Haiku agent + Eden), hidden / control | 0.354 / 0.364       | 0.652 / 0.775 | 0.548 / 0.551 |

Paired differences, bootstrap 95% (a difference only where the interval excludes 0, marked *):

- **eden − tools:** hidden +61.3 pts (+55.6..+66.9)_; false concerns +2.5 pts (+0.6..+4.7)_; wall on hidden
  +0.18 s (−0.08..+0.42), on controls +0.66 s (+0.42..+0.91)_; $/1k +0.30 hidden, +0.41 control (Eden's reader
  +0.323 (+0.296..+0.354)_ and +0.419 (+0.388..+0.452)_; the agent's own spend −0.027 (−0.045..−0.009)_ hidden).
- **both − tools:** hidden +52.5 pts (+46.9..+57.8)_; false concerns +0.9 pts (−0.6..+2.5); wall +0.89 s hidden_,
  +0.84 s control*.
- **eden − both:** hidden +8.7 pts (+4.4..+13.1)* for eden; false concerns +1.6 pts (−0.3..+3.4) (no difference);
  eden is 0.71 s faster on hidden tasks* and costs $0.129/1k more in Eden's reader* (both gets no `ask_context` in
  Pi, LAB.md).

Spend: **$1.87 of the $9 cap** (ledger `.local/ledger.jsonl`, all labels `rb-*`): agent $0.970, Eden's reader
$0.663, grader $0.182, cards $0.051 (up-front enrichment $0.029, live cards in the first smoke run $0.021, in
held-out 12 seed 42 $0.001). Nothing
was dropped: every arm in the brief ran.

## What ran

| Job               | Suite     | Seeds          | Profile | Conditions                                    | Runs    | $                          |
| ----------------- | --------- | -------------- | ------- | --------------------------------------------- | ------- | -------------------------- |
| main              | heldout13 | 41, 42, 43, 44 | direct  | tools, eden, both                             | 4 × 192 | 0.120, 0.124, 0.125, 0.118 |
| main              | heldout11 | 41, 42         | direct  | tools, eden, both                             | 2 × 192 | 0.108, 0.105               |
| main              | heldout10 | 41, 42         | direct  | tools, eden, both                             | 2 × 192 | 0.105, 0.102               |
| main              | heldout12 | 41, 42         | direct  | tools, eden, both                             | 2 × 192 | 0.124, 0.128               |
| attribution       | heldout13 | 41, 42         | direct  | eden~minus-{reader,intent,sync,grounds,graph} | 2 × 320 | 0.246, 0.243               |
| hosted            | heldout13 | 41, 42         | hosted  | tools, eden                                   | 2 × 128 | 0.079, 0.075               |
| enrichment, smoke | —         | —              | —       | cards-enrich ×3, two 4-task smokes            | —       | 0.029, 0.034               |

Every process: one seed, at most three at once, `--variants hidden,control`, `--config default`, time scale 1,
`--push signals` (default rates), 0 errors, 0 ungraded, `overBudget: reader 0, cards 0` (no session cap cut a read),
0 secrets leaked in any arm (agent-ab-report `leaks 0`). The attribution job ran without a tools arm: the main runs
hold tools and eden for the same tasks, so `--reuse-arms` had nothing left to save; each ablation is paired by task
with the main run's eden arm (same seeds, same tasks, another process, so the pair also carries run-to-run noise).

## Replay caches

- **Cards.** `cards-v2.jsonl` (checked in) lacked 136 prefilter-passing items of held-out 10–12 seeds 41–42 and 166 of
  held-out 13 seeds 41–44 (the planted items among them); `cards-enrich.ts` made them on Anthropic (31 calls,
  $0.0207). The first smoke run then made 49 card calls live for 4 tasks: with intent on, the engine sends every item
  to the card maker, and `DiskCardMaker` makes a card live for any item without one in the card files even when the
  intent file holds that item's requests and card. Those intent-file cards come from the same call shape (the intent
  prompt, Haiku) as pi-ab's live call, so they were merged into the replayed card file
  (`.local/rb/enrich/cards-merged.jsonl`: cards-v2 plus the top-up, then every intent-file card for an item not in
  it, 11,381 items). After that the runs made 15 cards live in total (held-out 12 seed 42). Consequence: Eden's
  background column is near zero ($0.001/1k), a warm-cache figure; the cold-start enrichment is measured separately
  below.
- **Intent requests.** `intent-v2.jsonl.gz` covers held-out 10–11 seeds 41–42 and held-out 13 seeds 41–44
  (INTENT_COVERS); held-out 12 seeds 41–42 were missing, made with `cards-enrich.ts --intent` on Anthropic (13 calls,
  121 items, $0.0085). Every run replayed the topped-up file explicitly (`--intent .local/rb/enrich/intent-v2.jsonl`);
  the header of held-out 13 seed 41 reads `intent: replayed 1535 of 1541 items`. No run was intent inert.
- **Cold-start enrichment** (estimate from measured unit cost): cards-enrich measured $0.0000685 per item on Haiku;
  at about 1,540 items per world that is about $0.11 per user once, not per task.

## T1 metrics per suite (direct)

Rates are the share of must-facts the grader found raised; control rate is a false concern. Wall p50 and Eden's share
of the critical path are given hidden / control. All-in $ per 1,000 tasks = agent + Eden's per-task reader + Eden's
background (cards), hidden / control.

| suite     | arm   | n per kind | hidden | false concern | wall p50 (s) | Eden path share | all-in $/1k   |
| --------- | ----- | ---------- | ------ | ------------- | ------------ | --------------- | ------------- |
| heldout10 | tools | 64         | 0.203  | 0.031         | 4.67 / 5.29  | 0% / 0%         | 0.342 / 0.355 |
| heldout10 | eden  | 64         | 0.734  | 0.062         | 4.26 / 4.83  | 35% / 36%       | 0.556 / 0.616 |
| heldout10 | both  | 64         | 0.562  | 0.031         | 5.09 / 5.86  | 17% / 13%       | 0.486 / 0.504 |
| heldout11 | tools | 64         | 0.188  | 0.000         | 4.24 / 4.24  | 0% / 0%         | 0.331 / 0.341 |
| heldout11 | eden  | 64         | 0.719  | 0.062         | 4.09 / 5.24  | 42% / 42%       | 0.568 / 0.713 |
| heldout11 | both  | 64         | 0.688  | 0.031         | 5.06 / 5.15  | 20% / 19%       | 0.518 / 0.496 |
| heldout12 | tools | 64         | 0.109  | 0.000         | 4.65 / 4.67  | 0% / 0%         | 0.422 / 0.409 |
| heldout12 | eden  | 64         | 0.625  | 0.000         | 6.10 / 5.98  | 42% / 42%       | 0.761 / 0.790 |
| heldout12 | both  | 64         | 0.516  | 0.000         | 6.30 / 5.51  | 17% / 17%       | 0.614 / 0.565 |
| heldout13 | tools | 128        | 0.078  | 0.000         | 4.55 / 4.48  | 0% / 0%         | 0.339 / 0.359 |
| heldout13 | eden  | 128        | 0.820  | 0.016         | 3.81 / 5.95  | 42% / 45%       | 0.686 / 0.877 |
| heldout13 | both  | 128        | 0.758  | 0.008         | 5.12 / 5.71  | 25% / 20%       | 0.561 / 0.595 |
| pooled    | tools | 320        | 0.131  | 0.006         | 4.51 / 4.54  | 0% / 0%         | 0.354 / 0.364 |
| pooled    | eden  | 320        | 0.744  | 0.031         | 4.40 / 5.52  | 41% / 42%       | 0.652 / 0.775 |
| pooled    | both  | 320        | 0.656  | 0.016         | 5.37 / 5.61  | 21% / 18%       | 0.548 / 0.551 |

Paired differences per suite (hidden fact raised; false concern), bootstrap 95%:

| suite     | eden − tools                               | both − tools                             | eden − both                              |
| --------- | ------------------------------------------ | ---------------------------------------- | ---------------------------------------- |
| heldout10 | +53.1 (+40.6..+65.6)*; +3.1 (−3.1..+9.4)   | +35.9 (+25.0..+48.4)*; 0.0               | +17.2 (+7.8..+28.1)*; +3.1 (−4.7..+10.9) |
| heldout11 | +53.1 (+40.6..+65.6)_; +6.2 (+1.6..+12.5)_ | +50.0 (+37.5..+62.5)*; +3.1 (0.0..+7.8)  | +3.1 (−6.2..+12.5); +3.1 (0.0..+7.8)     |
| heldout12 | +51.6 (+35.9..+65.6)*; 0.0                 | +40.6 (+28.1..+53.1)*; 0.0               | +10.9 (−1.6..+25.0); 0.0                 |
| heldout13 | +74.2 (+66.4..+81.2)*; +1.6 (0.0..+3.9)    | +68.0 (+59.4..+76.6)*; +0.8 (0.0..+2.3)  | +6.2 (0.0..+12.5); +0.8 (0.0..+2.3)      |
| pooled    | +61.3 (+55.6..+66.9)_; +2.5 (+0.6..+4.7)_  | +52.5 (+46.9..+57.8)*; +0.9 (−0.6..+2.5) | +8.7 (+4.4..+13.1)*; +1.6 (−0.3..+3.4)   |

Wall time and Eden's critical path, paired (seconds, a − b):

| suite     | kind    | eden − tools wall     | both − tools wall     | eden − both wall      | Eden path eden / both |
| --------- | ------- | --------------------- | --------------------- | --------------------- | --------------------- |
| heldout10 | hidden  | −0.09 (−0.67..+0.49)  | +0.71 (+0.17..+1.27)* | −0.80 (−1.37..−0.27)* | 1.60 / 0.91           |
| heldout11 | hidden  | +0.07 (−0.45..+0.60)  | +0.74 (+0.23..+1.27)* | −0.67 (−1.19..−0.16)* | 1.94 / 1.03           |
| heldout12 | hidden  | +1.11 (+0.47..+1.69)* | +1.62 (+1.06..+2.19)* | −0.51 (−1.21..+0.15)  | 2.51 / 1.12           |
| heldout13 | hidden  | −0.09 (−0.47..+0.31)  | +0.70 (+0.32..+1.08)* | −0.80 (−1.14..−0.45)* | 1.88 / 1.31           |
| pooled    | hidden  | +0.18 (−0.08..+0.42)  | +0.89 (+0.65..+1.14)* | −0.71 (−0.96..−0.48)* | 1.96 / 1.14           |
| pooled    | control | +0.66 (+0.42..+0.91)* | +0.84 (+0.61..+1.06)* | −0.18 (−0.40..+0.05)  | 2.31 / 1.01           |

Tokens, calls and packets per task (pooled, direct, hidden / control):

| arm   | agent input tok (of which cache read / write) | output tok | agent connector calls | Eden source calls: search / list / fetch | reader calls | packets (bytes)         | asks (answer bytes)     |
| ----- | --------------------------------------------- | ---------- | --------------------- | ---------------------------------------- | ------------ | ----------------------- | ----------------------- |
| tools | 2694 (2091 / 598) / 2801 (2177 / 618)         | 516 / 530  | 3.23 / 3.41           | —                                        | —            | —                       | —                       |
| eden  | 1477 (557 / 917) / 1743 (753 / 985)           | 414 / 447  | 0 / 0                 | 0.64 / 3.30 / 4.70 ; 0.70 / 3.26 / 5.88  | 1.23 / 1.62  | 1.05 (392) / 0.66 (220) | 0.72 (605) / 1.16 (836) |
| both  | 2661 (2074 / 583) / 2785 (2175 / 605)         | 517 / 523  | 2.43 / 3.05           | 0.31 / 3.26 / 2.55 ; 0.29 / 3.25 / 2.36  | 0.76 / 0.74  | 1.07 (399) / 0.66 (219) | —                       |

Agent input tokens are the total input of the agent's requests; the cache columns are Anthropic's prompt cache. Eden's
"list" calls are its sync polls (3.3 a task at these push rates); "fetch" the reader's and sync's single-item reads.
Every table above, with wall p90 and mean, is in `packages/sim/lab/realuse-1/B/analysis.json` (keys
`suite|kind|arm`), printed by `tables.py`.

## Attribution: held-out 13, seeds 41–42, direct (each ablation paired with eden, n = 64 per kind)

Eden on these 64 tasks: hidden 79.7%, false concerns 1.6%.

| eden minus | hidden raised | Δ hidden vs eden          | Δ false concern  | Δ wall s (hidden)     | Δ Eden path s (hidden) | Δ Eden reader $/1k (hidden) |
| ---------- | ------------- | ------------------------- | ---------------- | --------------------- | ---------------------- | --------------------------- |
| reader     | 54.7%         | **−25.0 (−37.5..−12.5)*** | −1.6 (−4.7..0.0) | −0.05 (−0.53..+0.44)  | −0.66 (−0.95..−0.38)*  | −0.368*                     |
| intent     | 60.9%         | **−18.8 (−34.4..−4.7)***  | −1.6 (−4.7..0.0) | +0.33 (−0.17..+0.87)  | +0.18 (−0.11..+0.48)   | +0.036                      |
| sync       | 37.5%         | **−42.2 (−56.2..−28.1)*** | −1.6 (−4.7..0.0) | +2.26 (+1.58..+2.90)* | +2.02 (+1.53..+2.46)*  | +0.111*                     |
| grounds    | 84.4%         | +4.7 (−6.2..+15.6)        | 0.0              | +0.07 (−0.42..+0.57)  | +0.05 (−0.20..+0.33)   | +0.035                      |
| graph      | 78.1%         | −1.6 (−9.4..+6.2)         | +1.6 (0.0..+4.7) | −0.28 (−0.64..+0.08)  | −0.10 (−0.29..+0.10)   | −0.030                      |

Reading: sync, the reader and intent each carry a measurable share of what Eden raises on held-out 13; without sync
Eden searches on demand (18 source searches a task instead of 0.6) and is 2.3 s slower. Grounds and graph show no
difference on this sample; the controls are too clean here (1 false concern in 64 for eden) to show the grounds'
precision role. Without the reader, control-task wall time drops 0.86 s (−1.30..−0.48)* and Eden's $ by $0.50/1k*.

## Direct vs hosted connectors (held-out 13, seeds 41–42, n = 64 per kind)

| arm   | hidden direct → hosted | Δ hidden            | Δ false concern | Δ wall s hidden / control                    | Δ Eden path s hidden  |
| ----- | ---------------------- | ------------------- | --------------- | -------------------------------------------- | --------------------- |
| tools | 10.9% → 4.7%           | −6.2 (−12.5..−1.6)* | 0.0             | +0.55 (+0.13..+0.96)* / +0.49 (−0.26..+1.28) | —                     |
| eden  | 79.7% → 84.4%          | +4.7 (−4.7..+14.1)  | 0.0             | +0.21 (−0.29..+0.71) / +0.10 (−0.43..+0.61)  | +0.33 (+0.01..+0.65)* |

The slower hosted profile costs the agent alone 6 points and half a second; Eden's quality is unchanged and its own
path gets 0.33 s longer.

## Cost per 1,000 tasks per connector plan (`market.py`, pooled direct, 320 paired tasks per kind)

Agent re-priced per model from each request's token split (an estimate: it assumes a bigger agent reads and writes
the tokens the Haiku agent did); Eden's reader as billed on Haiku; connector calls priced per plan; "push" column
leaves Eden's sync polls unbilled. Hidden tasks / control tasks:

| Agent      | Connector plan                | Agent alone     | Agent + Eden      | Agent + Eden, sync by push |
| ---------- | ----------------------------- | --------------- | ----------------- | -------------------------- |
| Haiku 5.5  | First-party APIs (quota only) | 0.354 / 0.364   | 0.652 / 0.775     | 0.652 / 0.775              |
| Haiku 5.5  | Composio (overage)            | 1.322 / 1.387   | 3.461 / 4.072     | 2.470 / 3.094              |
| Haiku 5.5  | Unified.to (Pro)              | 2.773 / 2.922   | 7.676 / 9.018     | 5.198 / 6.573              |
| Haiku 5.5  | Arcade.dev (Team)             | 32.604 / 34.458 | 94.308 / 110.681  | 61.277 / 78.087            |
| Haiku 5.5  | Pipedream Connect (overage)   | 39.054 / 41.277 | 113.039 / 132.662 | 73.402 / 93.550            |
| Haiku 5.5  | Zapier MCP (10k tasks)        | 83.559 / 88.326 | 242.285 / 284.333 | 157.064 / 200.241          |
| Sonnet 5.5 | First-party APIs (quota only) | 7.089 / 7.290   | 6.873 / 7.513     | 6.873 / 7.513              |
| Sonnet 5.5 | Composio (overage)            | 8.057 / 8.312   | 9.683 / 10.810    | 8.692 / 9.832              |
| Sonnet 5.5 | Unified.to (Pro)              | 9.508 / 9.847   | 13.897 / 15.756   | 11.420 / 13.311            |
| Opus 5.5   | First-party APIs (quota only) | 13.760 / 14.144 | 13.311 / 14.454   | 13.311 / 14.454            |
| Opus 5.5   | Unified.to (Pro)              | 16.179 / 16.701 | 20.335 / 22.697   | 17.857 / 20.253            |

Cost per hidden fact raised with first-party APIs: Haiku $2.70 alone vs $0.88 with Eden; Sonnet $54.01 vs $9.24;
Opus $104.84 vs $17.90. On per-call-priced connector plans Eden's own calls (8.7 a hidden task, 9.8 a control)
dominate: with Composio and Haiku the hidden-task cost rises 2.6×. The full tables (every plan and model, held-out 13
direct and hosted separately) are in `packages/sim/lab/realuse-1/B/market.md`.

**Traffic weighting.** The design's weighted figure (1 hidden, 1 control and 8 neutral tasks in 10) needs the
`neutral` variant, which only heldout14 has; it cannot be computed on the continuity suites. A 50/50 hidden/control
mix of the pooled all-in figures is $0.359 (tools), $0.713 (eden) and $0.549 (both) per 1,000 tasks on Haiku with
first-party APIs (arithmetic on the table above).

## Caveats

- Read suites; Anthropic-direct transport; Haiku in every role, including the grader.
- Cards were replayed from a merged cache (above), so the background column is warm-cache; cold-start enrichment is
  an estimate from a measured unit cost.
- The ablations ran in their own processes and are paired with the main runs' eden arm: pairs carry process-to-process
  noise as well as the part's effect. `--replay` was not used, so each arm's reader and grader calls were live.
- Controls are near-clean for every arm (0–6% false concerns), so precision differences are mostly within noise.

## Harness fix made for this run

`pi-ab.ts` threw `needs OPENROUTER_API_KEY` at start-up even when every role ran on Anthropic. Commits `44dca7074` and
`2e787a279`: the key is required only for the models `openRouterModels` (free.ts) names; one list of the run's models
feeds both the pacer and the check. Test in `free.test.ts`; reviewed by the `reviewer` subagent (APPROVE; its two
low findings fixed in the second commit). Jobs run before the second commit ran the first; the two are behaviourally
identical.

## Reproduce

```bash
L="--spend-ledger .local/ledger.jsonl --spend-cap 9 --spend-headroom 0.3"
mkdir -p .local/rb/enrich && cp packages/sim/lab/cards/cards-v2.jsonl .local/rb/enrich/
gunzip -c packages/sim/lab/distilled/intent-v2.jsonl.gz > .local/rb/enrich/intent-v2.jsonl
E="env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cards-enrich.ts --dir .local/rb/enrich --model claude-haiku-5-5 $L"
$E --run-label rb-enrich --funnel heldout10,heldout11,heldout12 --seeds 41,42
$E --run-label rb-enrich --funnel heldout13 --seeds 41,42,43,44
$E --run-label rb-enrich --funnel heldout12 --seeds 41,42 --intent
# merged card file: cards-v2 (topped up), then each intent-file card for an item not in it
python3 -I -c "import json; o=open('.local/rb/enrich/cards-merged.jsonl','w'); s=set()
for f in ['.local/rb/enrich/cards-v2.jsonl','.local/rb/enrich/intent-v2.jsonl']:
  for l in open(f):
    d=json.loads(l)
    if d['h'] not in s: s.add(d['h']); o.write(json.dumps({'h':d['h'],'c':d['c']})+'\n')"
# ablate-variants.json: PRESETS' minus-<part> settings (presets.ts) for reader, intent, sync, grounds, graph
cp packages/sim/lab/realuse-1/B/ablate-variants.json .local/rb/ablate.json
cp packages/sim/lab/realuse-1/B/run.sh .local/rb/run.sh && mkdir -p .local/rb/runs
xargs -P 3 -L 1 .local/rb/run.sh < packages/sim/lab/realuse-1/B/jobs.txt     # 14 jobs, one seed each
# run.sh: env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite S --seeds N --variants hidden,control
#   --conditions C --config default --variant-config "$(cat .local/rb/ablate.json)"
#   --cards .local/rb/enrich/cards-merged.jsonl --cards-out R/L.cards.jsonl --intent .local/rb/enrich/intent-v2.jsonl
#   --source-profile packages/sim/lab/before-after/market-profiles/{direct,hosted}.json --push signals
#   --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5
#   --budget 2 $L --run-label rb-L --timeline R/L.timeline --out R/L.json
R=.local/rb/runs
for f in $R/h1*.json; do bun packages/sim/src/lab/pi-ab-report.ts $f; bun packages/sim/src/lab/agent-ab-report.ts $f; done
python3 -I packages/sim/lab/realuse-1/B/analyze.py out.json $R/h1*-?-4?.json $R/h13-abl-4?.json
python3 -I packages/sim/lab/realuse-1/B/tables.py out.json
python3 -I packages/sim/lab/before-after/market.py market.md direct=$(ls $R/h1?-d-4?.json | paste -sd,) \
  direct-h13-4142=$R/h13-d-41.json,$R/h13-d-42.json hosted-h13-4142=$R/h13-h-41.json,$R/h13-h-42.json
```

Files: `packages/sim/lab/realuse-1/B/` holds `analysis.json` (every arm and paired difference, per suite and pooled),
`runs.json` (each process's header: spend, background, overBudget, intent coverage, profile), `market.md`, the
per-run `reports/*.pi-report.txt` and `*.agent-report.txt`, and the scripts above. No transcripts are kept.
