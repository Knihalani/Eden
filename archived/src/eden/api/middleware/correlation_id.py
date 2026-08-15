"""Correlation ID middleware for request tracing across services.

Provides a unique identifier for every request that propagates through
logs, database queries, and downstream service calls.
"""

import contextlib
import contextvars
import re
import uuid

from starlette.types import ASGIApp, Receive, Scope, Send

# Context variable to store the correlation ID for the current request
CORRELATION_ID = contextvars.ContextVar("correlation_id", default="")

# Safe characters for correlation IDs: alphanumerics, hyphens, underscores, dots
_CORR_ID_RE = re.compile(r"[^a-zA-Z0-9_.-]")
_CORR_ID_MAX_LEN = 64


def _sanitize_correlation_id(raw: str | None) -> str:
    """Sanitize a correlation ID to prevent log injection.

    Strips any character outside ``[a-zA-Z0-9_.-]`` and truncates to 64
    characters. If the input is empty or becomes empty after sanitization,
    a new UUIDv4 is returned.
    """
    if not raw:
        return str(uuid.uuid4())
    cleaned = _CORR_ID_RE.sub("", raw)[:_CORR_ID_MAX_LEN]
    return cleaned or str(uuid.uuid4())


# Audit 2026-07-06 v1.9 — pre-computed header bytes (was
# ``response.headers[HEADER_NAME] = corr`` inside dispatch; the ASGI
# layer speaks bytes).
_HEADER_NAME_BYTES = b"x-request-id"


class CorrelationIdMiddleware:
    """Pure-ASGI middleware that assigns or propagates a correlation
    ID per request.

    Audit 2026-07-06 v1.9 — converted from
    :class:`starlette.middleware.base.BaseHTTPMiddleware` to a pure
    ASGI ``__call__`` (same ``BaseHTTPMiddleware`` tax as
    :class:`LatencyMiddleware`). Behaviour preserved:

    * Reads the ``X-Request-ID`` header from incoming requests,
      generating a UUIDv4 when absent.
    * Stores the ID in :data:`CORRELATION_ID` so downstream code can
      read it via :func:`get_correlation_id`.
    * Echoes it back in the response ``X-Request-ID`` header.
    * Resets the contextvar on both success and exception paths.
    """

    HEADER_NAME = "X-Request-ID"

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Read existing correlation ID from headers or generate a new one.
        # Manual header walk (rather than building a Starlette ``Request``)
        # to stay in the pure-ASGI hot path.
        raw_header: str | None = None
        for name, value in scope.get("headers") or ():
            if name.lower() == _HEADER_NAME_BYTES:
                with contextlib.suppress(Exception):
                    raw_header = value.decode("latin1")
                break
        correlation_id = _sanitize_correlation_id(raw_header)

        token = CORRELATION_ID.set(correlation_id)
        # Pre-compute the bytes form so the hot path doesn't encode per
        # request.
        corr_bytes = correlation_id.encode("latin1")
        try:
            async def send_wrapper(message):
                if message["type"] == "http.response.start":
                    headers = message.get("headers") or []
                    headers.append((_HEADER_NAME_BYTES, corr_bytes))
                    message["headers"] = headers
                await send(message)

            await self.app(scope, receive, send_wrapper)
        finally:
            CORRELATION_ID.reset(token)


def get_correlation_id() -> str:
    """Get the current request's correlation ID.

    Returns:
        The correlation ID for the current async context, or an empty string
        if called outside of a request lifecycle.
    """
    return CORRELATION_ID.get("")
