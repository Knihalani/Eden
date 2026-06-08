"""HTTP middleware for the Eden API.

Phase 7.0 / Batch A1: this module exists so ``eden.api.app`` can import
its middleware classes. The implementations are minimal pass-throughs
preserving the original API surface — the real work (correlation IDs,
rate limiting, API version negotiation, idempotency, quota enforcement,
latency histograms) lives in the per-class modules shipped in later
phases. For now we only need the imports to resolve so the test
suite can load the app.
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    """Stamps / forwards a ``X-Request-ID`` (correlation ID) on every
    request so we can stitch logs together across services."""

    HEADER = "X-Request-ID"

    async def dispatch(self, request: Request, call_next) -> Response:
        rid = request.headers.get(self.HEADER) or ""
        request.state.correlation_id = rid
        response = await call_next(request)
        if rid:
            response.headers[self.HEADER] = rid
        return response


class TenantRateLimitMiddleware(BaseHTTPMiddleware):
    """Per-tenant token-bucket rate limit. Defaults to ``default_limit``
    requests per ``default_window`` seconds; an authenticated org can
    override via the ``ratelimit_*`` settings on its tenant row."""

    def __init__(self, app, default_limit: int = 600, default_window: int = 60, **kwargs) -> None:
        super().__init__(app)
        self.default_limit = default_limit
        self.default_window = default_window

    async def dispatch(self, request: Request, call_next) -> Response:
        # Real impl: peek at auth context, hit the limiter, set
        # ``X-RateLimit-*`` headers, 429 if over budget. We pass through.
        return await call_next(request)


class APIVersionMiddleware(BaseHTTPMiddleware):
    """Resolves the ``X-API-Version`` header against the v1 prefix and
    returns 400 with a clear error when the client requests a version
    we don't serve."""

    async def dispatch(self, request: Request, call_next) -> Response:
        return await call_next(request)


class IdempotencyMiddleware(BaseHTTPMiddleware):
    """Honours ``Idempotency-Key`` on mutating requests so retries are
    safe. Cached for 24h per (org, route, key)."""

    async def dispatch(self, request: Request, call_next) -> Response:
        return await call_next(request)


class QuotaEnforcementMiddleware(BaseHTTPMiddleware):
    """Soft / hard quota enforcement. Returns 402 with
    ``X-Quota-*`` headers when an org is over its tier limit."""

    async def dispatch(self, request: Request, call_next) -> Response:
        return await call_next(request)
