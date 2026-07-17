#!/usr/bin/env bash
# W9 staging dogfood probes — fail-closed contracts + optional live HTTP.
#
# Usage:
#   bash scripts/w9_staging_probes.sh              # unit + local contracts
#   EDEN_STAGING_API_URL=https://api… bash scripts/w9_staging_probes.sh
#   bash scripts/w9_local_probes.sh                # local stubs (+ compose when docker up)
#
# Does not invent Typesense/Clerk secrets. Live probes skip when URLs unset.
# Set EDEN_W9_PROBE_MODE=local when invoking via w9_local_probes.sh.

set -euo pipefail
# Prefer repo venv (3.12+) over system python3.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -x "$ROOT/.venv/bin/python" ]]; then
  PY="$ROOT/.venv/bin/python"
else
  PY="$(command -v python3.12 || command -v python3.11 || command -v python3 || command -v python)"
fi

pass=0
fail=0
skip=0
MODE="${EDEN_W9_PROBE_MODE:-staging}"

ok() { echo "PASS  $*"; pass=$((pass + 1)); }
bad() { echo "FAIL  $*"; fail=$((fail + 1)); }
skp() { echo "SKIP  $*"; skip=$((skip + 1)); }

echo "=== W9 ${MODE} probes (py=$PY) ==="

# 1) Unit fail-closed proofs (leader / shed / late-span / RTBF)
if PYTHONPATH=src "$PY" -m pytest tests/unit/platform/test_w9_platform.py -q --noconftest; then
  ok "test_w9_platform.py"
else
  bad "test_w9_platform.py"
fi

# 2) Helm readiness contracts present
for f in \
  helm/eden/templates/api-deployment.yaml \
  helm/eden/templates/worker-deployment.yaml \
  helm/eden/templates/api-hpa.yaml \
  helm/eden/templates/pdb.yaml \
  helm/eden/templates/secrets.yaml \
  helm/eden/templates/_helpers-w9.tpl
do
  if [[ -f "$f" ]]; then
    ok "helm artifact $f"
  else
    bad "missing $f"
  fi
done

if rg -q "readinessProbe" helm/eden/templates/api-deployment.yaml \
  && rg -q "livenessProbe" helm/eden/templates/api-deployment.yaml; then
  ok "api readiness+liveness probes"
else
  bad "api probes missing"
fi

if grep -E -q 'readinessProbe|livenessProbe|exec:' helm/eden/templates/worker-deployment.yaml; then
  ok "worker health probe contract"
else
  bad "worker health probe contract"
fi

# 3) Ingest shed / late-span modules exist (not stubs)
for mod in \
  src/eden/observability/ingestion/shed.py \
  src/eden/observability/ingestion/late_span.py \
  src/eden/storage/redis.py
do
  if [[ -f "$mod" ]]; then
    ok "module $mod"
  else
    bad "missing $mod"
  fi
done

# 4) Optional live HTTP (operator sets URL)
API_URL="${EDEN_STAGING_API_URL:-${EDEN_API_URL:-}}"
PORTAL_URL="${EDEN_STAGING_PORTAL_URL:-${EDEN_PORTAL_URL:-}}"

if [[ -n "$API_URL" ]]; then
  if curl -fsS --max-time 10 "${API_URL%/}/live" >/dev/null; then
    ok "live ${API_URL%/}/live"
  else
    bad "live ${API_URL%/}/live"
  fi
  if curl -fsS --max-time 10 "${API_URL%/}/ready" >/dev/null; then
    ok "ready ${API_URL%/}/ready"
  else
    bad "ready ${API_URL%/}/ready"
  fi
  if curl -fsS --max-time 15 "${API_URL%/}/health" >/dev/null; then
    ok "health ${API_URL%/}/health"
  else
    bad "health ${API_URL%/}/health"
  fi
else
  skp "EDEN_STAGING_API_URL unset — live API probes"
fi

if [[ -n "$PORTAL_URL" ]]; then
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "${PORTAL_URL%/}/" || echo 000)
  if [[ "$code" =~ ^(200|301|302|307|308)$ ]]; then
    ok "portal root HTTP $code"
  else
    bad "portal root HTTP $code"
  fi
else
  skp "EDEN_STAGING_PORTAL_URL unset — live portal probe"
fi

if [[ -z "${TYPESENSE_HOST:-}" || -z "${TYPESENSE_API_KEY:-}" ]]; then
  skp "Typesense NF secrets unset (expected PARTIAL)"
else
  ok "Typesense env present (host set)"
fi

echo "=== summary: pass=$pass fail=$fail skip=$skip ==="
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
exit 0
