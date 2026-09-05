#!/usr/bin/env bash
# Publish CLI + JS SDK + Python wheel.
#
# npmjs.org: the name `eden` is taken (0.3.1). We publish @kaiavn/eden and
# @kaiavn/sdk. Needs `npm login` (or NPM_TOKEN) and org access to @kaiavn.
#
# GitHub Packages: GH_TOKEN / GITHUB_TOKEN with write:packages.
#
# GitHub Release: `gh` with `repo` scope. The repo is private — release
# assets are not a public install path. Hosted wrap is the stranger door.
#
# Usage:
#   bash scripts/publish.sh              # try npmjs, GH packages, then a release
#   EDEN_SKIP_CHECKS=1 bash scripts/publish.sh
#   EDEN_PUBLISH_DRY=1 bash scripts/publish.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./packages/cli/package.json').version")"
OUT="${EDEN_PUBLISH_DIR:-.local/publish}"
ABS_OUT="$(pwd)/$OUT"
rm -rf "$ABS_OUT"
mkdir -p "$ABS_OUT"

EDEN_SKIP_CHECKS="${EDEN_SKIP_CHECKS:-1}" ./scripts/build-cli.sh
( cd packages/sdk-js && bun run build )

echo ""
echo "── npm pack"
( cd packages/cli && npm pack --pack-destination "$ABS_OUT" >/dev/null )
( cd packages/sdk-js && npm pack --pack-destination "$ABS_OUT" >/dev/null )
cp "$ABS_OUT"/kaiavn-eden-*.tgz "$ABS_OUT/eden.tgz"
cp "$ABS_OUT"/kaiavn-sdk-*.tgz "$ABS_OUT/kaiavn-sdk.tgz"

echo "── python pack"
if ! python3 -m build --help >/dev/null 2>&1; then
  python3 -m pip install --user -q build
fi
( cd packages/sdk-py && python3 -m build --outdir "$ABS_OUT" )

echo ""
echo "Artifacts in $OUT:"
ls -lh "$OUT"

if [ "${EDEN_PUBLISH_DRY:-}" = "1" ]; then
  echo "EDEN_PUBLISH_DRY=1 — not uploading."
  exit 0
fi

if npm whoami >/dev/null 2>&1; then
  echo "── npmjs.org as $(npm whoami)"
  ( cd packages/cli && npm publish --access public ) || true
  ( cd packages/sdk-js && npm publish --access public ) || true
else
  echo "── npmjs.org: not logged in. Skipping."
fi

gh_token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -z "$gh_token" ] && command -v gh >/dev/null 2>&1; then
  gh_token="$(gh auth token 2>/dev/null || true)"
fi
if [ -n "$gh_token" ]; then
  echo "── GitHub Packages @kaiavn"
  printf '//npm.pkg.github.com/:_authToken=%s\n@kaiavn:registry=https://npm.pkg.github.com\n' "$gh_token" > /tmp/eden-npmrc-gh
  ( cd packages/cli && npm publish --access public --userconfig /tmp/eden-npmrc-gh --registry https://npm.pkg.github.com ) || true
  ( cd packages/sdk-js && npm publish --access public --userconfig /tmp/eden-npmrc-gh --registry https://npm.pkg.github.com ) || true
  rm -f /tmp/eden-npmrc-gh
else
  echo "── GitHub Packages: no token. Skipping."
fi

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "── GitHub Release v$VERSION"
  notes="$(cat <<EOF
Private artifacts for Eden $VERSION (KaiavN/Eden is not public).

Hosted wrap: https://useeden.vercel.app — POST /v1/signup.
Compile does not Approve. An Eden key is wrap auth, not OpenAI.
EOF
)"
  assets=("$OUT/eden.tgz" "$OUT/kaiavn-sdk.tgz")
  shopt -s nullglob
  assets+=("$OUT"/eden_agent-*.whl "$OUT"/eden_agent-*.tar.gz)
  shopt -u nullglob
  if gh release view "v$VERSION" --repo KaiavN/Eden >/dev/null 2>&1; then
    gh release upload "v$VERSION" "${assets[@]}" --repo KaiavN/Eden --clobber
  else
    gh release create "v$VERSION" "${assets[@]}" \
      --repo KaiavN/Eden \
      --title "eden $VERSION" \
      --notes "$notes"
  fi
else
  echo "── GitHub Release: gh not authenticated. Skipping."
fi

echo "Done. Repo is private. Hosted wrap: https://useeden.vercel.app"
