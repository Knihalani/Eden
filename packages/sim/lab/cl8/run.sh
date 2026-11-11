#!/bin/bash
# CL8 on Pi (docs/research/cl-cl8.md): LABEL PUSH CONDITIONS then pi-ab flags. CL7's run.sh with CL8's arms:
# dd = pushCandidateDedup; k3 = pushCandidates 3 + dedup; b200 = pushCandidateBytes 200 + dedup (D258 trial, the
# switches are in commit f58aae41 only); late = pushCandidatesLater 3 (D259 trial).
L=$1; PUSH=$2; CONDS=$3; shift 3
VC='{"dd":{"pushCandidateDedup":true},"k3":{"pushCandidates":3,"pushCandidateDedup":true},"b200":{"pushCandidateBytes":200,"pushCandidateDedup":true},"late":{"pushCandidatesLater":3}}'
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite train --conditions $CONDS --config default \
  --variant-config "$VC" \
  --cards .local/cl8/cards-all.jsonl --cards-out .local/cl8/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/cl8/ledger.jsonl --spend-cap 2.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/cl8/runs/$L.tl --out .local/cl8/runs/$L.json "$@"
