"""API versioning middleware for Eden Public API.

Supports date-based versioning via the ``X-API-Version`` header.
Versions are immutable snapshots of the API contract, identified by
ISO date (e.g., ``2025-05-30``).

Behaviour:
- If ``X-API-Version`` is absent, the current (latest) version is used.
- If an unsupported version is requested, a 400 error is returned with
  a list of available versions.
- The resolved version is stored in ``request.state.api_version`` and
  echoed in response headers.

Version history:
  2025-05-30 — Initial Public API v1 release.
"""

import logging
from typing import Optional

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from eden.api.middleware.correlation_id import get_correlation_id

logger = logging.getLogger(__name__)

# Ordered list of supported versions (oldest → newest)
SUPPORTED_VERSIONS = ["2025-05-30"]
CURRENT_VERSION = SUPPORTED_VERSIONS[-1]

_VERSION_HEADER = "X-API-Version"


class APIVersionMiddleware(BaseHTTPMiddleware):
    """Middleware that resolves and validates API version headers.

    Only applies to routes under /v1/. Other routes are passed through
    unchanged.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path

        # Only enforce versioning on v1 API routes
        if not path.startswith("/v1"):
            return await call_next(request)

        raw_version = request.headers.get(_VERSION_HEADER)
        version = self._resolve_version(raw_version)

        if version is None:
            return JSONResponse(
                status_code=400,
                content={
                    "detail": f"Unsupported API version: {raw_version}",
                    "available_versions": SUPPORTED_VERSIONS,
                    "current_version": CURRENT_VERSION,
                },
                headers={
                    "X-API-Version": CURRENT_VERSION,
                    "X-Request-ID": get_correlation_id(),
                },
            )

        # Store resolved version on request state for downstream use
        request.state.api_version = version

        response = await call_next(request)

        # Echo the resolved version in response headers
        response.headers[_VERSION_HEADER] = version
        return response

    @staticmethod
    def _resolve_version(raw: Optional[str]) -> Optional[str]:
        """Resolve a version string to a supported version.

        Returns the version if supported, None otherwise.
        If raw is None, returns the current version.
        """
        if raw is None or raw.strip() == "":
            return CURRENT_VERSION

        cleaned = raw.strip()
        if cleaned in SUPPORTED_VERSIONS:
            return cleaned
        return None


def get_api_version(request: Optional[Request] = None) -> str:
    """Get the resolved API version for the current request.

    Defaults to CURRENT_VERSION if the middleware has not run or request is None.
    """
    if request is None:
        return CURRENT_VERSION
    return getattr(request.state, "api_version", CURRENT_VERSION)
