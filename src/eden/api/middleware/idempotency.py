"""Idempotency key middleware for Eden Public API v1.

Ensures that mutating endpoints (POST, PUT, PATCH, DELETE) are safe to retry.
Clients send a unique ``Idempotency-Key`` header (UUID recommended).
If the same key + method + path + body + identity is seen within 24 hours,
the original response is replayed without side effects.

Storage backend:
- Redis: fast-path lookup (primary)
- PostgreSQL: durable fallback (if Redis is unavailable)

Non-mutating requests (GET, HEAD, OPTIONS) are ignored.
"""

import hashlib
import json
import logging
from datetime import UTC, datetime, timedelta

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from eden.api.middleware.correlation_id import get_correlation_id
from eden.config import get_settings
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)
settings = get_settings()

_IDEMPOTENCY_HEADER = "Idempotency-Key"
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


class IdempotencyMiddleware(BaseHTTPMiddleware):
    """Middleware that intercepts mutating requests and enforces idempotency keys.

    If a request has an ``Idempotency-Key`` header:
    - First occurrence: execute the request, cache the response for 24h.
    - Subsequent occurrence (same key + method + path + body + identity): return cached
      response with ``Idempotency-Replay: true`` header.

    If a mutating request is missing the header, a 400 error is returned.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        method = request.method.upper()

        # Only enforce idempotency on mutating methods under /v1/
        if method not in _MUTATING_METHODS or not request.url.path.startswith("/v1"):
            return await call_next(request)

        idempotency_key = request.headers.get(_IDEMPOTENCY_HEADER)
        if not idempotency_key:
            # Require idempotency key for all mutating v1 requests
            return JSONResponse(
                status_code=400,
                content={
                    "detail": f"Idempotency-Key header is required for {method} requests",
                    "hint": "Include a unique Idempotency-Key header (UUIDv4 recommended) to safely retry this request",
                },
            )

        # Sanitize key
        key_raw = idempotency_key.strip()
        if len(key_raw) > 256:
            key_raw = key_raw[:256]

        # Read request body to include in the composite key
        body_bytes = await request.body()
        body_hash = hashlib.sha256(body_bytes).hexdigest()

        identity = _get_request_identity(request)

        # Composite cache key: method + path + idempotency_key + body_hash + identity
        composite = f"{method}:{request.url.path}:{key_raw}:{body_hash}:{identity}"
        cache_key = f"eden:idempotency:{hashlib.sha256(composite.encode()).hexdigest()}"

        # Try fast-path Redis lookup
        cached = await self._lookup_redis(cache_key)
        if cached:
            return self._build_replay_response(cached)

        # Try durable Postgres fallback (also scoped by identity)
        cached = await self._lookup_postgres(key_raw, method, request.url.path, body_hash, identity)
        if cached:
            # Backfill Redis for next time
            await self._store_redis(cache_key, cached)
            return self._build_replay_response(cached)

        # No cache hit — proceed with request
        # Re-inject body so downstream handlers can still read it
        async def receive():
            return {"type": "http.request", "body": body_bytes, "more_body": False}

        request._receive = receive  # type: ignore[attr-defined]
        # Store body in state as a fallback for frameworks that don't honour _receive
        request.state.idempotency_body = body_bytes

        response = await call_next(request)

        # Cache the response for future replays
        await self._cache_response(cache_key, key_raw, method, request.url.path, body_hash, identity, response)

        return response

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

    async def _cache_response(self, cache_key: str, key: str, method: str, path: str, body_hash: str, identity: str, response: Response) -> None:
        # Only cache successful responses (2xx)
        if response.status_code < 200 or response.status_code >= 300:
            return

        # Read response body
        body = b""
        # body_iterator is an async iterator on Starlette Response subclasses
        try:
            async for chunk in response.body_iterator:
                body += chunk
        except Exception as exc:
            logger.warning(f"Could not read response body for idempotency caching: {exc}")
            return

        # Rebuild response so it can still be returned
        async def _replay():
            yield body

        response.body_iterator = _replay()

        # Try to parse body as JSON; fall back to storing raw string if not JSON
        try:
            body_json = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            body_json = {"raw_body": body.decode("utf-8", errors="replace")}

        payload = {
            "status_code": response.status_code,
            "body": body_json,
        }

        # Store in Redis
        await self._store_redis(cache_key, payload)

        # Store in Postgres as durable fallback
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
                response.status_code, json.dumps(payload["body"]), expires_at,
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
            headers={
                _IDEMPOTENCY_REPLAY_HEADER: "true",
                "X-Request-ID": get_correlation_id(),
            },
        )
