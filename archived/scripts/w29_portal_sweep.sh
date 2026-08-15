#!/usr/bin/env bash
# Wave 29 — portal sweep: no live F22 /issue_fix routes or modules.
# Exits 1 if forbidden live code is found (tests/docs mentions OK).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0

echo "==> W29 portal sweep: ban live issue_fix / /fix pages"

# Portal app routes must not ship /fix pages (redirect-only in next.config is OK)
FIX_DIR="clients/portal/src/app/(portal)/issues/[id]/fix"
if [[ -f "$FIX_DIR/page.tsx" ]] || [[ -f "$FIX_DIR/loading.tsx" ]]; then
  echo "FAIL: live /fix page or loading still present under $FIX_DIR"
  FAIL=1
elif [[ -d "$FIX_DIR" ]]; then
  leftover=$(find "$FIX_DIR" -type f 2>/dev/null | head -5 || true)
  if [[ -n "$leftover" ]]; then
    echo "FAIL: leftover files under $FIX_DIR:"
    echo "$leftover"
    FAIL=1
  else
    rmdir "$FIX_DIR" 2>/dev/null || true
    echo "OK: empty /fix dir removed (or already empty)"
  fi
else
  echo "OK: no portal /issues/[id]/fix directory"
fi

# Live Python modules
if rg -n "issue_fix_chat" src/eden --glob '!**/DELETED*' --glob '!**/*test*' -g '!**/versions/**' 2>/dev/null | rg -v 'drop_issue_fix|W26|DELETED|handoff' | head -5; then
  echo "FAIL: issue_fix_chat references in live src/eden"
  FAIL=1
else
  echo "OK: no live issue_fix_chat module refs"
fi

# Portal source (exclude tests)
hits=$(rg -n "issues/\[id\]/fix/page|/fix/chat|issue_fix_chat" \
  clients/portal/src \
  --glob '!**/__tests__/**' \
  --glob '!**/*test*' \
  --glob '!**/*.test.*' \
  2>/dev/null || true)
# Allow next.config redirect sources and comments about deletion
filtered=$(echo "$hits" | rg -v 'next\.config|handoff|DELETED|W26|redirect' || true)
if [[ -n "${filtered// }" ]]; then
  echo "$filtered"
  echo "FAIL: live /fix route code in portal src"
  FAIL=1
else
  echo "OK: no live /fix page/chat code in portal src"
fi

# next.config must keep permanent redirect
if rg -q 'source: "/issues/:id/fix"' clients/portal/next.config.ts; then
  echo "OK: next.config redirects /fix → handoff"
else
  echo "FAIL: missing /fix → handoff redirect in next.config.ts"
  FAIL=1
fi

# ChatSidebar structural goldens still present
for f in w20-portal.test.ts w21-portal.test.ts w22-portal.test.ts w23-portal.test.ts; do
  if [[ -f "clients/portal/src/lib/__tests__/$f" ]]; then
    echo "OK: ChatSidebar structural suite $f present"
  else
    echo "FAIL: missing $f"
    FAIL=1
  fi
done

# Observe hubs present (traces/issues/alerts)
for p in traces issues alerts; do
  if [[ -f "clients/portal/src/app/(portal)/$p/page.tsx" ]]; then
    echo "OK: Observe hub /$p page present"
  else
    echo "FAIL: missing /$p page"
    FAIL=1
  fi
done

if [[ "$FAIL" -ne 0 ]]; then
  echo "W29 portal sweep: FAIL"
  exit 1
fi
echo "W29 portal sweep: PASS"
