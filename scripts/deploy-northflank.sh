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
PROJECT="eden-staging"
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

echo "▶ northflank combine --project $PROJECT --path $MANIFEST"
northflank combine --project "$PROJECT" --path "$MANIFEST"

if $FOLLOW_LOGS; then
  echo "▶ following logs (Ctrl-C to detach; service keeps running)"
  # -n 200 lines is enough for one boot cycle; --follow would be ideal
  # but `northflank logs --follow` has historically been flaky for short
  # sessions — bounded output + a sleep is more reliable.
  northflank logs --project "$PROJECT" --service eden-api -n 200 || true
fi
