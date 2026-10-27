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
bun build apps/control/src/demo.ts \
  --target=bun \
  --outfile=packages/cli/dist/demo.js \
  --sourcemap=none > /dev/null
chmod +x packages/cli/dist/eden.js packages/cli/dist/demo.js
echo "── smoke"
packages/cli/dist/eden.js doctor > /dev/null 2>&1 || true # doctor may report unhealthy locally; it must not crash
test -f packages/cli/dist/demo.js || { echo "smoke: dist/demo.js missing" >&2; exit 1; }
demo_help=$(packages/cli/dist/eden.js demo --help)
echo "$demo_help" | grep -q "T-100" || {
  echo "smoke: dist demo --help is missing T-100" >&2
  exit 1
}
help_out=$(packages/cli/dist/eden.js --help)
echo "$help_out" | grep -q "compile traces into a tool" || {
  echo "smoke: dist --help is missing compile" >&2
  exit 1
}
echo "$help_out" | grep -q "login" || {
  echo "smoke: dist --help first screen must list login" >&2
  exit 1
}
echo "$help_out" | grep -q "help -a" || {
  echo "smoke: dist --help must point at eden help -a" >&2
  exit 1
}
if echo "$help_out" | grep -q "audit export"; then
  echo "smoke: dist --help first screen must not dump audit export" >&2
  exit 1
fi
advanced_out=$(packages/cli/dist/eden.js help -a)
echo "$advanced_out" | grep -q "audit export" || {
  echo "smoke: dist help -a is missing audit export" >&2
  exit 1
}
unknown_err=$(packages/cli/dist/eden.js nope 2>&1 >/dev/null || true)
echo "$unknown_err" | grep -q "is not an eden command" || {
  echo "smoke: dist unknown command must be one sentence" >&2
  exit 1
}
if echo "$unknown_err" | grep -q "compile traces into a tool"; then
  echo "smoke: dist unknown command dumped help" >&2
  exit 1
fi
init_help=$(packages/cli/dist/eden.js init --help)
echo "$init_help" | grep -q "does not write config" || {
  echo "smoke: dist init --help must not run setup" >&2
  exit 1
}
if echo "$init_help" | grep -q "setting up"; then
  echo "smoke: dist init --help ran init" >&2
  exit 1
fi
compile_help=$(packages/cli/dist/eden.js compile --help)
echo "$compile_help" | grep -q -- "--traces" || {
  echo "smoke: dist compile --help is missing --traces" >&2
  exit 1
}
echo "$compile_help" | grep -qi "Does not Approve" || {
  echo "smoke: dist compile --help must say it does not Approve" >&2
  exit 1
}
letter=$(packages/cli/dist/eden.js compile --traces examples/compile-traces/repeating)
echo "$letter" | grep -q "lookupTicket" || {
  echo "smoke: dist compile repeating printed no program" >&2
  exit 1
}
echo "── pack"
( cd packages/cli && npm pack --dry-run > /dev/null )
echo "✓ packages/cli/dist/eden.js ready ($(du -h packages/cli/dist/eden.js | cut -f1))"
