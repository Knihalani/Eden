#!/bin/bash
# A22: Sonnet 5.5 regrades of a pi-ab run (A12's regrade.sh on A22's ledger). STEM NAME then regrade.ts filters.
STEM=$1; NAME=$2; shift 2
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results .local/a22/runs/$STEM.json \
  --graders claude-sonnet-5-5 --spend-ledger .local/a22/ledger.jsonl --spend-cap 2.5 --spend-headroom 0.05 \
  --run-label a22-rg-$NAME --out .local/a22/runs/$NAME.json "$@"
