#!/usr/bin/env bash
# F1, once Anthropic credit is back (docs/research/f1-intent-bridge.md §3, §6). Runs in order, each step skipped when its
# output exists: (1) the glossary's own vocabulary (gloss-make.ts, no outside list) packed into gloss.bin; (2) cards in
# form 3 and form 4 (cardsRequestsWide) for dev20 and reworded, seeds 41-44, every variant; (3) the $0 funnel screens
# on them. The Pi pairs (run.sh) follow by hand, after the screens are read against the pre-registered rules.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
unset OPENROUTER_API_KEY
D=.local/f1/credit; mkdir -p $D
L=$D/ledger.jsonl
CAP=${CAP:-30}
# 1. The vocabulary.
if [ ! -e $D/vocab.packed ]; then
  bun packages/sim/src/lab/gloss-make.ts --out $D/vocab --spend-ledger $L --spend-cap $CAP --run-label f1-vocab || exit 1
  bun packages/sim/src/lab/gloss-pack.ts --gloss $D/vocab --out packages/engine/src/gloss.bin && touch $D/vocab.packed
fi
# 2. Cards in form 3 (the default) and form 4, one user a world.
users() { for x in "$@"; do for s in 41 42 43 44; do for v in hidden control neutral; do printf "%s:%s:%s," $x $s $v; done; done; done; }
DEV=$(users dev20a dev20b dev20c dev20d)
RW=$(users train1r train2r train3r train4r train5r train6r)
for form in 3 4; do
  set_=$([ $form = 4 ] && echo '{"cardsRequestsWide":true}' || echo '{}')
  for name in dev20 reworded; do
    u=$([ $name = dev20 ] && echo "$DEV" || echo "$RW")
    out=$D/$name-f$form.jsonl
    [ $name = reworded ] && [ $form = 3 ] && continue # in cards-shipped.jsonl.gz already
    [ -e $out ] || bun packages/sim/src/lab/cold-start.ts --users "${u%,}" --set "$set_" --cards-out $out.part \
      --spend-ledger $L --spend-cap $CAP --run-label f1-cards-$name-f$form >$D/$name-f$form.log 2>&1 && mv $out.part $out
  done
done
# 3. The screens: one replay file holding every form's lines (each run reads its own form).
gunzip -c packages/sim/lab/distilled/cards-shipped.jsonl.gz >$D/all.jsonl
cat $D/dev20-f3.jsonl $D/dev20-f4.jsonl $D/reworded-f4.jsonl >>$D/all.jsonl
for suite in dev20 reworded; do
  for arm in base gloss wide both; do
    case $arm in
      base) set_='{}' ;; gloss) set_='{"requestGloss":true}' ;; wide) set_='{"cardsRequestsWide":true}' ;;
      both) set_='{"requestGloss":true,"cardsRequestsWide":true}' ;;
    esac
    [ -e $D/f-$suite-$arm.json ] || bun run funnel --suite $suite --seeds 41,42,43,44 --coverage full --set "$set_" \
      --cards $D/all.jsonl --json $D/f-$suite-$arm.json -- --intent $D/all.jsonl --pool-dump $D/pool-$suite-$arm.jsonl \
      --neutral --ask >$D/f-$suite-$arm.log 2>&1
    grep -E "^  TOTAL +hidden [0-9]" $D/f-$suite-$arm.log | sed "s/^/$suite $arm /"
  done
done
