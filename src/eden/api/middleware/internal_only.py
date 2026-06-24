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

import logging
import os
from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

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


class InternalOnlyMiddleware(BaseHTTPMiddleware):
    """403 any non-allow-listed caller to ``/v1/internal/*``."""

    def __init__(self, app: object) -> None:
        super().__init__(app)  # type: ignore[arg-type]
        self.allowed_ips = _get_allowed_ips()

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        # The middleware only gates the ops dashboard surface
        # (``/v1/internal/health/*``). The other ``/v1/internal/*``
        # namespaces (e.g. ``/v1/internal/onboarding/*``) are
        # internal API routes called via the portal proxy — they
        # have their own Clerk-based auth and don't need an
        # allow-list gate.
        if not request.url.path.startswith("/v1/internal/health"):
            return await call_next(request)

        # Honour X-Forwarded-For first (Northflank terminates TLS),
        # fall back to client.host.
        forwarded = request.headers.get("x-forwarded-for", "")
        client_ip = forwarded.split(",")[0].strip() if forwarded else (
            request.client.host if request.client else ""
        )

        if client_ip not in self.allowed_ips:
            logger.warning(
                "internal_only: blocked %s from %s",
                request.url.path,
                client_ip or "(unknown)",
            )
            return JSONResponse(
                {
                    "status": "forbidden",
                    "message": (
                        "The /v1/internal/health/* surface is allow-listed. "
                        "Set INTERNAL_ALLOWED_IPS to grant access."
                    ),
                    "client_ip": client_ip or None,
                },
                status_code=403,
            )

        return await call_next(request)


__all__ = ["DEFAULT_ALLOWED_IPS", "InternalOnlyMiddleware"]