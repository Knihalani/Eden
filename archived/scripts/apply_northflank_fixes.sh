#!/usr/bin/env bash
# Apply the two live-project fixes found in the 2026-07-29 backend audit.
#
# These mutate running production infrastructure, which is why they are a
# script you run rather than something the audit applied on its own.
#
#   1. Add the missing health checks to eden-api.
#      The live service has `healthChecks: null`. northflank.yml has
#      declared an HTTP check on /ready the whole time, but nothing ever
#      applied that file. With no check configured, Northflank can neither
#      depool nor restart a wedged container — which is how a 7.4-day
#      silent outage of every background loop stayed silent.
#
#      Readiness probes /ready (Postgres-gated only, by design, so a Redis
#      blip cannot depool the pod). Verified 200 in 115-224ms across
#      repeated probes even with Upstash over its limit.
#      initialDelaySeconds=60 clears the in-lifespan Alembic run.
#
#      Liveness probes /live (static handler, no dependencies) at
#      initialDelaySeconds=300 with failureThreshold=5 x 60s. That is a
#      deliberately wide margin: liveness failure RESTARTS the container,
#      and restarting mid-migration would loop. It only fires on a truly
#      wedged process, which is exactly the case that went undetected.
#
#   2. Right-size eden-api from nf-compute-100-1 to nf-compute-50.
#      $18/mo -> $12/mo, saving $6/mo (33%).
#
#      Measured against the shipped image run to a completed lifespan
#      (all 111 routers + 21 deferred numpy routers mounted, /live
#      answering): steady-state RSS 270.6 MiB, CPU 0.2-0.4% idle,
#      21.6% of one vCPU at boot.
#
#      RAM stays at 1024 MB deliberately. It is the dimension with tail
#      risk — the background fleet runs in this process now and
#      SANDBOX_MEMORY_MB hands 256 MB to sandboxed execution on its own.
#      Only CPU drops (1.0 -> 0.5), against a measured 0.216 vCPU boot
#      peak: 2.3x headroom on the worst observed moment.
#
# Both are reversible. Rollback is at the bottom of this file.
#
# Usage:  ./scripts/apply_northflank_fixes.sh [--dry-run]

set -euo pipefail

PROJECT="eden-staging-us-central"
SERVICE="eden-api"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HC_FILE="$HERE/deploy/northflank-healthchecks.json"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if ! command -v northflank >/dev/null 2>&1; then
  echo "error: the northflank CLI is not on PATH" >&2
  exit 2
fi

if [ ! -f "$HC_FILE" ]; then
  echo "error: $HC_FILE is missing" >&2
  exit 2
fi

say "Current live state"
northflank get service --project "$PROJECT" --service "$SERVICE" -o json \
  | python3 -c '
import json,sys
s=json.load(sys.stdin); s=s.get("service",s)
print("  plan        :", (s.get("billing") or {}).get("deploymentPlan"))
print("  instances   :", (s.get("deployment") or {}).get("instances"))
print("  healthChecks:", s.get("healthChecks") or "null  <-- none configured")
'

if [ "$DRY_RUN" = "1" ]; then
  say "Dry run - would apply:"
  echo "  1. health checks from $HC_FILE"
  echo "  2. deploymentPlan nf-compute-50 (instances unchanged at 1)"
  exit 0
fi

# 1 ─ health checks ---------------------------------------------------
say "1/2  Adding readiness (/ready) + liveness (/live) probes"
northflank update service health-checks \
  --project "$PROJECT" --service "$SERVICE" -f "$HC_FILE"

# 2 ─ right-size ------------------------------------------------------
# Sent via the scale route, which is the one that carries deploymentPlan.
# `instances` is repeated at its current value so the call is explicit
# rather than relying on an omitted field defaulting sensibly.
say "2/2  Right-sizing nf-compute-100-1 -> nf-compute-50"
northflank scale service \
  --project "$PROJECT" --service "$SERVICE" \
  -i '{"instances":1,"deploymentPlan":"nf-compute-50"}'

# 3 ─ runtime environment ---------------------------------------------
# 51 of the 62 plain-value variables northflank.yml declares were never
# set on the service, so production ran the code default instead. Most
# are harmless (30 have a code default equal to the manifest value —
# every Redis command-conservation knob is in that group, which is why
# the drift never showed up in Redis behaviour). Ten are not:
#
#   EDEN_PRODUCTION           1        -> was false. Gates
#                                        strict_startup_checks, so
#                                        startup failures were warnings.
#   USE_MINIMAX               false    -> was true, with no MiniMax
#                                        credential in any secret group.
#   TYPESENSE_ENABLED         false    -> was true, with no Typesense
#                                        host or key in any secret group.
#   CLICKHOUSE_URL            tinybird -> was http://localhost:8123
#   TINYBIRD_API_HOST         tinybird -> was empty
#   SENTRY_ENVIRONMENT        production -> was development
#   SENTRY_TRACES_SAMPLE_RATE 0.1      -> was 0.0 (no perf traces)
#   CLERK_JWKS_URL            set      -> was empty
#   GITHUB_APP_SLUG           set      -> was empty
#   MINIMAX_MODEL             M3       -> was the stale M2.7 default
#
# This route SETS rather than merges, so the payload must contain every
# variable. build_nf_env_payload.py unions the live set with the
# manifest's plain values and refuses to run if it reads the live set as
# empty. Secret-backed variables are excluded — the 31 secret groups
# already wired to the service deliver those.
say "3/3  Setting the runtime environment (62 vars: 11 live + 51 from manifest)"
northflank get service --project "$PROJECT" --service "$SERVICE" -o json \
  > /tmp/nf-live-for-env.json
python3 "$HERE/scripts/build_nf_env_payload.py" \
  /tmp/nf-live-for-env.json /tmp/nf-env-payload.json
northflank update service runtime-environment \
  --project "$PROJECT" --service "$SERVICE" -f /tmp/nf-env-payload.json

# 4 ─ verify ----------------------------------------------------------
say "Verifying"
sleep 5
northflank get service --project "$PROJECT" --service "$SERVICE" -o json \
  | python3 -c '
import json,sys
s=json.load(sys.stdin); s=s.get("service",s)
plan=(s.get("billing") or {}).get("deploymentPlan")
hc=s.get("healthChecks")
env=s.get("runtimeEnvironment") or {}
grace=(s.get("deployment") or {}).get("gracePeriodSeconds")
print("  plan        :", plan, "OK" if plan=="nf-compute-50" else "<-- UNEXPECTED")
print("  gracePeriod :", grace, "OK" if grace==60 else "<-- UNEXPECTED")
print("  healthChecks:", len(hc or []), "configured" if hc else "still null  <-- FAILED")
print("  env vars    :", len(env), "OK" if len(env)>=62 else "<-- fewer than expected")
ok = plan=="nf-compute-50" and bool(hc) and len(env)>=62
print("\n  result:", "all applied" if ok else "something did not take - check above")
sys.exit(0 if ok else 1)
'

say "Watch the pod come back before walking away"
echo "  curl -s https://api.edenobservability.com/ready | head -c 300"
echo "  northflank get service --project $PROJECT --service $SERVICE"
echo
echo "Rollback:"
echo "  northflank scale service --project $PROJECT --service $SERVICE \\"
echo "    -i '{\"instances\":1,\"deploymentPlan\":\"nf-compute-100-1\"}'"
echo "  northflank update service health-checks --project $PROJECT \\"
echo "    --service $SERVICE -i '{\"healthChecks\":[]}'"
