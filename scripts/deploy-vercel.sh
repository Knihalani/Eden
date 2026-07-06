#!/usr/bin/env bash
# =============================================================================
# scripts/deploy-vercel.sh
#
# Trigger a Vercel production deploy from the CLI.
#
# Why this exists:
#   The Vercel GitHub App integration is the *normal* deploy path — pushes to
#   `main` via GitHub trigger a build automatically. That path has been broken
#   (see `.deploy-sha` being weeks behind HEAD) so this script is the manual
#   recovery path that can also be wired into CI.
#
# Prerequisites (one-time, per machine):
#   1. `npm i -g vercel` (or use the pnpm-installed copy at
#      $PNPM_HOME/vercel — the script does this automatically).
#   2. `vercel login` — paste the token into `$VERCEL_TOKEN` or run interactively.
#   3. Link the project (one-time per machine):
#        cd clients/portal && vercel link --yes
#      This writes `.vercel/{project,repo}.json` — both are already
#      committed to this repo, so step 3 is usually skipped.
#
# Usage:
#   scripts/deploy-vercel.sh              # production deploy, --yes
#   scripts/deploy-vercel.sh --preview   # preview deploy
#   scripts/deploy-vercel.sh --no-build  # deploy pre-built output
#   VERCEL_TOKEN=... scripts/deploy-vercel.sh   # non-interactive (CI)
#
# After a successful deploy, the script updates `.deploy-sha` to the new HEAD
# so subsequent "what's deployed?" checks (`scripts/deploy-status.sh`) reflect
# reality.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORTAL_DIR="$REPO_ROOT/clients/portal"
DEPLOY_SHA_FILE="$REPO_ROOT/.deploy-sha"

cd "$REPO_ROOT"

# Pick up the Vercel CLI. pnpm installs globals to ~/Library/pnpm/ on macOS;
# fall back to PATH lookup. A bare `vercel` on PATH also works.
if ! command -v vercel >/dev/null 2>&1; then
  if [[ -x "$HOME/Library/pnpm/vercel" ]]; then
    export PATH="$HOME/Library/pnpm:$PATH"
  elif [[ -x "$HOME/.local/bin/vercel" ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi

if ! command -v vercel >/dev/null 2>&1; then
  echo "✗ vercel CLI not found. Install with: npm i -g vercel" >&2
  exit 127
fi

PREVIEW=false
NO_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --preview) PREVIEW=true ;;
    --no-build) NO_BUILD=true ;;
    --help|-h)
      grep -E '^#( |!|$)' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "✗ unknown flag: $arg" >&2; exit 64 ;;
  esac
done

if [[ -z "${VERCEL_TOKEN:-}" && ! -t 0 ]]; then
  echo "✗ no TTY and VERCEL_TOKEN unset — set VERCEL_TOKEN for non-interactive use." >&2
  exit 64
fi

extra_flags=(--yes)
if [[ -n "${VERCEL_TOKEN:-}" ]]; then
  extra_flags+=(--token "$VERCEL_TOKEN")
fi
if $PREVIEW; then
  extra_flags+=(--target preview)
else
  extra_flags+=(--prod)
fi

# Always run from clients/portal so rootDirectory="clients/portal" in
# vercel.json resolves correctly.
cd "$PORTAL_DIR"

echo "▶ vercel deploy from $(pwd)"
if $NO_BUILD; then
  echo "  (--no-build: skipping build, deploying .next as-is)"
  # `vercel deploy --prebuilt` expects `.vercel/output` ready; we leave that
  # to the caller (see scripts/deploy-vercel.sh --help for the flow).
  vercel deploy --prebuilt "${extra_flags[@]}"
else
  vercel deploy "${extra_flags[@]}"
fi

# Stamp the deploy SHA so deploy-status.sh can report up-to-date-ness.
if [[ -n "${VERCEL_TOKEN:-}" || -t 0 ]]; then
  new_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  printf '%s\n' "$new_sha" > "$DEPLOY_SHA_FILE"
  echo "✓ updated .deploy-sha to $new_sha"
fi
