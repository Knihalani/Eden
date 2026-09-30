"""HTTP client for the hosted Eden runtime.

Pure stdlib (urllib) — no third-party dependencies, Python >= 3.9.

Honesty invariants:

- Nothing in this module can approve anything. Approval happens only on the
  Eden website; a key never turns a tool On. These calls only *ask* the
  runtime whether a compiled tool answers, *execute* an already-On tool, or
  *record* what the agent did anyway.
- Configuration comes from arguments first, then ``EDEN_API_KEY`` /
  ``EDEN_PLANE_URL`` (with ``EDEN_BASE_URL`` kept as an alias), so hosts can
  point the SDK at their plane without code changes.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlsplit

# The wrap plane (`eden wrap`) defaults to 8788; 8787 is the dashboard.
DEFAULT_BASE_URL = "http://127.0.0.1:8788"

#: Wire-protocol version; must match the server's X-Eden-Version gate.
EDEN_PROTOCOL_VERSION = 1
DEFAULT_API_KEY = "eden_dev"
DEFAULT_TIMEOUT_SECONDS = 5.0


class EdenError(RuntimeError):
    """A request to the runtime failed (non-2xx, bad body, network)."""

    def __init__(self, message: str, *, status: int | None = None, url: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.url = url


class EdenTimeoutError(EdenError):
    """The runtime did not answer within the configured timeout."""


def _is_loopback(base: str) -> bool:
    host = (base.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0]).lower()
    return host in {"127.0.0.1", "localhost", "::1"}


def _resolve(base_url: str | None, api_key: str | None) -> tuple[str, str]:
    base = (
        base_url
        or os.environ.get("EDEN_PLANE_URL")
        or os.environ.get("EDEN_BASE_URL")
        or DEFAULT_BASE_URL
    )
    key = api_key or os.environ.get("EDEN_API_KEY")
    if not key:
        key = _local_key(base) if _is_loopback(base) else ""
    return base.rstrip("/"), key


def _loopback_port(url: str) -> int | None:
    """The port of a loopback URL, else None (http://localhost:1@evil.example is not loopback)."""
    try:
        parts = urlsplit(url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        return None
    return port if parts.hostname in {"127.0.0.1", "localhost", "::1"} else None


def _local_key(base: str) -> str:
    """The key ``eden wrap`` or ``eden login`` saved in $EDEN_HOME/config.json.

    Defaults to ~/.eden, and is sent only to the loopback port it was saved
    for. Otherwise the public ``eden_dev``, which only a ``--dev`` wrap or
    ``eden demo`` accepts.
    """
    home = os.environ.get("EDEN_HOME") or os.path.join(os.path.expanduser("~"), ".eden")
    try:
        with open(os.path.join(home, "config.json"), encoding="utf-8") as f:
            saved = json.load(f)
        key, saved_base = saved.get("api_key"), saved.get("base_url")
    except (OSError, ValueError, AttributeError):
        return DEFAULT_API_KEY
    port = _loopback_port(base)
    same_port = port is not None and isinstance(saved_base, str) and _loopback_port(saved_base) == port
    return key if same_port and isinstance(key, str) and key else DEFAULT_API_KEY


class EdenClient:
    """Small typed-ish client: every method returns plain dicts."""

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout: float | None = None,
    ) -> None:
        self.base_url, self.api_key = _resolve(base_url, api_key)
        self.timeout = DEFAULT_TIMEOUT_SECONDS if timeout is None else timeout

    # -- low level ---------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST/GET one JSON exchange. Raises :class:`EdenError` on failure."""
        url = f"{self.base_url}{path}"
        data = None
        headers = {"Authorization": f"Bearer {self.api_key}", "X-Eden-Version": str(EDEN_PROTOCOL_VERSION)}
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["content-type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout if timeout is None else timeout) as res:
                raw = res.read().decode()
        except urllib.error.HTTPError as exc:
            try:
                detail = json.loads(exc.read().decode())
                message = detail.get("error") if isinstance(detail, dict) else None
            except Exception:
                message = None
            raise EdenError(
                message or f"{method} {path} failed",
                status=exc.code,
                url=url,
            ) from exc
        except Exception as exc:
            raise EdenTimeoutError(
                f"{method} {path} timed out or was unreachable ({exc.__class__.__name__})",
                url=url,
            ) from exc
        if not raw:
            return {}
        try:
            body = json.loads(raw)
        except ValueError as exc:
            raise EdenError(f"{method} {path} returned non-JSON body", url=url) from exc
        if not isinstance(body, dict):
            raise EdenError(f"{method} {path} returned a non-object JSON body", url=url)
        return body

    def post(self, path: str, payload: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        return self.request("POST", path, payload, timeout)

    # -- product contract --------------------------------------------------

    def wrap(self, name: str, args: dict[str, Any], run_id: str | None = None) -> dict[str, Any]:
        """Ask whether a compiled tool answers for this call.

        Returns ``{"action": "play", "facts"|"text": ...}`` when the runtime
        serves the compiled tool, or ``{"action": "original"}`` when the agent
        should run the real thing.
        """
        body: dict[str, Any] = {"name": name, "args": args}
        if run_id:
            body["run_id"] = run_id
        return self.post("/v1/wrap", body)

    def play(self, name: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        """Execute an already-approved (state='on') compiled tool via /v1/play."""
        body: dict[str, Any] = {"name": name}
        if args is not None:
            body["args"] = args
        return self.post("/v1/play", body)

    def ingest(
        self,
        *,
        agent_id: str,
        run_id: str,
        events: list[dict[str, Any]],
        stretch_end: bool = False,
    ) -> dict[str, Any]:
        """Record observed tool calls. Best-effort by design; callers must
        treat every failure here as ignorable."""
        return self.post(
            "/v1/ingest",
            {"agent_id": agent_id, "run_id": run_id, "stretch_end": bool(stretch_end), "events": events},
        )

    def end_run(self, run_id: str, agent_id: str = "sdk_py") -> dict[str, Any]:
        """Mark a recorded run finished (stretch_end). Records only."""
        return self.ingest(agent_id=agent_id, run_id=run_id, events=[], stretch_end=True)


__all__ = ["EdenClient", "EdenError", "EdenTimeoutError"]
