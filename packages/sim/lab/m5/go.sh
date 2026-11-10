#!/usr/bin/env bash
# M5 (docs/research/m5-nudge-narrow.md): lab_fanout pi-ab on train, Haiku 5.5 in every role, arms eden (the shipped
# default, the current askNudge) and eden~deep (askNudgeDeep on, D460), paired in one process a shard. M4's recipe
# (M1's cards, profile and flags) with the trial's arm. Run two seeds at a time (D440).
# usage: packages/sim/lab/m5/go.sh RUN SEEDS CAP EXTRA...   e.g. go.sh m5-short-a 41,42 0.6 --variants hidden,control
set -euo pipefail
RUN=$1 SEEDS=$2 CAP=$3
shift 3
export SSL_CERT_FILE=${SSL_CERT_FILE:-/root/.ccr/ca-bundle.crt}
CARDS=packages/sim/lab/cards/cards-v2.jsonl,packages/sim/lab/cards/cards-train.jsonl,packages/sim/lab/cards/cards-train-4344.jsonl
EDEN_COMMIT=${EDEN_COMMIT:-HEAD} .venv-modal/bin/modal run packages/sim/modal/lab_fanout.py --kind pi-ab \
  --suites train --seeds "$SEEDS" --cap "$CAP" --run "$RUN" --args "--conditions eden,eden~deep \
  --variant-config '{\"deep\":{\"askNudgeDeep\":true}}' --model claude-haiku-5-5 --grader claude-haiku-5-5 \
  --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --cards $CARDS --tenant-prompt --push payload \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json $*"
