#!/usr/bin/env bash
# Smoke-test both Eden SDKs from their published wheels / tarballs.
# Useful for CI or post-release sanity checks.
#
# Usage:
#   ./sdk/scripts/verify_sdks.sh
#
# Exits 0 on success, 1 on any failure.

set -euo pipefail

# The script lives in <repo>/sdk/scripts/.  Walk up one level to get
# the SDK root, then derive the workspace root.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PY_DIST=$(ls -t "$SDK_ROOT/python/dist/eden_sdk-"*.whl 2>/dev/null | head -1)
TS_TGZ=$(ls -t "$SDK_ROOT/ts-ai/eden-ai-sdk-"*.tgz 2>/dev/null | head -1)

if [ -z "$PY_DIST" ]; then
  echo "ERROR: no Python wheel in sdk/python/dist/. Run: cd sdk/python && python -m build"
  exit 1
fi
if [ -z "$TS_TGZ" ]; then
  echo "ERROR: no TS tarball in sdk/ts-ai/. Run: cd sdk/ts-ai && npm pack"
  exit 1
fi

# Eden SDK requires Python >= 3.10. Prefer python3.12 / python3.11 / python3.10
# over the system `python3` (which is often 3.9 on macOS).
PYTHON_BIN=$(command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)
if [ -z "$PYTHON_BIN" ]; then
  echo "ERROR: no Python 3.10+ found on PATH"
  exit 1
fi

echo "==> Python wheel: $PY_DIST"
echo "==> TS tarball:   $TS_TGZ"
echo "==> Python:       $($PYTHON_BIN --version)"
echo

# ── Python smoke ───────────────────────────────────────────────────
PY_VENV=$(mktemp -d)/eden-py-verify
"$PYTHON_BIN" -m venv "$PY_VENV"
"$PY_VENV/bin/pip" install -q --upgrade pip
"$PY_VENV/bin/pip" install -q "$PY_DIST"
echo "==> Running scripts/redactor_smoke.py against the Python wheel"
"$PY_VENV/bin/python" "$SDK_ROOT/python/scripts/redactor_smoke.py"
echo

# ── TypeScript smoke ───────────────────────────────────────────────
TS_DIR=$(mktemp -d)/eden-ts-verify
mkdir -p "$TS_DIR"
cd "$TS_DIR"
echo '{"name":"verify","version":"0.0.0","private":true}' > package.json
npm install -q "$TS_TGZ"
cat > smoke.mjs <<'JSEOF'
import { redactPayload } from "@eden-ai/sdk";

const cases = [
  { name: "email",                  input: { text: "ping alice@example.com" },         must: "[REDACTED]", forbid: "alice@example.com" },
  { name: "formatted phone",        input: { phone: "415-555-2671" },                must: "[REDACTED]", forbid: "415-555-2671" },
  { name: "phone with parens",      input: { phone: "(415) 555-2671" },              must: "[REDACTED]", forbid: "(415) 555-2671" },
  { name: "ssn",                    input: { ssn: "123-45-6789" },                   must: "[REDACTED]", forbid: "123-45-6789" },
  { name: "luhn-valid visa",        input: { card: "4111 1111 1111 1111" },          must: "[REDACTED]", forbid: "4111 1111 1111 1111" },
  { name: "pure 10-digit id",       input: { id: "1234567890" },                     must: "1234567890", forbid: "[REDACTED]" },
  { name: "13-digit luhn-invalid",  input: { id: "1234567890123" },                  must: "1234567890123", forbid: "[REDACTED]" },
  { name: "token count",            input: { usage: { total_tokens: 1234567 } },     must: "1234567", forbid: "[REDACTED]" },
  { name: "pii in dict key",        input: { "alice@example.com": "value" },         must: "[REDACTED]", forbid: "alice@example.com" },
  { name: "nested dict",            input: { outer: { inner: "alice@example.com" }}, must: "[REDACTED]", forbid: "alice@example.com" },
  { name: "empty",                  input: {},                                       must: null,         forbid: null },
];

let fails = 0;
for (const c of cases) {
  const out = redactPayload(c.input);
  const flat = JSON.stringify(out);
  if (c.must && !flat.includes(c.must)) {
    console.log(`  [FAIL] ${c.name}: missing ${c.must}`);
    fails++;
    continue;
  }
  if (c.forbid && flat.includes(c.forbid)) {
    console.log(`  [FAIL] ${c.name}: leaked ${c.forbid}`);
    fails++;
    continue;
  }
  if (c.name === "empty" && Object.keys(out).length !== 0) {
    console.log(`  [FAIL] ${c.name}: expected empty, got ${flat}`);
    fails++;
    continue;
  }
  console.log(`  [OK]   ${c.name}`);
}
if (fails) {
  console.log(`\n${fails} failures`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} redactor smoke cases passed.`);
JSEOF
node smoke.mjs
