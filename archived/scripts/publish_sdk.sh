#!/usr/bin/env bash
# Wave 29 — Eden SDK publish helper (Python PyPI + TypeScript npm).
#
# Usage:
#   scripts/publish_sdk.sh dry-run     # build + validate only (default)
#   scripts/publish_sdk.sh publish     # upload when credentials present
#   scripts/publish_sdk.sh check       # version / metadata sanity only
#
# Env:
#   SKIP_PY=1 / SKIP_TS=1   skip one package
#   TWINE_USERNAME / TWINE_PASSWORD or ~/.pypirc for PyPI
#   NPM_TOKEN or `npm whoami` session for npm
#
# Never invents credentials. Exits non-zero if publish requested but
# credentials missing.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-dry-run}"
PY_DIR="$ROOT/sdk/python"
TS_DIR="$ROOT/sdk/ts-ai"

# Prefer repo venv (PEP 668 safe), then python3.12+
if [[ -x "$ROOT/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT/.venv/bin/python"
else
  PYTHON_BIN="$(command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)"
fi

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

ensure_build_tools() {
  if ! "$PYTHON_BIN" -c "import build, twine" 2>/dev/null; then
    info "Installing build/twine into a throwaway venv"
    local tmp
    tmp="$(mktemp -d)/eden-publish-venv"
    "$PYTHON_BIN" -m venv "$tmp"
    # shellcheck disable=SC1091
    source "$tmp/bin/activate"
    PYTHON_BIN="$tmp/bin/python"
    "$PYTHON_BIN" -m pip install -q --upgrade pip build twine setuptools wheel
  fi
}

py_version() {
  "$PYTHON_BIN" -c "import tomllib; print(tomllib.load(open('$PY_DIR/pyproject.toml','rb'))['project']['version'])"
}

ts_version() {
  "$PYTHON_BIN" -c "import json; print(json.load(open('$TS_DIR/package.json'))['version'])"
}

check_versions() {
  local pv tv
  pv="$(py_version)"
  tv="$(ts_version)"
  info "Python eden-sdk version: $pv"
  info "TypeScript @eden-ai/sdk version: $tv"
  [[ "$pv" == "$tv" ]] || die "version mismatch: python=$pv ts=$tv"
  grep -q "__version__ = \"$pv\"" "$PY_DIR/eden_sdk/__init__.py" \
    || die "eden_sdk.__version__ out of sync with pyproject ($pv)"
  info "version sync OK ($pv)"
}

has_pypi_creds() {
  if [[ -n "${TWINE_PASSWORD:-}" ]]; then
    return 0
  fi
  if [[ -f "${HOME}/.pypirc" ]] && grep -qE 'password\s*=' "${HOME}/.pypirc"; then
    return 0
  fi
  return 1
}

has_npm_creds() {
  if [[ -n "${NPM_TOKEN:-}" ]]; then
    return 0
  fi
  if npm whoami --registry https://registry.npmjs.org/ >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

build_python() {
  info "Building Python wheel/sdist (python=$PYTHON_BIN)"
  ensure_build_tools
  cd "$PY_DIR"
  rm -rf build dist *.egg-info eden_sdk.egg-info
  "$PYTHON_BIN" -m build --wheel --sdist
  "$PYTHON_BIN" -m twine check dist/*
  info "Python build + twine check PASSED"
}

build_typescript() {
  info "Building TypeScript package"
  cd "$TS_DIR"
  rm -rf dist
  if command -v bun >/dev/null 2>&1; then
    bun run typecheck
    npm run build
  else
    npm run build
  fi
  npm pack --dry-run
  info "TypeScript build + npm pack dry-run PASSED"
}

publish_python() {
  has_pypi_creds || die "PyPI credentials missing (set TWINE_PASSWORD or ~/.pypirc)"
  cd "$PY_DIR"
  info "Uploading eden-sdk to PyPI"
  # Avoid sandbox/local broken HTTP proxies that 403 tunnel to upload.pypi.org
  if ! env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
    "$PYTHON_BIN" -m twine upload dist/*; then
    echo "ERROR: PyPI upload failed" >&2
    return 1
  fi
  info "PyPI upload complete"
  return 0
}

publish_typescript() {
  has_npm_creds || die "npm credentials missing (set NPM_TOKEN or npm login)"
  cd "$TS_DIR"
  info "Publishing @eden-ai/sdk to npm"
  if [[ -n "${NPM_TOKEN:-}" ]]; then
    npm config set "//registry.npmjs.org/:_authToken" "$NPM_TOKEN"
  fi
  if ! env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
    npm publish --access public; then
    echo "ERROR: npm publish failed" >&2
    return 1
  fi
  info "npm publish complete"
  return 0
}

dry_run_publish_preview() {
  # npm publish --dry-run shows the tarball without uploading
  if [[ "${SKIP_TS:-0}" != "1" ]]; then
    cd "$TS_DIR"
    npm publish --dry-run --access public --cache /tmp/eden-npm-cache-w29 2>&1 | tail -20
  fi
  info "Dry-run complete (no registry upload)"
  if has_pypi_creds; then
    info "PyPI credentials: PRESENT"
  else
    info "PyPI credentials: MISSING"
  fi
  if has_npm_creds; then
    info "npm credentials: PRESENT"
  else
    info "npm credentials: MISSING"
  fi
}

case "$MODE" in
  check)
    check_versions
    ;;
  dry-run)
    check_versions
    [[ "${SKIP_PY:-0}" == "1" ]] || build_python
    [[ "${SKIP_TS:-0}" == "1" ]] || build_typescript
    dry_run_publish_preview
    ;;
  publish)
    check_versions
    [[ "${SKIP_PY:-0}" == "1" ]] || build_python
    [[ "${SKIP_TS:-0}" == "1" ]] || build_typescript
    py_ok=0
    ts_ok=0
    if [[ "${SKIP_PY:-0}" != "1" ]]; then
      if has_pypi_creds; then
        publish_python && py_ok=1
      else
        echo "WARN: skipping PyPI publish — credentials missing"
      fi
    fi
    if [[ "${SKIP_TS:-0}" != "1" ]]; then
      if has_npm_creds; then
        publish_typescript && ts_ok=1
      else
        echo "WARN: skipping npm publish — credentials missing"
      fi
    fi
    if [[ "${SKIP_PY:-0}" != "1" && "$py_ok" -eq 0 ]] || [[ "${SKIP_TS:-0}" != "1" && "$ts_ok" -eq 0 ]]; then
      echo "PARTIAL: one or more packages not published (credentials or upload failure)"
      exit 3
    fi
    ;;
  *)
    die "usage: $0 {check|dry-run|publish}"
    ;;
esac
