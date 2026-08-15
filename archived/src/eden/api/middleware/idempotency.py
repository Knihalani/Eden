"""Idempotency key middleware for Eden Public API v1.

Ensures that mutating endpoints (POST, PUT, PATCH, DELETE) are safe to retry.
Clients send a unique ``Idempotency-Key`` header (UUID recommended).
If the same key + method + path + body + identity is seen within 24 hours,
the original response is replayed without side effects.

Storage backend:
- Redis: fast-path lookup (primary)
- PostgreSQL: durable fallback (if Redis is unavailable)

Non-mutating requests (GET, HEAD, OPTIONS) are ignored.

Audit 2026-07-06 — converted from BaseHTTPMiddleware to pure ASGI.
The body is buffered ONLY when an ``Idempotency-Key`` is present on a
mutating ``/v1/`` request; without the key the request passes through
without reading the body.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime, timedelta

from fastapi import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from eden.api.middleware.correlation_id import get_correlation_id
from eden.api.middleware.security_headers import apply_security_headers
from eden.async_tasks import bounded_gather
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)

_IDEMPOTENCY_HEADER = "Idempotency-Key"
_IDEMPOTENCY_HEADER_BYTES = b"idempotency-key"
_IDEMPOTENCY_REPLAY_HEADER = "Idempotency-Replay"
_TTL_SECONDS = 86400  # 24 hours

# Mutating HTTP methods that idempotency applies to
_MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _get_request_identity(request: Request) -> str:
    """Extract an identity scope from the request for idempotency isolation.

    Prefers API key hash, then user cookie, then anonymous fallback.
    This prevents cross-user replay attacks.

    Audit 2026-07-02 B-7 — return the full 64-hex SHA-256, not
    the [:16] truncation (16 hex chars = 64 bits = brute-forceable
    in hours on commodity hardware; full digest = 256 bits).
    """
    api_key = request.headers.get("X-Org-Api-Key")
    if api_key:
        return hashlib.sha256(api_key.encode()).hexdigest()
    auth_cookie = request.cookies.get("authorization")
    if auth_cookie:
        return hashlib.sha256(auth_cookie.encode()).hexdigest()
    # Anonymous — still scoped by remote addr to limit blast radius
    return f"anon:{request.client.host if request.client else 'unknown'}"


def _header_value(scope: Scope, name_bytes: bytes) -> str | None:
    """Return a single header value from the ASGI scope (latin-1)."""
    for name, value in scope.get("headers") or ():
        if name == name_bytes:
            return value.decode("latin1")
    return None


async def _buffer_body(receive: Receive) -> bytes:
    """Drain the full request body from the ASGI receive channel."""
    body = b""
    while True:
        message = await receive()
        if message["type"] != "http.request":
            continue
        body += message.get("body", b"")
        if not message.get("more_body", False):
            break
    return body


class IdempotencyMiddleware:
    """Middleware that intercepts mutating requests and enforces idempotency keys.

    If a request has an ``Idempotency-Key`` header:
    - First occurrence: execute the request, cache the response for 24h.
    - Subsequent occurrence (same key + method + path + body + identity): return cached
      response with ``Idempotency-Replay: true`` header.

    If a mutating request is missing the header, the request proceeds
    unchanged (header is optional). Pass ``require_key=True`` to reject
    missing keys with 400 (used by F69 unit tests / strict tenants).

    Audit 2026-07-06 — pure ASGI ``__call__`` (no ``BaseHTTPMiddleware``).
    Body buffering happens only when the Idempotency-Key is present.
    """

    def __init__(self, app: ASGIApp, require_key: bool = False) -> None:
        self.app = app
        self.require_key = require_key

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = (scope.get("method") or "GET").upper()
        path = scope.get("path", "")

        # Only enforce idempotency on mutating methods under /v1/
        if method not in _MUTATING_METHODS or not path.startswith("/v1"):
            await self.app(scope, receive, send)
            return

        idempotency_key = _header_value(scope, _IDEMPOTENCY_HEADER_BYTES)
        if not idempotency_key:
            if self.require_key:
                response = JSONResponse(
                    status_code=400,
                    content={
                        "detail": f"Idempotency-Key header is required for {method} requests",
                        "hint": "Include a unique Idempotency-Key header (UUIDv4 recommended) to safely retry this request",
                    },
                    # F69 — apply OWASP security headers to the 400 envelope.
                    headers=apply_security_headers(),
                )
                await response(scope, receive, send)
                return
            # No key — pass through WITHOUT reading the body.
            await self.app(scope, receive, send)
            return

        # Sanitize key
        key_raw = idempotency_key.strip()
        if len(key_raw) > 256:
            key_raw = key_raw[:256]

        # Buffer body only when the Idempotency-Key is present.
        body_bytes = await _buffer_body(receive)
        body_hash = hashlib.sha256(body_bytes).hexdigest()

        # Request shim for identity helpers (cookies / headers / client).
        body_sent = False

        async def receive_replay() -> dict:
            nonlocal body_sent
            if not body_sent:
                body_sent = True
                return {"type": "http.request", "body": body_bytes, "more_body": False}
            return {"type": "http.request", "body": b"", "more_body": False}

        request = Request(scope, receive_replay)
        request.state.idempotency_body = body_bytes

        identity = _get_request_identity(request)

        # Composite cache key: method + path + idempotency_key + body_hash + identity
        composite = f"{method}:{path}:{key_raw}:{body_hash}:{identity}"
        cache_key = f"eden:idempotency:{hashlib.sha256(composite.encode()).hexdigest()}"

        # Try fast-path Redis lookup
        cached = await self._lookup_redis(cache_key)
        if cached:
            response = self._build_replay_response(cached)
            await response(scope, receive_replay, send)
            return

        # Try durable Postgres fallback (also scoped by identity)
        cached = await self._lookup_postgres(key_raw, method, path, body_hash, identity)
        if cached:
            # Backfill Redis for next time
            await self._store_redis(cache_key, cached)
            response = self._build_replay_response(cached)
            await response(scope, receive_replay, send)
            return

        # No cache hit — proceed with request; capture response for caching.
        captured: dict = {
            "status": None,
            "headers": [],
            "body": bytearray(),
            "more_body": False,
        }

        async def send_wrapper(message: dict) -> None:
            if message["type"] == "http.response.start":
                captured["status"] = message.get("status", 500)
                captured["headers"] = list(message.get("headers") or [])
                return
            if message["type"] == "http.response.body":
                captured["body"].extend(message.get("body", b""))
                if message.get("more_body", False):
                    captured["more_body"] = True
                    return
                # Final body chunk — cache then pass through start + body.
                status = captured["status"] or 500
                body = bytes(captured["body"])
                await self._cache_response(
                    cache_key, key_raw, method, path, body_hash, identity,
                    status, body,
                )
                await send({
                    "type": "http.response.start",
                    "status": status,
                    "headers": captured["headers"],
                })
                await send({
                    "type": "http.response.body",
                    "body": body,
                    "more_body": False,
                })
                return
            await send(message)

        await self.app(scope, receive_replay, send_wrapper)

    async def _lookup_redis(self, cache_key: str) -> dict | None:
        try:
            redis = await get_redis_client()
            if redis is None:
                return None
            raw = await redis.get(cache_key)
            if raw:
                return json.loads(raw)
        except Exception as exc:
            logger.warning(f"Redis idempotency lookup failed: {exc}")
        return None

    async def _lookup_postgres(self, key: str, method: str, path: str, body_hash: str, identity: str) -> dict | None:
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            row = await client.fetchrow(
                """
                SELECT response_status, response_body
                FROM idempotency_keys
                WHERE key_hash = $1
                  AND request_method = $2
                  AND request_path = $3
                  AND request_body_hash = $4
                  AND request_identity = $5
                  AND expires_at > NOW()
                """,
                key, method, path, body_hash, identity,
            )
            if row:
                return {
                    "status_code": row["response_status"],
                    "body": row["response_body"],
                }
        except Exception as exc:
            logger.warning(f"Postgres idempotency lookup failed: {exc}")
        return None

    async def _store_redis(self, cache_key: str, cached: dict) -> None:
        try:
            redis = await get_redis_client()
            if redis:
                await redis.set(cache_key, json.dumps(cached), ex=_TTL_SECONDS)
        except Exception as exc:
            logger.warning(f"Redis idempotency store failed: {exc}")

    async def _cache_response(
        self,
        cache_key: str,
        key: str,
        method: str,
        path: str,
        body_hash: str,
        identity: str,
        status_code: int,
        body: bytes,
    ) -> None:
        # Only cache successful responses (2xx)
        if status_code < 200 or status_code >= 300:
            return

        # Try to parse body as JSON; fall back to storing raw string if not JSON
        try:
            body_json = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            body_json = {"raw_body": body.decode("utf-8", errors="replace")}

        payload = {
            "status_code": status_code,
            "body": body_json,
        }

        # Redis + Postgres are independent durability layers —
        # store in parallel so a slow Postgres insert doesn't
        # serialize behind Redis (and vice versa).
        await bounded_gather(
            self._store_redis(cache_key, payload),
            self._store_postgres(
                key, method, path, body_hash, identity,
                status_code, payload,
            ),
            limit=2,
        )

    async def _store_postgres(
        self,
        key: str,
        method: str,
        path: str,
        body_hash: str,
        identity: str,
        status_code: int,
        payload: dict,
    ) -> None:
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            expires_at = datetime.now(UTC) + timedelta(seconds=_TTL_SECONDS)
            await client.execute(
                """
                INSERT INTO idempotency_keys (
                    key_hash, request_method, request_path, request_body_hash,
                    request_identity, response_status, response_body, expires_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (key_hash, request_method, request_path, request_body_hash, request_identity) DO UPDATE SET
                    response_status = EXCLUDED.response_status,
                    response_body = EXCLUDED.response_body,
                    expires_at = EXCLUDED.expires_at
                """,
                key, method, path, body_hash, identity,
                status_code, json.dumps(payload["body"]), expires_at,
            )
        except Exception as exc:
            logger.warning(f"Postgres idempotency cache failed: {exc}")

    @staticmethod
    def _build_replay_response(cached: dict) -> JSONResponse:
        """Build a response from cached idempotency data."""
        body = cached.get("body", {})
        status_code = cached.get("status_code", 200)
        return JSONResponse(
            status_code=status_code,
            content=body,
            # F69 — apply OWASP security headers to the replayed
            # response. The ``headers=`` argument merges: our
            # security block is added, the existing
            # ``_IDEMPOTENCY_REPLAY_HEADER`` + ``X-Request-ID`` are
            # preserved (apply_security_headers returns the union).
            headers=apply_security_headers(
                {
                    _IDEMPOTENCY_REPLAY_HEADER: "true",
                    "X-Request-ID": get_correlation_id(),
                }
            ),
        )
