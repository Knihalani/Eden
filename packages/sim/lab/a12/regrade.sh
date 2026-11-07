#!/bin/bash
# A12: Sonnet 5.5 regrades of a pi-ab run (docs/research/a12-quality.md). STEM NAME then regrade.ts filters.
STEM=$1; NAME=$2; shift 2
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results .local/a12/runs/$STEM.json \
  --graders claude-sonnet-5-5 --spend-ledger .local/a12/ledger.jsonl --spend-cap 3 --spend-headroom 0.05 \
  --run-label a12-rg-$NAME --out .local/a12/runs/rg-$NAME.json "$@"
