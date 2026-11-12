#!/usr/bin/env bash
# F1's pre-registered Pi pair (docs/research/f1-intent-bridge.md §4): reworded's non-English templates, seeds 41-48,
# hidden, control and neutral; the default (both+ask) against requestGloss (both~gloss+ask), one process a seed.
# Lab-provider (D97): every call to Anthropic through the spend ledger. Run from the repo root.
set -uo pipefail
unset OPENROUTER_API_KEY
D=.local/f1/pi; mkdir -p $D
TEMPLATES=$(python3 -I - <<'PY'
import re
src = open('packages/sim/src/lab/reworded.ts').read()
print(','.join(m.group(1) for m in re.finditer(r'"([a-z0-9-]+)": \{\s*re:[^\n]*\n\s*to:[^\n]*\n\s*lang: "\w+"', src)))
PY
)
[ -e $D/cov.jsonl ] || gunzip -c packages/sim/lab/distilled/cards-shipped.jsonl.gz >$D/cov.jsonl
COMMON=(--config default --model claude-haiku-5-5 --grader claude-sonnet-5-5 --card-model claude-haiku-5-5
  --reader-model claude-haiku-5-5 --time-scale 1 --spend-ledger $D/ledger.jsonl --spend-cap ${CAP:-20}
  --spend-headroom 0.3 --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload
  --coverage full --cards $D/cov.jsonl --intent $D/cov.jsonl --tenant-prompt --suite reworded --templates "$TEMPLATES"
  --variants hidden,control,neutral --conditions both+ask,both~gloss+ask --variant-config '{"gloss":{"requestGloss":true}}')
P=()
for s in 41 42 43 44 45 46 47 48; do
  [ -e $D/s$s.json ] || bun packages/sim/src/lab/pi-ab.ts "${COMMON[@]}" --seeds $s --budget 3 --run-label f1-gloss-$s \
    --cards-out $D/s$s.cards.jsonl --timeline $D/s$s.tl --out $D/s$s.json >$D/s$s.log 2>&1 &
  P+=($!)
  # Four seeds at a time: one pi-ab process can hold over 3 GB (packages/sim/src/lab/CLAUDE.md).
  if [ ${#P[@]} -ge 4 ]; then for p in "${P[@]}"; do wait $p; done; P=(); fi
done
for p in "${P[@]}"; do wait $p; done
echo "done $(date -u +%T)"
