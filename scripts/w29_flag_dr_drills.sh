#!/usr/bin/env bash
# Wave 29 — flag + DR drills (documented + run where possible).
#
# Flag drill: contract-check /admin/flags route + Settings status surface.
# DR drill: invoke scripts/dr_drill.sh (advisory when no backup).
#
# Usage:
#   scripts/w29_flag_dr_drills.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REPORT_DIR="${REPORT_DIR:-$ROOT/reports}"
mkdir -p "$REPORT_DIR"
TS=$(date -u +"%Y%m%dT%H%M%SZ")
OUT="$REPORT_DIR/w29-drills-${TS}.json"

echo "==> Flag drill (contract)"
FLAG_OK=true
rg -q 'admin/flags' src/eden/api/routes/feature_flags.py clients/portal/src/lib/api.ts \
  || FLAG_OK=false
rg -q 'FeatureFlagsResponse|get_feature_flags' src/eden/api/routes/feature_flags.py \
  || FLAG_OK=false
# Settings status / MCP surfaces mention flags or health
if [[ -f clients/portal/src/app/\(portal\)/settings/_components/status-tab.tsx ]] \
   || [[ -f clients/portal/src/app/\(portal\)/settings/\(tabs\)/status/page.tsx ]]; then
  echo "OK: Settings status surface present"
else
  echo "WARN: Settings status surface missing"
  FLAG_OK=false
fi

if [[ "$FLAG_OK" == true ]]; then
  echo "OK: /admin/flags route + portal client present"
  FLAG_VERDICT=PASS
else
  echo "FAIL: flag surface incomplete"
  FLAG_VERDICT=FAIL
fi

echo "==> DR drill"
export DR_DRILL_ALLOW_MISSING_BACKUP="${DR_DRILL_ALLOW_MISSING_BACKUP:-1}"
export REPORT_DIR
set +e
bash scripts/dr_drill.sh
DR_CODE=$?
set -e

DR_REPORT=$(ls -1t "$REPORT_DIR"/dr-drill-*.json 2>/dev/null | head -1 || true)
if [[ -n "$DR_REPORT" ]]; then
  DR_VERDICT=$(python3 -c "import json; print(json.load(open('$DR_REPORT')).get('verdict','UNKNOWN'))" 2>/dev/null || echo UNKNOWN)
  echo "OK: DR report at $DR_REPORT (verdict=$DR_VERDICT, exit=$DR_CODE)"
else
  DR_VERDICT=MISSING
  echo "WARN: no DR report produced (exit=$DR_CODE) — advisory until BACKUP_S3_BUCKET configured"
fi

# Workflow present
if [[ -f .github/workflows/dr-drill.yml ]]; then
  echo "OK: .github/workflows/dr-drill.yml present (scheduled Mon 06:00 UTC)"
  WF_OK=true
else
  WF_OK=false
fi

WF_JSON=$([[ "$WF_OK" == true ]] && echo true || echo false)
python3 - <<PY
import json
out = {
  "ts": "$TS",
  "flag_drill": {"verdict": "$FLAG_VERDICT"},
  "dr_drill": {"verdict": "$DR_VERDICT", "exit_code": $DR_CODE, "report": "$DR_REPORT"},
  "workflow_present": json.loads("$WF_JSON"),
  "honesty": "DR is advisory in CI without BACKUP_S3_BUCKET; flag drill is contract-level unless staging URL set.",
}
open("$OUT", "w").write(json.dumps(out, indent=2) + "\n")
print("Wrote", "$OUT")
PY

if [[ "$FLAG_VERDICT" != "PASS" ]]; then
  exit 1
fi
echo "W29 flag+DR drills: documented (flag=$FLAG_VERDICT, dr=$DR_VERDICT)"
exit 0
