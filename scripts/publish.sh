#!/usr/bin/env bash
# Publish eden to npm.
#
# Prereqs:
#   1. `npm login` first (whoever owns the package name).
#   2. Bun installed (the bundle targets bun; the CLI itself requires it).
#
# What this does:
#   - gates on the full test suite + typecheck (unless EDEN_SKIP_CHECKS=1)
#   - bundles to a single dependency-free dist/eden.js (see build-cli.sh)
#   - shows exactly what ships via npm pack --dry-run
#   - publishes with your confirmation
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Publishing 'eden' to npm."
echo ""

./scripts/build-cli.sh

cd packages/cli
echo ""
echo "Tarball contents:"
npm pack --dry-run 2>&1 | tail -8

echo ""
read -r -p "Publish to npm? [y/N] " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
  npm publish --access public
  echo "Published. Users can now: npx eden init"
else
  echo "Aborted. The built artifact stays in packages/cli/dist/ for inspection."
fi
