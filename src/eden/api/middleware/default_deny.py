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

Audit 2026-07-03 — implemented as a pure ASGI middleware so
``scope["type"] == "websocket"`` upgrades also go through the
allow-list. ``BaseHTTPMiddleware`` (the pre-fix implementation)
only fires on HTTP — Starlette dispatches WebSocket upgrades
without invoking the HTTP middleware chain's ``dispatch`` for
the auth-checking path. The pure-ASGI form below inspects
the ``scope`` directly and rejects unauthorised WS upgrades with
``websocket.close(code=4401)`` so a future WS route that
forgets to call ``_authenticate_ws`` ships closed, not open.
"""

from __future__ import annotations

import contextlib
import logging

from starlette.types import ASGIApp, Receive, Scope, Send

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
    # GitHub App integration — public so the OAuth callback
    # (which the user lands on with NO Eden auth) and the GitHub
    # webhook (HMAC-verified, no JWT) can be reached. ``configured``
    # is also public — it returns the boolean ``is_configured()``
    # flag + app slug, no org data. Internal write-side routes
    # (``/integrations/github/authorize``) re-gate with
    # ``integrations:write`` permission at the route layer.
    "/integrations/github",
    # Cross-origin ingestion — uses X-Org-Api-Key
    "/v1/ingest",
    "/gateway",
    # Internal ops surface (further gated by InternalOnlyMiddleware)
    "/v1/internal",
)


# Header names accepted as "some auth context is present". Header
# lookup is case-insensitive at the ASGI scope layer.
_AUTH_HEADER_NAMES_LOWER: frozenset[str] = frozenset(
    {"x-org-api-key", "x-clerk-auth", "x-api-key"}
)
_COOKIE_NAME = "authorization"
_BEARER_HEADER = "authorization"


def _is_public(path: str) -> bool:
    """True if ``path`` is on the public allow-list."""
    for prefix in DEFAULT_PUBLIC_PREFIXES:
        if path in (prefix, prefix) or path.startswith(prefix + "/"):
            return True
    return False


def _scope_has_credential(scope: Scope) -> bool:
    """True iff ``scope`` headers / query contain an auth-bearing token.

    Used by both HTTP and WebSocket branches so a forgotten
    ``_authenticate_ws`` on a new endpoint ships closed, not open.
    """
    headers = scope.get("headers") or []
    headers_lc = {h[0].lower(): h[1] for h in headers}

    # 1. Bearer header.
    bearer = headers_lc.get(_BEARER_HEADER.encode(), b"")
    if bearer.lower().startswith(b"bearer "):
        return True
    # 2. Cookie.
    cookie = headers_lc.get(b"cookie", b"").decode("latin1", errors="ignore")
    if f"{_COOKIE_NAME}=" in cookie:
        return True
    # 3. Custom auth headers (X-Org-Api-Key, X-Clerk-Auth, X-Api-Key).
    for name_lower in _AUTH_HEADER_NAMES_LOWER:
        if headers_lc.get(name_lower.encode()):
            return True
    # 4. ``?token=`` query param — WS routes use this; deprecated but
    # accepted for backwards compatibility with the live client SDK.
    if scope.get("type") == "websocket":
        query = scope.get("query_string", b"").decode("latin1", errors="ignore")
        if "token=" in query:
            return True
        # 5. ``Sec-WebSocket-Protocol: eden-auth-<base64url-token>``
        # subprotocol header — PREFERRED WS auth path (the
        # subprotocol value isn't logged by reverse proxies the way
        # query params are). The server picks ``eden-auth-...`` and
        # echoes it back; we just need its presence here so the
        # upgrade isn't 4401'd at this layer.
        subproto = headers_lc.get(b"sec-websocket-protocol", b"").decode(
            "latin1", errors="ignore",
        )
        if "eden-auth-" in subproto:
            return True
    return False


class DefaultDenyAuthMiddleware:
    """Pure-ASGI default-deny middleware.

    Two branches: HTTP requests get the standard 401 JSON envelope on
    rejection; WebSocket upgrades get a synchronous ``websocket.close``
    with code 4401 (custom non-normative code meaning "auth required")
    before the inner app is ever invoked. Either way, a forgotten
    ``Depends`` or ``_authenticate_ws`` on a new endpoint ships closed.

    What this catches: a forgotten ``Depends(get_current_user)`` on a
    new HTTP endpoint, or a forgotten ``_authenticate_ws`` on a new
    WebSocket endpoint. Both cases were previously exploitable
    because ``BaseHTTPMiddleware`` only wrapped the HTTP path; WS
    upgrades bypassed the auth check entirely.

    What this does NOT do: verify the token. Verification is the
    job of the route's dependency, so a forged token still 401s
    at the dep rather than being silently trusted by this layer.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        path = scope.get("path", "")
        if _is_public(path) or _scope_has_credential(scope):
            await self.app(scope, receive, send)
            return

        if scope["type"] == "websocket":
            # Close the WS upgrade synchronously before the inner app
            # sees the connection. Sending an HTTP 401-style body on a
            # rejected WS upgrade is non-conformant; ``websocket.close``
            # with a custom code is the documented path.
            with contextlib.suppress(Exception):
                await send({"type": "websocket.close", "code": 4401})
            return

        # HTTP branch — build the standard envelope.
        logger.info(
            "default-deny: rejected %s %s (no auth context)",
            scope.get("method"),
            path,
        )
        import uuid

        from fastapi.responses import JSONResponse

        # Echo the inbound ``X-Request-ID`` so support can correlate
        # the rejection with a server-side log entry.
        request_id = str(uuid.uuid4())
        for h_name, h_val in scope.get("headers") or []:
            if h_name.lower() == b"x-request-id":
                with contextlib.suppress(Exception):
                    request_id = h_val.decode("latin1")
                break
        response = JSONResponse(
            status_code=401,
            content={
                "error": "unauthorized",
                "detail": "Authentication required",
                "request_id": request_id,
            },
        )
        await response(scope, receive, send)
