"""Correlation ID middleware for request tracing across services.

Provides a unique identifier for every request that propagates through
logs, database queries, and downstream service calls.
"""

import contextvars
import re
import uuid
from typing import Any

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

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


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    """Middleware that assigns or propagates a correlation ID per request.

    Reads the ``X-Request-ID`` header from incoming requests. If absent,
    generates a new UUIDv4. The ID is stored in a context variable so it
    can be accessed anywhere during the request lifecycle, and is echoed
    back in the response headers.
    """

    HEADER_NAME = "X-Request-ID"

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        # Read existing correlation ID from header or generate a new one
        raw_header = request.headers.get(self.HEADER_NAME)
        correlation_id = _sanitize_correlation_id(raw_header)

        # Set the context variable for this request
        token = CORRELATION_ID.set(correlation_id)

        try:
            # Process the request
            response: Response = await call_next(request)

            # Add correlation ID to response headers
            response.headers[self.HEADER_NAME] = correlation_id
            return response
        finally:
            # Reset the context variable even if the request handler raises
            CORRELATION_ID.reset(token)


def get_correlation_id() -> str:
    """Get the current request's correlation ID.

    Returns:
        The correlation ID for the current async context, or an empty string
        if called outside of a request lifecycle.
    """
    return CORRELATION_ID.get("")
