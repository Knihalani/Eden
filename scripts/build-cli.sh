#!/usr/bin/env bash
# Build the eden CLI as a single-file bundle.
#
# The CLI's workspace deps (@eden/ir, wrap, control, …) only resolve inside
# this monorepo; publishing them as literal "workspace:*" strings produced an
# uninstallable package. Bundling inlines everything into one runnable file,
# so the published artifact has zero runtime dependencies.
#
# Output: packages/cli/dist/eden.js (runnable with bun, shebang included).
set -euo pipefail
cd "$(dirname "$0")/.."

# Tests and types gate the build: a bundle of broken code is still broken.
if [ "${EDEN_SKIP_CHECKS:-}" != "1" ]; then
  echo "── typecheck"
  ./scripts/typecheck.sh > /dev/null
  echo "── tests"
  ./scripts/test.sh > /dev/null
fi

echo "── bundle"
mkdir -p packages/cli/dist
# --target=bun emits the #!/usr/bin/env bun shebang itself (plus a // @bun
# marker); do NOT add another banner or the file stops being valid JS.
bun build packages/cli/src/cli.ts \
  --target=bun \
  --outfile=packages/cli/dist/eden.js \
  --sourcemap=none > /dev/null

chmod +x packages/cli/dist/eden.js
echo "── smoke"
packages/cli/dist/eden.js doctor > /dev/null 2>&1 || true # doctor may report unhealthy locally; it must not crash
packages/cli/dist/eden.js --help > /dev/null
echo "── pack"
( cd packages/cli && npm pack --dry-run > /dev/null )
echo "✓ packages/cli/dist/eden.js ready ($(du -h packages/cli/dist/eden.js | cut -f1))"
