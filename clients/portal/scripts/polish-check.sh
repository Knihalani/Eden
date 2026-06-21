#!/usr/bin/env bash
# ponytail: post-polish invariant checks. Returns non-zero if any
# hardcoded hex, duplicate SeverityBadge def, dead mock array, or
# the old logo.svg sneaks back in. Run after any UI polish pass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ checking for hardcoded hex outside globals.css / clerk-theme.ts…"
# The analytics-tab holds a known SSR fallback const (CHART_COLORS_FALLBACK)
# for when window is undefined. Every other hex should be a design token.
if grep -rE '#[0-9a-fA-F]{6}' src/app src/components 2>/dev/null \
  | grep -v 'globals.css' | grep -v 'clerk-theme.ts' \
  | grep -v 'analytics-tab.tsx'; then
  echo "✗ hardcoded hex found (see above)"
  exit 1
fi

echo "→ checking for local SeverityBadge defs (should only live in status-badge.tsx)…"
if grep -rn 'function SeverityBadge' src 2>/dev/null \
  | grep -v 'ui/status-badge.tsx'; then
  echo "✗ duplicate SeverityBadge def found"
  exit 1
fi

echo "→ checking for old logo.svg…"
if [ -f public/logo.svg ]; then
  echo "✗ public/logo.svg should be deleted (use logo.png)"
  exit 1
fi

echo "→ checking for unused MOCK_INJECTIONS / MOCK_PII_REDACTIONS…"
# Skip comment lines — the replacement-of-mock comments in guardrails and
# lib/api.ts are intentional documentation.
MATCHES=$(grep -rn 'MOCK_INJECTIONS\|MOCK_PII_REDACTIONS' src 2>/dev/null || true)
if [ -n "$MATCHES" ]; then
  CODE_MATCHES=$(echo "$MATCHES" | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' || true)
  if [ -n "$CODE_MATCHES" ]; then
    echo "✗ dead mock arrays found:"
    echo "$CODE_MATCHES"
    exit 1
  fi
fi

echo "✓ all polish invariants pass"
