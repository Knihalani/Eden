"""Shared in-thread stub HTTP server for the eden SDK tests.

No third-party imports; everything is http.server + unittest.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# Make the package importable no matter how discovery was invoked.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

Routes = dict[str, Any]  # path -> {"code": int, "body": dict, "delay": float}


def make_stub_server(routes: Routes) -> tuple[ThreadingHTTPServer, list[dict[str, Any]]]:
    """Start a ThreadingHTTPServer answering POSTs per ``routes``.

    Returns (server, seen) where ``seen`` records every request as
    ``{"path", "authorization", "content_type", "body"}``.
    """
    seen: list[dict[str, Any]] = []
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib signature
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                body = json.loads(raw.decode() or "{}")
            except ValueError:
                body = {}
            with lock:
                seen.append(
                    {
                        "path": self.path,
                        "authorization": self.headers.get("Authorization"),
                        "content_type": self.headers.get("content-type"),
                        "body": body,
                    }
                )
            spec = routes.get(self.path)
            if spec is None:
                self._respond(404, {"error": "not found"})
                return
            if spec.get("delay"):
                time.sleep(spec["delay"])
            self._respond(spec.get("code", 200), spec.get("body", {}))

        def _respond(self, code: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_args: Any) -> None:  # keep test output quiet
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # Attach `seen` to the server object so tests can read it.
    server.seen = seen  # type: ignore[attr-defined]
    return server, seen
