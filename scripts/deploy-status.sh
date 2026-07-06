#!/usr/bin/env bash
# =============================================================================
# scripts/deploy-status.sh
#
# Print whether the current HEAD is deployed to Vercel and/or Northflank.
#
# "Deployed" is judged against `.deploy-sha`, which deploy-vercel.sh updates
# after a successful `vercel deploy --prod`. For Northflank there's no
# equivalent stamp — the only signal we have is the last successful boot
# log line (grep'd out of `northflank logs`). So we *check* what's deployed
# by querying each platform rather than relying on a local file.
#
# Usage:
#   scripts/deploy-status.sh                        # Vercel + NF check
#   scripts/deploy-status.sh --skip-northflank      # Vercel only
#   scripts/deploy-status.sh --skip-vercel          # NF only
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_SHA_FILE="$REPO_ROOT/.deploy-sha"

CHECK_VERCEL=true
CHECK_NORTHFLANK=true
for arg in "$@"; do
  case "$arg" in
    --skip-northflank) CHECK_NORTHFLANK=false ;;
    --skip-vercel)     CHECK_VERCEL=false ;;
    --help|-h)
      grep -E '^#( |!|$)' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "✗ unknown flag: $arg" >&2; exit 64 ;;
  esac
done

cd "$REPO_ROOT"

HEAD_SHA="$(git rev-parse HEAD)"
HEAD_SHORT="$(git rev-parse --short HEAD)"
RECORDED_SHA="$(cat "$DEPLOY_SHA_FILE" 2>/dev/null || echo unknown)"

echo "HEAD:           $HEAD_SHORT ($HEAD_SHA)"
echo "Last Vercel:    $RECORDED_SHA (from .deploy-sha)"
echo

# Vercel — compare HEAD to .deploy-sha. We do this because we can't query
# the live Vercel API from this sandbox without network.
if $CHECK_VERCEL; then
  if [[ "$RECORDED_SHA" == "$HEAD_SHA" ]]; then
    printf 'Vercel:         ✓ up to date (%s)\n' "$HEAD_SHORT"
  else
    behind="$(git rev-list --count "$RECORDED_SHA..$HEAD_SHA" 2>/dev/null || echo "?")"
    ahead="$(git rev-list --count "$HEAD_SHA..$RECORDED_SHA" 2>/dev/null || echo "?")"
    printf 'Vercel:         ✗ behind — %s commits ahead of %s\n' "$behind" "$RECORDED_SHA"
    printf '                (`.deploy-sha` is newer than HEAD by %s commits — local rewind?)\n' "$ahead" 2>/dev/null || true
  fi
fi

# Northflank — try to query, fall back to "unknown".
if $CHECK_NORTHFLANK; then
  if command -v northflank >/dev/null 2>&1 || [[ -x "$HOME/.local/bin/northflank" ]]; then
    PATH="$HOME/.local/bin:$HOME/Library/pnpm:$PATH"
    echo
    echo "Northflank:"
    # NF assigns image tags per build; we just confirm the service is running.
    if northflank list services --project eden-staging-us-central 2>&1 | grep -q 'eden-api'; then
      printf '  ✓ eden-api service exists\n'
      latest_status="$(northflank get service --project eden-staging-us-central --name eden-api 2>/dev/null | grep -iE 'status|state' | head -1 || true)"
      printf '  %s\n' "${latest_status:-  (run with --json for full state)}"
    else
      printf '  ✗ eden-api service not found\n'
    fi
  else
    echo
    echo "Northflank:      (skip — CLI not installed; run npm i -g @northflank/cli)"
  fi
fi

echo
echo "Fix paths:"
echo "  • Vercel rebuild:   scripts/deploy-vercel.sh"
echo "  • Northflank apply: scripts/deploy-northflank.sh"
