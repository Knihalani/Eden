"""Internal-only middleware.

Gates the ``/v1/internal/*`` namespace so external callers get a
``403 Forbidden`` (not a 404, which would leak existence). The
allow-list is a comma-separated ``INTERNAL_ALLOWED_IPS`` env var
(default ``127.0.0.1,::1`` for localhost).

This is intentionally simpler than a full RBAC system — the
internal health surface is read-only JSON intended for ops +
on-call engineers. Add Clerk-based gating if/when external
operators need dashboard access (Phase 4 B3 deferred to v2).

Per Phase 4 B3: the middleware checks the ``X-Forwarded-For``
header (since Northflank + Vercel terminate TLS upstream) and
falls back to ``request.client.host``. The allow-list match is
exact (no CIDR ranges yet — ponytail).
"""

from __future__ import annotations

import json
import logging
import os

from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger(__name__)


# Default to loopback only. Operators set INTERNAL_ALLOWED_IPS to
# a comma-separated list when running behind a reverse proxy (e.g.
# the Northflank + Vercel deploy sets it to the platform egress
# CIDRs in .env.production).
DEFAULT_ALLOWED_IPS: tuple[str, ...] = ("127.0.0.1", "::1")


def _get_allowed_ips() -> tuple[str, ...]:
    raw = os.environ.get("INTERNAL_ALLOWED_IPS", "")
    if not raw:
        return DEFAULT_ALLOWED_IPS
    return tuple(ip.strip() for ip in raw.split(",") if ip.strip())


class InternalOnlyMiddleware:
    """Pure-ASGI 403 gate on ``/v1/internal/health/*``.

    Audit 2026-07-06 v2.0 — converted from
    :class:`starlette.middleware.base.BaseHTTPMiddleware` to pure
    ASGI. The dispatch path is now byte-comparison + direct
    header walk; no ``Request`` reconstruction. Behaviour
    preserved:

      * Only the ``/v1/internal/health/*`` subtree is gated. The
        rest of ``/v1/internal/*`` (portal-proxied endpoints) has
        its own Clerk-based auth and is left alone.
      * IP allow-list is checked on ``scope["client"][0]`` first;
        ``X-Forwarded-For`` is honoured only when the TCP source
        is itself allow-listed (so remote callers can't spoof loopback).
      * Non-allow-listed callers get a 403 JSON envelope.

    The 403 body is built inline as ASGI ``http.response.start`` +
    ``http.response.body`` rather than via ``JSONResponse.__call__``.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.allowed_ips = _get_allowed_ips()

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # The middleware only gates the ops dashboard surface
        # (``/v1/internal/health/*``). All other ``/v1/internal/*``
        # namespaces are portal-proxied endpoints with their own
        # Clerk-based auth.
        path = scope.get("path", "")
        if not path.startswith("/v1/internal/health"):
            await self.app(scope, receive, send)
            return

        # IP resolution — direct scope fields, no Request construction.
        # Trusted-proxy model:
        #   1. TCP peer must be allow-listed (loopback or platform LB).
        #   2. If X-Forwarded-For is present, unwrap the leftmost hop and
        #      require THAT client IP to also be allow-listed.
        # Never honour XFF from an untrusted TCP peer (spoof).
        # Never allow "TCP peer is LB" alone to grant access to every
        # downstream client without checking the real client IP.
        client = scope.get("client") or ("", 0)
        tcp_peer = client[0] if client else ""

        if tcp_peer not in self.allowed_ips:
            logger.warning(
                "internal_only: blocked %s from untrusted peer %s",
                path,
                tcp_peer or "(unknown)",
            )
            await self._forbid(path, tcp_peer or None, send)
            return

        client_ip = tcp_peer
        for name, value in scope.get("headers") or ():
            if name.lower() == b"x-forwarded-for":
                xff_raw = value.decode("latin1", errors="ignore")
                xff = xff_raw.split(",")[0].strip() if xff_raw else ""
                if xff:
                    client_ip = xff
                break

        if client_ip not in self.allowed_ips:
            logger.warning(
                "internal_only: blocked %s from %s (via trusted peer %s)",
                path,
                client_ip or "(unknown)",
                tcp_peer,
            )
            await self._forbid(path, client_ip or None, send)
            return

        await self.app(scope, receive, send)

    async def _forbid(
        self, path: str, client_ip: str | None, send: Send
    ) -> None:
        body = json.dumps({
            "status": "forbidden",
            "message": (
                "The /v1/internal/health/* surface is allow-listed. "
                "Set INTERNAL_ALLOWED_IPS to grant access."
            ),
            "client_ip": client_ip,
        }).encode("latin1")
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("latin1")),
            ],
        })
        await send({
            "type": "http.response.body",
            "body": body,
            "more_body": False,
        })

