#!/usr/bin/env bash
# =============================================================================
# scripts/deploy-northflank.sh
#
# Apply or update the Northflank staging cluster from northflank.yml.
#
# Why this exists:
#   The cluster is configured declaratively via `northflank combine`, which
#   reconciles the live state of services/jobs/addons with the manifest.
#   Re-running it is idempotent and safe — it's what we use to push a new
#   image tag, env var change, or resource bump. There's no GitHub-side auto
#   deploy for Northflank the way Vercel has, so this script IS the canonical
#   deploy path.
#
# Prerequisites (one-time, per machine):
#   1. Install the CLI: `npm i -g @northflank/cli`  (or download from
#      https://northflank.com/docs/cli -- the script auto-discovers
#      `~/.local/bin/northflank` so a manual install works too).
#   2. `northflank login` — token ends up in ~/.northflank/config.json.
#
# Usage:
#   scripts/deploy-northflank.sh                      # apply manifest, follow logs
#   scripts/deploy-northflank.sh --no-logs            # apply manifest, exit immediately
#   scripts/deploy-northflank.sh --project eden-prod  # target a different project
#   NF_API_TOKEN=... scripts/deploy-northflank.sh     # non-interactive (CI)
#
# Exit codes:
#   0   manifest applied successfully
#   1   `northflank combine` failed (e.g. quota exhausted, build error)
#   64  bad usage
#   127 CLI not installed
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$REPO_ROOT/northflank.yml"
PROJECT="eden-staging-us-central"
FOLLOW_LOGS=true

for arg in "$@"; do
  case "$arg" in
    --project) shift; PROJECT="${1:-}"; [[ -z "$PROJECT" ]] && { echo "✗ --project needs a value" >&2; exit 64; } ;;
    --project=*) PROJECT="${arg#--project=}" ;;
    --no-logs) FOLLOW_LOGS=false ;;
    --help|-h)
      grep -E '^#( |!|$)' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "✗ unknown flag: $arg" >&2; exit 64 ;;
  esac
done

# CLI discovery — same approach as deploy-vercel.sh.
if ! command -v northflank >/dev/null 2>&1; then
  if [[ -x "$HOME/.local/bin/northflank" ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  elif [[ -x "$HOME/Library/pnpm/northflank" ]]; then
    export PATH="$HOME/Library/pnpm:$PATH"
  fi
fi

if ! command -v northflank >/dev/null 2>&1; then
  echo "✗ northflank CLI not found. Install with: npm i -g @northflank/cli" >&2
  exit 127
fi

[[ -f "$MANIFEST" ]] || { echo "✗ manifest not found: $MANIFEST" >&2; exit 64; }

if [[ -n "${NF_API_TOKEN:-}" ]]; then
  export NORTHFLANK_API_TOKEN="$NF_API_TOKEN"
fi

cd "$REPO_ROOT"

SHA="$(git rev-parse HEAD)"
echo "▶ Northflank deploy for project $PROJECT (sha=$SHA)"
echo "  Git CI/CD is enabled on eden-api — pushes to main trigger builds automatically."

# Keep EDEN_GIT_SHA honest on /live. Use the dedicated runtime-environment
# and build-arguments routes — NEVER `patch service combined` with a
# partial runtimeEnvironment (that SETS the whole map and wipes secrets
# / plain vars that were omitted).
if command -v northflank >/dev/null 2>&1; then
  echo "▶ syncing EDEN_GIT_SHA via runtime-environment merge helper"
  northflank get service --project "$PROJECT" --service eden-api -o json \
    > /tmp/nf-live-for-env.json || true
  if [[ -s /tmp/nf-live-for-env.json ]]; then
    python3 "$REPO_ROOT/scripts/build_nf_env_payload.py" \
      /tmp/nf-live-for-env.json /tmp/nf-env-payload.json || true
    if [[ -s /tmp/nf-env-payload.json ]]; then
      python3 - <<PY
import json
p = json.load(open("/tmp/nf-env-payload.json"))
p.setdefault("runtimeEnvironment", {})["EDEN_GIT_SHA"] = "$SHA"
json.dump(p, open("/tmp/nf-env-payload.json", "w"), indent=1, sort_keys=True)
print("EDEN_GIT_SHA set in payload")
PY
      northflank update service runtime-environment \
        --project "$PROJECT" --service eden-api -f /tmp/nf-env-payload.json || true
    fi
  fi
  northflank update service build-arguments \
    --project "$PROJECT" --service eden-api \
    -i "{\"buildArguments\":{\"EDEN_GIT_SHA\":\"$SHA\"}}" || true
fi

if ! northflank combine --project "$PROJECT" --path "$MANIFEST" 2>/dev/null; then
  echo "▶ northflank combine unavailable in CLI $(northflank --version 2>/dev/null | tail -1)"
  echo "  Checking service status (git-triggered build should deploy main)..."
  northflank list services --project "$PROJECT" 2>/dev/null || true
  exit 0
fi

if $FOLLOW_LOGS; then
  echo "▶ following logs (Ctrl-C to detach; service keeps running)"
  # -n 200 lines is enough for one boot cycle; --follow would be ideal
  # but `northflank logs --follow` has historically been flaky for short
  # sessions — bounded output + a sleep is more reliable.
  northflank logs --project "$PROJECT" --service eden-api -n 200 || true
fi
