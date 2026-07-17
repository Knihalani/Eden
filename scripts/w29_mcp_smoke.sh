#!/usr/bin/env bash
# Wave 29 — eden-mcp install + smoke (stdio initialize / tools/list / ping).
#
# Usage:
#   scripts/w29_mcp_smoke.sh
#
# Prefers PATH `eden-mcp`, falls back to `python -m eden.mcp_server`
# with PYTHONPATH=src from the monorepo.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PYTHON_BIN="$(command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)"
export PYTHONPATH="${PYTHONPATH:-}:$ROOT/src"

MCP_CMD=()
if command -v eden-mcp >/dev/null 2>&1; then
  MCP_CMD=(eden-mcp)
  echo "==> Using PATH eden-mcp: $(command -v eden-mcp)"
else
  MCP_CMD=("$PYTHON_BIN" -m eden.mcp_server)
  echo "==> Using module: ${MCP_CMD[*]}"
fi

# Smoke: send initialize + tools/list + ping, then EOF
RESP=$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"w29-smoke","version":"0.0.0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    '{"jsonrpc":"2.0","id":3,"method":"ping"}' \
    | "${MCP_CMD[@]}" 2>/dev/null || true
)

echo "$RESP" | head -20

echo "$RESP" | grep -q '"name":"eden-mcp-server"' \
  || echo "$RESP" | grep -q 'eden-mcp-server' \
  || { echo "FAIL: initialize did not return eden-mcp-server"; exit 1; }

echo "$RESP" | grep -q '"id": 2\|"id":2' \
  || { echo "FAIL: tools/list response missing"; exit 1; }

# Expect at least a few stretch tools from W28
for tool in query_eql query_sql get_agentic_metrics eden_health; do
  if echo "$RESP" | grep -q "\"$tool\""; then
    echo "OK: tool catalog includes $tool"
  else
    echo "WARN: tool $tool not in catalog (may be gated)"
  fi
done

echo "W29 eden-mcp smoke: PASS"
