#!/bin/bash
# go.sh RUN SEEDS CAP CONDITIONS VARIANT_CONFIG [EXTRA...]: lab_fanout pi-ab at 1,000 sources, train, short (limit 6),
# hidden/control/neutral, payload notices, market latency, Haiku 5.5 in every role, cards and intent replayed.
cd /home/user/Eden
export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt
export PATH=$PWD/.local/venv-modal/bin:$PATH
run=$1; seeds=$2; cap=$3; conds=$4; vc=$5; shift 5
C=packages/sim/lab/cards
EDEN_COMMIT=HEAD .local/venv-modal/bin/python -m modal run packages/sim/modal/lab_fanout.py --kind pi-ab --suites train --seeds "$seeds" --cap "$cap" \
  --run "$run" --args "--conditions $conds --limit 6 --variants hidden,control,neutral --noise-sources 995 \
  --connector-mix 0.3,0.3 --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 \
  --reader-model claude-haiku-5-5 --cards $C/cards-v2.jsonl,$C/cards-train.jsonl,$C/cards-train-4344.jsonl \
  --tenant-prompt --push payload --source-profile packages/sim/lab/before-after/market-profiles/direct.json \
  --variant-config '$vc' $*"
