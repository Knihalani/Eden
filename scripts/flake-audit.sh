#!/usr/bin/env bash
# Flake audit: shuffle test order, optionally skew the readable clocks, and
# optionally burn CPU while the suite runs. Exit non-zero on the first failed
# run; print the run number and seed that failed.
#
# Usage:
#   ./scripts/flake-audit.sh [--runs N] [--clock-jump] [--load] [--seed S]
#
# Defaults: N=20. Discovery matches scripts/test.sh (packages/apps/benchmarks
# *.test.ts / *.test.tsx). Never sleeps to "wait for a flake to pass".
set -euo pipefail
cd "$(dirname "$0")/.."

RUNS=20
CLOCK_JUMP=0
LOAD=0
SEED=""

while [ $# -gt 0 ]; do
  case "$1" in
    --runs)
      RUNS="${2:?}"
      shift 2
      ;;
    --clock-jump)
      CLOCK_JUMP=1
      shift
      ;;
    --load)
      LOAD=1
      shift
      ;;
    --seed)
      SEED="${2:?}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || [ "$RUNS" -lt 1 ]; then
  echo "--runs must be a positive integer" >&2
  exit 2
fi

# Discover test files the same way scripts/test.sh discovers dirs, then keep
# the file list so we can shuffle order across runs.
files=$(
  find packages apps benchmarks \( -name '*.test.ts' -o -name '*.test.tsx' \) -print \
    | grep -v '/node_modules/' \
    | sort
)

if [ -z "$files" ]; then
  echo "no test files found — check the discovery glob in scripts/flake-audit.sh" >&2
  exit 1
fi

file_count=$(printf '%s\n' "$files" | grep -c . || true)
echo "flake-audit: $file_count test files, runs=$RUNS clock-jump=$CLOCK_JUMP load=$LOAD"

# Fisher–Yates via awk (bash 3.2 has no arrays / mapfile).
shuffle_files() {
  local seed="$1"
  printf '%s\n' "$files" | awk -v seed="$seed" '
    BEGIN { srand(seed) }
    { a[NR] = $0 }
    END {
      n = NR
      for (i = n; i > 1; i--) {
        j = int(rand() * i) + 1
        t = a[i]; a[i] = a[j]; a[j] = t
      }
      for (i = 1; i <= n; i++) print a[i]
    }
  '
}

LOAD_PID=""
cleanup() {
  if [ -n "$LOAD_PID" ] && kill -0 "$LOAD_PID" 2>/dev/null; then
    kill "$LOAD_PID" 2>/dev/null || true
    wait "$LOAD_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

start_load() {
  # Busy-loop burner. Bun keeps a tight JS loop on one core; killed on exit.
  bun -e 'for (;;) { let x = 0; for (let i = 0; i < 1e7; i++) x += i; if (x < 0) console.log(x) }' \
    >/dev/null 2>&1 &
  LOAD_PID=$!
}

# ±30% clock *rate* (ROADMAP Wave 1.2). Offset still jumps the origin so
# absolute "now" pins also move; sign flips with the run seed.
clock_offset_for() {
  local seed="$1"
  local mag=18000
  if [ $(( seed % 2 )) -eq 0 ]; then
    echo "$mag"
  else
    echo "-$mag"
  fi
}

base_seed="${SEED:-}"
if [ -z "$base_seed" ]; then
  base_seed=$(date +%s)
fi

# Bun auto-loads the repo .env (which may carry a real DATABASE_URL). Site
# suites that save/restore process.env mid-run reintroduce that managed marker
# under --randomize, so later tests hit Neon or 401 instead of their EDEN_DB
# fixture. Pin empty markers for the whole audit process; tests that need a
# managed posture set DATABASE_URL themselves.
export DATABASE_URL="${DATABASE_URL-}"
export VERCEL="${VERCEL-}"
# Force empty even if the parent shell inherited values / .env injection.
DATABASE_URL=
VERCEL=
export DATABASE_URL VERCEL

run=1
while [ "$run" -le "$RUNS" ]; do
  seed=$(( base_seed + run - 1 ))
  echo ""
  echo "=== flake-audit run $run/$RUNS seed=$seed ==="

  # Re-assert each run: a test may have restored a saved DATABASE_URL.
  DATABASE_URL=
  VERCEL=
  export DATABASE_URL VERCEL

  shuffled=$(shuffle_files "$seed")
  # shellcheck disable=SC2086
  set -- $shuffled

  preload_args=()
  export EDEN_FLAKE_CLOCK_OFFSET_MS=0
  export EDEN_FLAKE_CLOCK_SCALE=1
  if [ "$CLOCK_JUMP" -eq 1 ]; then
    off=$(clock_offset_for "$seed")
    export EDEN_FLAKE_CLOCK_OFFSET_MS="$off"
    # ±30% elapsed-clock rate (ROADMAP Wave 1.2 "clock jump ±30%").
    # Alternates with the offset sign so both fast and slow clocks appear.
    if [ "$off" -gt 0 ]; then
      export EDEN_FLAKE_CLOCK_SCALE=1.3
    else
      export EDEN_FLAKE_CLOCK_SCALE=0.7
    fi
    preload_args=(--preload="$PWD/scripts/flake-clock.ts")
    echo "clock-jump: offset_ms=$EDEN_FLAKE_CLOCK_OFFSET_MS scale=$EDEN_FLAKE_CLOCK_SCALE"
  fi

  if [ "$LOAD" -eq 1 ]; then
    start_load
    echo "cpu load: pid=$LOAD_PID"
  fi

  # Python SDK tests once per run when present (same as scripts/test.sh).
  if command -v python3 >/dev/null 2>&1 && [ -d packages/sdk-py/tests ]; then
    if ! python3 -m unittest discover -s packages/sdk-py/tests; then
      echo "FAIL flake-audit run=$run seed=$seed (python)" >&2
      exit 1
    fi
  fi

  # Belt-and-suspenders: bun --randomize shuffles test *order inside files*;
  # our file-list shuffle reorders which files run first.
  # Pass directories (unique) like scripts/test.sh PLUS explicit shuffled files so
  # bun still discovers everything even if ARG_MAX truncates — prefer files.
  # shellcheck disable=SC2086
  # Re-clear inside the bun child via env prefix (bun may re-read .env).
  if ! DATABASE_URL= VERCEL= bun test --randomize --seed="$seed" "${preload_args[@]}" "$@"; then
    echo "FAIL flake-audit run=$run seed=$seed offset_ms=${EDEN_FLAKE_CLOCK_OFFSET_MS:-0} scale=${EDEN_FLAKE_CLOCK_SCALE:-1}" >&2
    exit 1
  fi

  if [ -n "$LOAD_PID" ]; then
    kill "$LOAD_PID" 2>/dev/null || true
    wait "$LOAD_PID" 2>/dev/null || true
    LOAD_PID=""
  fi

  echo "PASS flake-audit run=$run seed=$seed"
  run=$(( run + 1 ))
done

echo ""
echo "flake-audit: $RUNS/$RUNS green (base_seed=$base_seed)"
