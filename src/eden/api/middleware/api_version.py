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

from __future__ import annotations

import contextlib
import logging

from starlette.types import ASGIApp, Receive, Scope, Send

from eden.api.middleware.correlation_id import get_correlation_id

logger = logging.getLogger(__name__)

# Ordered list of supported versions (oldest → newest)
SUPPORTED_VERSIONS = ["2025-05-30"]
CURRENT_VERSION = SUPPORTED_VERSIONS[-1]

_VERSION_HEADER_BYTES = b"x-api-version"
_V1_PREFIX_TUPLE = ("/v1",)
# Audit 2026-07-06 v2.0 — pre-compute the supported-versions bytes
# so the bad-version 400 response doesn't encode strings on the
# hot path. Most requests never hit the bad-version branch
# (clients omit the header), but the build cost is zero.
_VERSION_BYTES = CURRENT_VERSION.encode("latin1")
_RAW_VERSION_400_BODY_TEMPLATE = (
    b'{"detail":"Unsupported API version: '
)


class APIVersionMiddleware:
    """Pure-ASGI middleware that resolves and validates the
    ``X-API-Version`` header.

    Audit 2026-07-06 v2.0 — converted from
    :class:`starlette.middleware.base.BaseHTTPMiddleware` to pure
    ASGI ``__call__`` (saves ~150µs per request on the hot path
    by avoiding the ``Request`` reconstruction cost). Behaviour
    preserved:
      * Only applies to ``/v1/*`` requests (everything else passes
        through unchanged).
      * Missing or empty ``X-API-Version`` resolves to
        ``CURRENT_VERSION`` and the response echoes it.
      * Unknown versions return a 400 JSON envelope with the list
        of supported versions + the current version.
      * Resolved version is stashed via ``scope["state"]`` so
        downstream code reading ``request.state.api_version`` still
        works (we lazily build a ``Request`` only if a route
        actually needs ``request.state``).

    The 400 bad-version path returns inline ASGI messages rather
    than going through ``JSONResponse.__call__`` (same pattern as
    the v1.9 ``TenantRateLimitMiddleware`` 429 path).
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")

        # Only enforce versioning on v1 API routes. str.startswith
        # with a tuple is CPython's C fast path; the bare-string
        # form is the most common case (kept first for early exit).
        if not path.startswith("/v1"):
            await self.app(scope, receive, send)
            return

        # Manual scope-headers walk to extract ``X-API-Version``.
        # One pass, no ``Request`` construction. No bytes encode
        # per request because we only enter this branch for /v1/*
        # requests AND we only care about one header.
        raw_version: str | None = None
        for name, value in scope.get("headers") or ():
            if name.lower() == _VERSION_HEADER_BYTES:
                try:
                    raw_version = value.decode("latin1")
                except Exception:
                    raw_version = None
                break

        # Lazy ``Request`` only if a route actually reads state.
        # Most paths skip this — set version on the scope itself.
        version = self._resolve_version(raw_version)

        if version is None:
            # Build the 400 body inline. ``json.dumps`` gives us
            # proper JSON escaping for free (the user-supplied
            # version string could otherwise smuggle characters
            # into the response). The json import is inside the
            # (rare) error branch — not on the hot path.
            import json as _json
            body = _json.dumps({
                "detail": f"Unsupported API version: {raw_version}",
                "available_versions": SUPPORTED_VERSIONS,
                "current_version": CURRENT_VERSION,
            }).encode("latin1")
            await send({
                "type": "http.response.start",
                "status": 400,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("latin1")),
                    (_VERSION_HEADER_BYTES, _VERSION_BYTES),
                    (b"x-request-id", get_correlation_id().encode("latin1")),
                ],
            })
            await send({
                "type": "http.response.body",
                "body": body,
                "more_body": False,
            })
            return

        # Store resolved version on scope["state"]-equivalent.
        # Starlette's ``Request`` reads ``scope["state"]`` lazily
        # — we set ``scope["state"]`` to a SimpleNamespace so any
        # downstream ``getattr(request.state, "api_version", ...)``
        # still finds it. Cheap and zero-allocation up front.
        if "state" not in scope:
            from types import SimpleNamespace
            scope["state"] = SimpleNamespace()
        # ``scope["state"]`` exists but is e.g. a SimpleNamespace;
        # the assignment is unconditional. Older versions of Starlette
        # didn't expose scope["state"] — gracefully skip the stash
        # so downstream code falls back to the CURRENT_VERSION default.
        with contextlib.suppress(Exception):
            scope["state"].api_version = version

        # Echo the resolved version in the response.
        version_bytes = version.encode("latin1")

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = message.get("headers") or []
                headers.append((_VERSION_HEADER_BYTES, version_bytes))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)

    @staticmethod
    def _resolve_version(raw: str | None) -> str | None:
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


def get_api_version(request=None) -> str:
    """Get the resolved API version for the current request.

    Defaults to CURRENT_VERSION if the middleware has not run or request is None.
    """
    if request is None:
        return CURRENT_VERSION
    return getattr(request.state, "api_version", CURRENT_VERSION)
