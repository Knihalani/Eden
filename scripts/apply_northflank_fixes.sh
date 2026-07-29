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

# 3 ─ verify ----------------------------------------------------------
say "Verifying"
sleep 5
northflank get service --project "$PROJECT" --service "$SERVICE" -o json \
  | python3 -c '
import json,sys
s=json.load(sys.stdin); s=s.get("service",s)
plan=(s.get("billing") or {}).get("deploymentPlan")
hc=s.get("healthChecks")
print("  plan        :", plan, "OK" if plan=="nf-compute-50" else "<-- UNEXPECTED")
print("  healthChecks:", json.dumps(hc)[:200] if hc else "still null  <-- FAILED")
ok = plan=="nf-compute-50" and bool(hc)
print("\n  result:", "both applied" if ok else "at least one did not take - check above")
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
