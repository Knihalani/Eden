#!/bin/bash
# The distilled-reader experiment (docs/research/distilled-reader.md), end to end. Lab only, simulated data.
#
#   packages/sim/lab/distilled/run.sh labels   # $0: rebuild the train records from the committed labels, fit, CV
#   packages/sim/lab/distilled/run.sh live     # paid (about $1 on Haiku 5.5): intent requests, labels, CV, blind
#
# Needs HAIKU_API_KEY (live only; never printed) and, for the train worlds' seeds 43-44 cards, OPENROUTER_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
H=.local/dr
mkdir -p "$H"
MODE=${1:-labels}
NEW=$(bun -e 'import {PRESETS} from "./packages/sim/src/lab/presets";
  console.log(JSON.stringify({...PRESETS.NEW, askReaderWaitMs: 60000}))')
LEDGER="--spend-ledger $H/ledger.jsonl --spend-cap 5 --spend-headroom 0.5"
FUNNEL="bun packages/sim/src/lab/hidden-funnel.ts --ask --config $NEW --cards $H/cards43/cards-v2.jsonl"
FUNNEL="$FUNNEL --intent $H/intent/intent-v2.jsonl --no-record"

# Cards: the checked-in caches, cards-train-4344.jsonl holding glm-5.3-flash cards for the seed 43-44 train items the
# others lack (made once by cards-enrich.ts --funnel train --seeds 43,44, $0.016). Replayed only: a model makes
# different cards each time, and a different card is a different reader prompt, so the labels would no longer match.
mkdir -p "$H/cards43"
cat packages/sim/lab/cards/cards-v2.jsonl packages/sim/lab/cards/cards-train.jsonl \
  packages/sim/lab/cards/cards-train-4344.jsonl > "$H/cards43/cards-v2.jsonl"
# Intent requests (D87): replayed from the committed file made with Haiku for the train worlds and held-out 10-11
# (715 calls, $0.36), which the labels need for the same reason as the cards. `live` makes any missing ones.
mkdir -p "$H/intent"
[ -s "$H/intent/intent-v2.jsonl" ] ||
  gunzip -c packages/sim/lab/distilled/intent-v2.jsonl.gz > "$H/intent/intent-v2.jsonl"
if [ "$MODE" = live ]; then
  bun packages/sim/src/lab/cards-enrich.ts --dir "$H/intent" --funnel train --seeds 41,42,43,44 --intent \
    --model claude-haiku-5-5 --concurrency 6 $LEDGER
  bun packages/sim/src/lab/cards-enrich.ts --dir "$H/intent" --funnel heldout10,heldout11 --seeds 41,42 --intent \
    --model claude-haiku-5-5 --concurrency 6 $LEDGER
fi

RECORDS=""
for s in 41 42 43 44; do
  if [ "$MODE" = live ]; then
    # NEW with the live reader on every call, each call recorded: the labels ($0.57 for the four seeds).
    $FUNNEL --suite train --seeds $s --json $H/new-train-$s.json --reader live --reader-model claude-haiku-5-5 \
      --reader-cache $H/cache-train-$s.jsonl --distill record:$H/rec-train-$s.jsonl $LEDGER --run-label label-$s \
      > $H/label-$s.log 2>&1 &
  else
    rm -f $H/rec-train-$s.jsonl
    $FUNNEL --suite train --seeds $s --reader stub \
      --distill labels:packages/sim/lab/distilled/labels-train.jsonl,$H/rec-train-$s.jsonl > $H/label-$s.log 2>&1 &
  fi
  RECORDS="$RECORDS,$H/rec-train-$s.jsonl"
done
wait
# The labels replay writes its own model, so it never overwrites the one a live run (and the blind check) used.
if [ "$MODE" != live ]; then
  bun packages/sim/src/lab/distilled-fit.ts --records "${RECORDS#,}" --out $H/model-labels.json | tee $H/fit-labels.log
  exit 0
fi
bun packages/sim/src/lab/distilled-fit.ts --records "${RECORDS#,}" --out $H/model.json | tee $H/fit.log
# The note's 1.5x row: the same fit with the silent cut set where about a third of the calls are decided silent.
bun packages/sim/src/lab/distilled-fit.ts --records "${RECORDS#,}" --out $H/model-1p5x.json --silent-cut 0.1862 \
  > $H/fit-1p5x.log

# Train CV in the funnel: each suite's tasks scored by the fold model that left it out; escalations replay.
for m in model model-1p5x; do for s in 41 42 43 44; do
  $FUNNEL --suite train --seeds $s --json $H/cv-$m-$s.json --reader live --reader-model claude-haiku-5-5 \
    --reader-cache $H/cache-train-$s.jsonl --distill cascade:$H/$m.json $LEDGER --run-label cv-$m-$s \
    > $H/cv-$m-$s.log 2>&1 &
done; done
wait
# The one blind check (pre-registered in the note): NEW, then the frozen cascade on the same reader cache.
$FUNNEL --suite heldout10,heldout11 --seeds 41,42 --json $H/blind-new.json --reader live \
  --reader-model claude-haiku-5-5 --reader-cache $H/cache-blind.jsonl $LEDGER --run-label blind-new \
  > $H/blind-new.log 2>&1
$FUNNEL --suite heldout10,heldout11 --seeds 41,42 --json $H/blind-cascade.json --reader live \
  --reader-model claude-haiku-5-5 --reader-cache $H/cache-blind.jsonl --distill cascade:$H/model.json $LEDGER \
  --run-label blind-cascade > $H/blind-cascade.log 2>&1
grep -h '^distill' $H/cv-model-*.log $H/blind-cascade.log
python3 -I packages/sim/lab/scripts/funnel-score.py $H/new-train-4?.json $H/cv-model*-4?.json $H/blind-new.json \
  $H/blind-cascade.json
