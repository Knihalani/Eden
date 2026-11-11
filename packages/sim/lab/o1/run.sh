#!/bin/bash
# O1 (docs/research/o1-earn.md): the paid runs, as registered. Needs the Modal client in .local/venv-modal
# (packages/sim/modal/README.md), MODAL_TOKEN_ID/SECRET and the Modal Secret HAIKU_API_KEY. Run from the repository
# root: `run.sh PRESET STEP …` with PRESET a `fanout_plan.PRESETS` name without its `bench-` (earn) and STEP one of
# smoke, short41 [CAP], short45 SEEDS CAP, long [SEEDS CAP]. Runs are named o1-PRESET-STEP[-SEEDS]. EXTRA holds
# pi-ab flags for every step (run 2: EXTRA='--noise-vocab 1000'); TAG is added to the preset in run names (run 3: t).
set -euo pipefail
export SSL_CERT_FILE=${SSL_CERT_FILE:-/root/.ccr/ca-bundle.crt} EDEN_COMMIT=${EDEN_COMMIT:-HEAD}
P=${1:?preset}; shift
go() { # RUN SEEDS CAP "ARGS"; EXTRA (the environment) is added to every run's pi-ab arguments
  set -- "$1" "$2" "$3" "$4${EXTRA:+ $EXTRA}"
  # At most two shards at once on the one Anthropic key (O1's limit): twice a shard's agent streams.
  local per
  per=$(python3 -I packages/sim/modal/fanout_plan.py plan --preset "bench-$P" --seeds "$2" --cap "$3" -- $4 |
    python3 -I -c 'import json, sys
print(json.loads(sys.stdin.readline())["streamsPerShard"])
sys.stdin.read()')
  .local/venv-modal/bin/python -m modal run packages/sim/modal/lab_fanout.py --preset "bench-$P" --seeds "$2" \
    --cap "$3" --run "$1" --max-streams $((2 * per)) --args "$4"
}
case ${1:-} in
  smoke) go "o1-$P${TAG:-}-smoke" 41 0.05 "--limit 2" ;;
  short41) go "o1-$P${TAG:-}-short-41" 41-44 "${2:-1.12}" "--limit 16" ;;          # hidden and control, cards replayed
  short45) go "o1-$P${TAG:-}-short-$2" "$2" "$3" "--limit 16 --variants hidden" ;; # cards made in-run
  long) go "o1-$P${TAG:-}-long${2:+-$2}" "${2:-41-48}" "${3:-1.60}" "--days 8" ;;
  *) echo "usage: run.sh PRESET smoke|short41 [CAP]|short45 SEEDS CAP|long [SEEDS CAP]" >&2; exit 2 ;;
esac
