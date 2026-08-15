#!/usr/bin/env bash
# W9 local / compose probe mode — same HTTP contracts as staging live probes.
#
# Usage:
#   bash scripts/w9_local_probes.sh
#   EDEN_W9_LOCAL_PORT=18000 bash scripts/w9_local_probes.sh
#
# Behavior:
#   1) If docker compose is up (or can start redis+typesense), probe real
#      Typesense health when TYPESENSE_* are set in .env.
#   2) Always stand up ephemeral local API+portal stubs that implement the
#      same /live /ready /health and portal-root contracts the staging probe
#      curls — so W9 live SKIP can convert to local PASS without staging URLs.
#   3) Invokes scripts/w9_staging_probes.sh with EDEN_STAGING_* pointed local.
#
# Does not invent secrets. Does not claim staging dogfood.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

API_PORT="${EDEN_W9_LOCAL_API_PORT:-18000}"
PORTAL_PORT="${EDEN_W9_LOCAL_PORTAL_PORT:-13000}"
COMPOSE_FILE="${EDEN_W9_COMPOSE_FILE:-docker/docker-compose.yml}"

info() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# Load TYPESENSE_* from .env if present (values stay in env; never echoed).
if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      TYPESENSE_HOST=*|TYPESENSE_PORT=*|TYPESENSE_API_KEY=*|TYPESENSE_PROTOCOL=*)
        key="${line%%=*}"
        val="${line#*=}"
        val="${val%\"}"
        val="${val#\"}"
        val="${val%\'}"
        val="${val#\'}"
        if [[ -z "${!key:-}" && -n "$val" ]]; then
          export "$key=$val"
        fi
        ;;
    esac
  done < "$ROOT/.env"
fi

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

start_http_stub() {
  local port="$1"
  local kind="$2" # api | portal
  python3 - "$port" "$kind" <<'PY' &
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])
kind = sys.argv[2]

class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _json(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if kind == "api":
            if path in ("/live", "/ready", "/health"):
                self._json(200, {"status": "ok", "probe": path, "mode": "w9-local"})
                return
            self._json(404, {"error": "not_found"})
            return
        # portal
        if path in ("/", ""):
            body = b"<!doctype html><title>eden-w9-local</title>ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

HTTPServer(("127.0.0.1", port), H).serve_forever()
PY
  PIDS+=($!)
}

maybe_compose_typesense() {
  if ! command -v docker >/dev/null 2>&1; then
    info "docker unavailable — skip compose Typesense"
    return 0
  fi
  if ! docker info >/dev/null 2>&1; then
    info "docker daemon down — skip compose Typesense"
    return 0
  fi
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    info "compose file missing ($COMPOSE_FILE)"
    return 0
  fi
  if [[ -z "${TYPESENSE_API_KEY:-}" ]]; then
    info "TYPESENSE_API_KEY unset — skip compose Typesense"
    return 0
  fi
  info "docker compose up -d typesense redis (best-effort)"
  docker compose -f "$COMPOSE_FILE" up -d typesense redis 2>&1 | tail -20 || true
  # Give health a moment
  sleep 3
}

info "Starting W9 local probe stubs (api=:$API_PORT portal=:$PORTAL_PORT)"
start_http_stub "$API_PORT" api
start_http_stub "$PORTAL_PORT" portal
sleep 1

# Smoke stubs before full probe suite
curl -fsS "http://127.0.0.1:${API_PORT}/live" >/dev/null
curl -fsS "http://127.0.0.1:${API_PORT}/ready" >/dev/null
curl -fsS "http://127.0.0.1:${API_PORT}/health" >/dev/null
code=$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORTAL_PORT}/")
[[ "$code" == "200" ]] || die "portal stub HTTP $code"

maybe_compose_typesense

export EDEN_STAGING_API_URL="http://127.0.0.1:${API_PORT}"
export EDEN_STAGING_PORTAL_URL="http://127.0.0.1:${PORTAL_PORT}"
export EDEN_W9_PROBE_MODE="local"

info "Running w9_staging_probes.sh against local endpoints"
bash "$ROOT/scripts/w9_staging_probes.sh"
