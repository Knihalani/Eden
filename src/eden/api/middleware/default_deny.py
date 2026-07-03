"""Default-deny authentication middleware.

Posture: every request MUST carry a valid auth context (cookie or
bearer). Public routes are an explicit, narrow allow-list; anything
not on the list is rejected with 401.

The allow-list covers the minimum surface that must be reachable
without credentials:
  * Health probes (/health, /health/*)
  * OpenAPI docs (/docs, /openapi.json, /redoc, /scalar*)
  * Public auth flow (/auth/login, /auth/signup, /auth/forgot-password,
    /auth/reset-password, /auth/verify-email, /auth/2fa/recover)
  * Webhook receivers (/webhooks/* — verified per-receiver)
  * Cross-origin ingestion (uses X-Org-Api-Key)
  * Internal ops surface (already gated by InternalOnlyMiddleware)

Why default-deny: the previous posture was opt-in — every route
handler had to remember to add ``Depends(get_current_user)``. One
missed handler and the route shipped without auth. With this
middleware in place, forgetting the dep fails CLOSED, not open.

The middleware itself does NOT verify the token (that's a job
for the route's Depends). It only confirms that *some* auth
header / cookie is present. The real check happens at the
dep, so a malformed token still 401s at the route layer.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)


# Exact path prefixes that bypass the auth check. Order doesn't
# matter — the match is a startswith on the path. Keep this list
# short; every entry should be a route that genuinely cannot
# require auth (e.g. /auth/login to GET the login form).
DEFAULT_PUBLIC_PREFIXES: tuple[str, ...] = (
    # Health + docs
    "/health",
    "/docs",
    "/openapi.json",
    "/redoc",
    "/scalar",
    # Public auth flow
    "/auth/login",
    "/auth/signup",
    "/auth/signup-from-invite",
    "/auth/forgot-password",
    "/auth/reset-password",
    "/auth/verify-email",
    "/auth/verify-invite-token",
    # Webhook receivers — verified per-receiver with HMAC, not JWT
    "/webhooks",
    "/clerk/webhook",
    # Cross-origin ingestion — uses X-Org-Api-Key
    "/v1/ingest",
    "/gateway",
    # Internal ops surface (further gated by InternalOnlyMiddleware)
    "/v1/internal",
)


def _is_public(path: str) -> bool:
    """True if ``path`` is on the public allow-list."""
    for prefix in DEFAULT_PUBLIC_PREFIXES:
        if path == prefix or path.startswith(prefix + "/") or path == prefix:
            return True
    return False


class DefaultDenyAuthMiddleware(BaseHTTPMiddleware):
    """Require *some* auth credential on every non-public request.

    What this catches: a forgotten ``Depends(get_current_user)`` on
    a new endpoint. The handler would be open in the old posture;
    here it returns 401 before the handler is even invoked.

    What this does NOT do: verify the token. Verification is the
    job of the route's dependency, so a forged token still 401s
    at the dep rather than being silently trusted by this layer.
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if _is_public(request.url.path):
            return await call_next(request)

        # Some auth context must be present. We accept either a
        # cookie (the Eden session) or a Bearer header (Clerk,
        # API key, etc.). If neither is present, reject.
        has_cookie = bool(request.cookies.get("authorization"))
        has_bearer = bool(
            request.headers.get("authorization", "").lower().startswith("bearer ")
        )
        # Some ingestion endpoints use custom headers; accept any
        # non-empty auth-related header so we don't false-positive
        # on routes the dep will then verify properly.
        has_other = any(
            h.lower() in ("x-org-api-key", "x-clerk-auth", "x-api-key")
            for h in request.headers
        )

        if not (has_cookie or has_bearer or has_other):
            # Log the rejection so an attacker scanning the surface
            # is visible in the audit trail.
            logger.info(
                "default-deny: rejected %s %s (no auth context)",
                request.method,
                request.url.path,
            )
            # Build the 401 in the project's standard envelope shape
            # (``{error, detail, request_id}``) so the portal's
            # ``proxyError`` can destructure it consistently. (The
            # previous bare ``{"detail": ...}`` body skipped the
            # global exception handler because ``BaseHTTPMiddleware``
            # doesn't propagate raised HTTPExceptions. We can't
            # raise here — the ASGI base class would surface the
            # exception as an unhandled 500. Build the response
            # directly. July 2026 site-wide fix.)
            import uuid
            from fastapi.responses import JSONResponse
            request_id = (
                request.headers.get("x-request-id")
                or request.headers.get("x-correlation-id")
                or str(uuid.uuid4())
            )
            return JSONResponse(
                status_code=401,
                content={
                    "error": "unauthorized",
                    "detail": "Authentication required",
                    "request_id": request_id,
                },
            )

        return await call_next(request)