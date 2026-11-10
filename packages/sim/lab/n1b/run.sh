#!/bin/bash
# N1b (docs/research/n1b-yield-bench.md): the paid runs, as registered. Needs the Modal client in .local/venv-modal
# (packages/sim/modal/README.md), MODAL_TOKEN_ID/SECRET and the Modal Secret HAIKU_API_KEY. Run from the repository
# root: `run.sh STEP` with STEP one of smoke, short41, short45, short49 CAP [SEEDS], long [SEEDS CAP].
set -euo pipefail
export SSL_CERT_FILE=${SSL_CERT_FILE:-/root/.ccr/ca-bundle.crt} EDEN_COMMIT=${EDEN_COMMIT:-HEAD}
go() { # RUN SEEDS CAP "ARGS"
  .local/venv-modal/bin/python -m modal run packages/sim/modal/lab_fanout.py --preset bench-yield --seeds "$2" \
    --cap "$3" --run "$1" --args "$4"
}
case ${1:-} in
  smoke) go n1b-smoke 41 0.05 "--limit 2" ;;
  short41) go n1b-short-41 41-44 1.12 "--limit 16" ;;                       # hidden and control, cards replayed
  short45) go n1b-short-45 45-48 0.72 "--limit 16 --variants hidden" ;;     # prices a seed with cards made in-run
  short49) go n1b-short-49 "${3:-49-68}" "$2" "--limit 16 --variants hidden" ;;
  long) go "n1b-long${2:+-$2}" "${2:-41-46}" "${3:-1.02}" "--days 8" ;;
  *) echo "usage: run.sh smoke|short41|short45|short49 CAP [SEEDS]|long [SEEDS CAP]" >&2; exit 2 ;;
esac
