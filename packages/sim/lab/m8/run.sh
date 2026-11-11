#!/bin/bash
# M8 (docs/research/m8-router.md): the Pi pair, O1's shape (D543) with M8's preset (`bench-router`). Needs the Modal
# client (`modal[api-proxy-support]==1.6.3`, packages/sim/modal/README.md), MODAL_TOKEN_ID/SECRET and the Modal Secret
# HAIKU_API_KEY. From the repository root: `run.sh router STEP …`, STEP one of smoke, short41 [CAP], short45 SEEDS CAP,
# long [SEEDS CAP]. Runs are named m8-router-STEP[-SEEDS]. EXTRA holds pi-ab flags for every step.
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
  python3 -m modal run packages/sim/modal/lab_fanout.py --preset "bench-$P" --seeds "$2" \
    --cap "$3" --run "$1" --max-streams $((2 * per)) --args "$4"
}
case ${1:-} in
  smoke) go "m8-$P${TAG:-}-smoke" 41 0.05 "--limit 2" ;;
  short41) go "m8-$P${TAG:-}-short-41" 41-44 "${2:-1.12}" "--limit 16" ;;          # hidden and control, cards replayed
  short45) go "m8-$P${TAG:-}-short-$2" "$2" "$3" "--limit 16 --variants hidden" ;; # cards made in-run
  long) go "m8-$P${TAG:-}-long${2:+-$2}" "${2:-41-48}" "${3:-1.60}" "--days 8" ;;
  *) echo "usage: run.sh PRESET smoke|short41 [CAP]|short45 SEEDS CAP|long [SEEDS CAP]" >&2; exit 2 ;;
esac
