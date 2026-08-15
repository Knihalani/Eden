"""Organization API Key management routes."""

import contextlib
import hashlib
import json
import logging
import secrets
import time
from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    status,
)
from pydantic import BaseModel, Field, field_validator, model_validator

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    log_audit_event,
    require_org_admin,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.storage.postgres import get_postgres_client
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/orgs/{org_id}/api-keys",
    tags=["api-keys"],
    dependencies=[Depends(require_path_org_access)],
)

# Valid scopes for API keys.
# Portal KeyScope aliases (ingest, traces:*, evals:run, datasets:read) are
# accepted alongside the existing SDK/gateway scopes.
VALID_SCOPES = [
    "references:read",
    "references:write",
    "jobs:read",
    "jobs:write",
    "ingest:read",
    "ingest:write",
    "ingest:*",
    "ingest",  # portal KeyScope alias
    "traces:write",  # portal KeyScope
    "traces:read",  # portal KeyScope
    "evals:run",  # portal KeyScope
    "datasets:read",  # portal KeyScope
    "gateway:read",
    "gateway:write",
    "gateway:*",
    "mcp:read",
    "mcp:debug",
    "mcp:fix",
    "mcp:*",
    "*",
]

# Portal ApiKeysTab SDK presets — used when body omits / empties scopes.
_DEFAULT_CREATE_SCOPES = [
    "references:read",
    "references:write",
    "jobs:read",
    "jobs:write",
    "ingest:write",
    "gateway:write",
]


class CreateApiKeyBody(BaseModel):
    """Create-key payload. Defaults match the portal SDK preset so an
    empty / partial body (proxy strip, omitted scopes) still succeeds
    instead of FastAPI 422 ``Field required`` / ``too_short``.
    """

    name: str = Field(default="SDK", min_length=2, max_length=100)
    scopes: list[str] = Field(default_factory=lambda: list(_DEFAULT_CREATE_SCOPES))

    @model_validator(mode="before")
    @classmethod
    def _coerce_partial(cls, data: Any) -> Any:
        if data is None:
            return {"name": "SDK", "scopes": list(_DEFAULT_CREATE_SCOPES)}
        if not isinstance(data, dict):
            return data
        out = dict(data)
        # Accept singular ``scope`` from older clients.
        if "scopes" not in out and "scope" in out:
            scope = out.pop("scope")
            out["scopes"] = scope if isinstance(scope, list) else [scope]
        scopes = out.get("scopes")
        if scopes is None or scopes == []:
            out["scopes"] = list(_DEFAULT_CREATE_SCOPES)
        name = out.get("name")
        if name is None or (isinstance(name, str) and len(name.strip()) < 2):
            out["name"] = "SDK"
        return out

    @field_validator("scopes")
    @classmethod
    def _scopes_nonempty(cls, v: list[str]) -> list[str]:
        if not v:
            return list(_DEFAULT_CREATE_SCOPES)
        return v


async def _parse_create_api_key_body(request: Request) -> CreateApiKeyBody:
    """Parse JSON body with empty-body tolerance.

    FastAPI ``Body(...)`` 422s on empty string / missing body before
    field defaults apply. The portal proxy occasionally forwards an
    empty body (middleware header rewrite / client race) — treat that
    as SDK defaults instead of ``invalid request``.
    """
    raw = await request.body()
    if not raw or not raw.strip():
        return CreateApiKeyBody()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid JSON body: {exc}",
        ) from exc
    if data is None:
        return CreateApiKeyBody()
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Request body must be a JSON object",
        )
    try:
        return CreateApiKeyBody.model_validate(data)
    except Exception as exc:
        # Surface a short string detail (portal maps array-shaped 422
        # detail to a generic "invalid request").
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc


# B-11 (Session 24): per-(org, user) sliding-window rate limit on
# ``POST /orgs/{org_id}/api-keys``. Audit 2026-07-03 — distributed
# via Redis sorted set when REDIS_URL is configured so multi-worker
# Northflank deploys share the counter (pre-fix each worker had its
# own in-process deque, multiplying the effective limit by N workers).
# Falls back to the in-memory deque when Redis is unavailable so
# single-node dev still works without infra.
_API_KEY_CREATE_MAX = 5
_API_KEY_CREATE_WINDOW = timedelta(hours=1)
_API_KEY_CREATE_WINDOW_SEC = int(_API_KEY_CREATE_WINDOW.total_seconds())
# Hard cap on dict cardinality for the in-memory fallback. Past the
# cap, idle (org,user) tuples are evicted on a sweep so a token
# farmer using random (org,user) pairs cannot exhaust worker memory.
# 50k entries ≈ a few MB at most — keeps memory bounded without a
# background thread.
_API_KEY_CREATE_DICT_CAP = 50_000
_api_key_create_log: dict[tuple[str, str], deque[float]] = {}


def _check_api_key_create_rate_limit_local(
    org_id: str,
    user_id: str,
) -> float | None:
    """In-memory fallback for ``_check_api_key_create_rate_limit``.

    Same algorithm as the B-11 patch but without Redis. Used when
    REDIS_URL is unset or the Redis client cannot connect — keeps
    single-node dev usable without a Redis dependency.
    """
    now = time.time()
    window_sec = _API_KEY_CREATE_WINDOW_SEC
    # Evict any bucket whose newest entry is outside the window.
    stale = [k for k, b in _api_key_create_log.items() if not b or now - b[-1] >= window_sec]
    for k in stale:
        _api_key_create_log.pop(k, None)
    # Hard cap on dict cardinality.
    if len(_api_key_create_log) >= _API_KEY_CREATE_DICT_CAP:
        for k in list(_api_key_create_log.keys())[
            : len(_api_key_create_log) - _API_KEY_CREATE_DICT_CAP + 1
        ]:
            _api_key_create_log.pop(k, None)
    bucket = _api_key_create_log.setdefault(
        (org_id, user_id),
        deque(maxlen=_API_KEY_CREATE_MAX),
    )
    while bucket and now - bucket[0] >= window_sec:
        bucket.popleft()
    if len(bucket) >= _API_KEY_CREATE_MAX:
        wait = window_sec - (now - bucket[0])
        return max(1.0, min(wait, float(window_sec)))
    bucket.append(now)
    return None


async def _check_api_key_create_rate_limit(
    org_id: str,
    user_id: str,
) -> float | None:
    """Return ``None`` if the (org, user) is allowed to create another
    API key this hour; otherwise return the number of seconds to wait
    before retrying (suitable as a ``Retry-After`` value).

    Audit 2026-07-03 — Redis-backed sliding window (ZSET) when
    REDIS_URL is configured so multi-worker deploys share the
    counter. In-memory deque fallback otherwise.
    """
    redis = None
    try:
        redis = await get_redis_client()
    except Exception:
        redis = None

    if redis is not None:
        try:
            now = time.time()
            window_start = now - _API_KEY_CREATE_WINDOW_SEC
            redis_key = f"apikey-create:{org_id}:{user_id}"
            # Atomic prune + count + add via pipeline. Members are
            # unique tokens so concurrent callers don't collide on
            # the same ZSET score.
            member = f"{now}:{secrets.token_hex(4)}"
            pipe = redis.pipeline()
            pipe.zremrangebyscore(redis_key, 0, window_start)
            pipe.zcard(redis_key)
            pipe.zadd(redis_key, {member: now})
            pipe.expire(redis_key, _API_KEY_CREATE_WINDOW_SEC + 1)
            results = await pipe.execute()
            count_after_add = int(results[1]) + 1
            if count_after_add > _API_KEY_CREATE_MAX:
                # Roll back the just-added entry so the next attempt
                # doesn't see a stale +1 we shouldn't have recorded.
                with contextlib.suppress(Exception):
                    await redis.zrem(redis_key, member)
                # Compute wait from the oldest surviving entry.
                oldest = await redis.zrange(redis_key, 0, 0, withscores=True)
                if oldest:
                    wait = max(
                        1.0,
                        min(
                            float(_API_KEY_CREATE_WINDOW_SEC),
                            (oldest[0][1] + _API_KEY_CREATE_WINDOW_SEC) - now,
                        ),
                    )
                    return wait
                return float(_API_KEY_CREATE_WINDOW_SEC)
            return None
        except Exception as exc:
            logger.warning(
                "apikey-create rate limit Redis path failed; " "falling back to in-memory: %s",
                redact_all(str(exc)),
            )

    return _check_api_key_create_rate_limit_local(org_id, user_id)


def generate_api_key() -> str:
    """Generate a secure random API key."""
    # Format: eden_api_key_<32 random bytes as hex>
    return f"eden_api_key_{secrets.token_hex(32)}"


def hash_api_key(key: str) -> str:
    """Hash an API key using SHA-256."""
    return hashlib.sha256(key.encode()).hexdigest()


def get_key_prefix(key: str) -> str:
    """Get the last 8 characters of a key for display."""
    return key[-8:]


@router.post(
    "",
    response_model=dict,
    openapi_extra={
        "requestBody": {
            "required": False,
            "content": {
                "application/json": {
                    "schema": CreateApiKeyBody.model_json_schema(
                        ref_template="#/components/schemas/{model}"
                    ),
                }
            },
        }
    },
)
async def create_api_key(
    request: Request,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Create a new API key for an organization.

    Returns the raw key once - it cannot be retrieved again.
    The user must save the raw key securely.

    Body is parsed manually (not via ``Body(...)``) so empty / partial
    JSON falls back to SDK defaults instead of FastAPI 422.
    """
    body = await _parse_create_api_key_body(request)
    return await create_api_key_from_body(
        org_id=org_id,
        body=body,
        user=user,
        payload=payload,
    )


async def create_api_key_from_body(
    *,
    org_id: str,
    body: CreateApiKeyBody,
    user: dict,
    payload: dict | None,
) -> dict:
    """Shared create path for HTTP + MCP key helpers."""
    # Must pass JWT payload — bare ``require_org_admin(org_id)`` leaves
    # FastAPI's Depends() sentinel and 500s on prod (AttributeError).
    await require_org_admin(org_id, payload)

    # B-11 (Session 24): per-(org, user) sliding window throttle.
    # Audit 2026-07-03 — now async (Redis-backed distributed counter).
    user_id = user.get("user_id")
    if user_id:
        wait = await _check_api_key_create_rate_limit(org_id, user_id)
        if wait is not None:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    f"API-key create rate limit exceeded for this "
                    f"organization (max {_API_KEY_CREATE_MAX}/hour). "
                    f"Retry after {int(wait)}s."
                ),
                headers={"Retry-After": str(int(wait))},
            )

    name = body.name.strip() or "SDK"
    scopes = list(body.scopes) or list(_DEFAULT_CREATE_SCOPES)

    # Validate name
    if not name or len(name) < 2 or len(name) > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Key name must be 2-100 characters",
        )

    # Validate scopes
    if not scopes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one scope is required",
        )

    invalid_scopes = [s for s in scopes if s not in VALID_SCOPES]
    if invalid_scopes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid scopes: {invalid_scopes}. Valid scopes: {VALID_SCOPES}",
        )

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to create API key",
            headers={"Retry-After": "5"},
        )

    # Persist canonical scopes. The portal's Settings → API Keys UI
    # offers a short vocabulary ("ingest", "traces:write", …) that
    # VALID_SCOPES accepts but that INGEST_SCOPES / GATEWAY_SCOPES in
    # deps.py do not contain — so keys minted there used to validate at
    # create time and then 403 on every ingest and gateway call.
    # Expanding here means newly-issued keys carry the canonical form;
    # api_key_has_scope also expands at check time so keys already in
    # the database keep working without a backfill.
    from eden.api.deps import expand_scope_aliases

    _expanded = expand_scope_aliases(scopes)
    # Order-preserving: keep what the caller asked for first, then append
    # the canonical scopes their aliases implied.
    scopes = list(scopes) + sorted(_expanded - set(scopes))

    # Generate the raw key and its hash
    raw_key = generate_api_key()
    key_hash = hash_api_key(raw_key)
    key_prefix = get_key_prefix(raw_key)

    # Store the key metadata (NOT the raw key)
    key_id = str(uuid4())
    try:
        await client.execute(
            """
            INSERT INTO org_api_keys (id, org_id, name, key_hash, key_prefix, scopes, created_by)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7)
            """,
            key_id,
            org_id,
            name,
            key_hash,
            key_prefix,
            scopes,
            str(user["user_id"]),
        )
    except Exception as exc:
        msg = str(exc).lower()
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="API key already exists",
            ) from exc
        if "invalid input syntax for type uuid" in msg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid organization or user id",
            ) from exc
        if "foreign key" in msg:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Organization or user not found",
            ) from exc
        logger.warning("create_api_key INSERT failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to create API key",
        ) from exc

    # N06 / Wave 1 — key lifecycle audit
    try:
        await log_audit_event(
            client,
            org_id=org_id,
            user_id=user["user_id"],
            action="api_key.create",
            target_type="org_api_key",
            target_id=key_id,
            metadata={"name": name, "scopes": scopes, "key_prefix": key_prefix},
        )
    except Exception as exc:
        logger.debug("api_key.create audit write failed (non-fatal): %s", redact_all(str(exc)))

    return {
        "id": key_id,
        "name": name,
        "key_prefix": key_prefix,
        "scopes": scopes,
        "raw_key": raw_key,  # Only returned once!
        "created_at": datetime.now(UTC).isoformat(),
    }


@router.get("", response_model=list[dict])
async def list_api_keys(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = Query(
        None,
        description="Opaque pagination cursor from the ``X-Next-Cursor`` response header. Omit for the first page.",
    ),
    response: Response = None,  # FastAPI injects Response regardless of default
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """List all API keys for an organization (without raw keys).

    Audit 2026-07-03 — bounded pagination. Pre-fix a compromised
    admin token could pull the entire ``org_api_keys`` table for
    any org in one request. Cap is 200 keys per page (the realistic
    organisation rarely carries more than a dozen); cursor on
    ``(created_at, id)`` keeps order stable across writes. The
    response body remains a list (no shape drift for existing
    clients); pagination state is conveyed via the ``X-Next-Cursor``
    header.
    """
    # B-12 (Session 24): admin/owner only. Pre-fix any org member
    # could enumerate key prefixes — enough to fingerprint the
    # stack + craft targeted social-engineering follow-ups.
    await require_org_admin(org_id, payload)

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="API keys temporarily unavailable",
            headers={"Retry-After": "5"},
        )

    # Cursor format: ``"<created_at_iso>|<id>"`` — opaque to clients,
    # lexicographically ordered on the same axis as ``ORDER BY``.
    cursor_created_at: datetime | None = None
    cursor_id: str | None = None
    if cursor:
        try:
            ts_part, id_part = cursor.split("|", 1)
            cursor_created_at = datetime.fromisoformat(ts_part)
            cursor_id = id_part
        except (ValueError, AttributeError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=("Invalid cursor; expected ``<created_at_iso>|<id>``."),
            ) from None

    # Soft-revoke filter + text org compare (non-UUID org ids → clean miss).
    active_clause = "AND (active IS TRUE OR active IS NULL) " "AND revoked_at IS NULL"
    try:
        if cursor_created_at is not None and cursor_id is not None:
            query = f"""
                SELECT id, name, key_prefix, scopes, created_by,
                       last_used_at, created_at
                FROM org_api_keys
                WHERE org_id::text = $1
                  {active_clause}
                  AND (created_at, id) < ($2, $3)
                ORDER BY created_at DESC, id DESC
                LIMIT $4
            """
            rows = await client.fetch(
                query,
                org_id,
                cursor_created_at,
                cursor_id,
                limit + 1,  # +1 to detect "has next page"
            )
        else:
            query = f"""
                SELECT id, name, key_prefix, scopes, created_by,
                       last_used_at, created_at
                FROM org_api_keys
                WHERE org_id::text = $1
                  {active_clause}
                ORDER BY created_at DESC, id DESC
                LIMIT $2
            """
            rows = await client.fetch(query, org_id, limit + 1)
    except Exception as exc:
        msg = str(exc).lower()
        if "does not exist" in msg or "undefinedcolumn" in msg:
            logger.error(
                "list_api_keys: schema mismatch (missing column?): %s",
                redact_all(str(exc)),
            )
        else:
            logger.warning("list_api_keys: query failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="API keys temporarily unavailable",
            headers={"Retry-After": "5"},
        ) from exc

    has_more = len(rows) > limit
    page_rows = rows[:limit]

    items = [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "key_prefix": r["key_prefix"],
            "scopes": list(r["scopes"] or []),
            "created_by": str(r["created_by"]) if r.get("created_by") else None,
            "last_used_at": r["last_used_at"].isoformat() if r.get("last_used_at") else None,
            "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
        }
        for r in page_rows
    ]

    if has_more and page_rows and response is not None:
        last = page_rows[-1]
        response.headers["X-Next-Cursor"] = f"{last['created_at'].isoformat()}|{last['id']}"
    return items


@router.delete("/{key_id}", response_model=dict)
async def revoke_api_key(
    org_id: str = Depends(require_path_org_access),
    key_id: str = Path(...),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Revoke (soft-delete) an API key."""
    await require_org_admin(org_id, payload)

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="API keys temporarily unavailable",
            headers={"Retry-After": "5"},
        )

    # Verify the key belongs to this org and is still active
    key = await client.fetchrow(
        """
        SELECT id, key_hash FROM org_api_keys
        WHERE id::text = $1 AND org_id::text = $2
          AND (active IS TRUE OR active IS NULL)
          AND revoked_at IS NULL
        """,
        key_id,
        org_id,
    )
    if not key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="API key not found",
        )

    await client.execute(
        """
        UPDATE org_api_keys
        SET active = FALSE, revoked_at = NOW()
        WHERE id = $1
        """,
        key["id"],
    )

    # Auth caches the validated key context for up to 60s. Drop it here so
    # revocation is immediate on this pod; other pods age out via the TTL.
    from eden.api.deps import invalidate_api_key_cache

    invalidate_api_key_cache(key.get("key_hash"))

    try:
        await log_audit_event(
            client,
            org_id=org_id,
            user_id=user["user_id"],
            action="api_key.revoke",
            target_type="org_api_key",
            target_id=key_id,
            metadata={},
        )
    except Exception as exc:
        logger.debug("api_key.revoke audit write failed (non-fatal): %s", redact_all(str(exc)))

    return {"message": "API key revoked"}


async def validate_org_api_key(org_id: str, key: str) -> dict | None:
    """Validate an API key and return org context if valid.

    Returns None if key is invalid or doesn't match the org.
    Updates last_used_at timestamp (B-10 debounced to >60s).

    Lookup errors (non-UUID org id, DB blip) return None so callers
    surface HTTP 401 — never an unhandled 500.
    """
    if not key or not org_id:
        return None
    try:
        key_hash = hashlib.sha256(key.encode("utf-8")).hexdigest()
    except (AttributeError, TypeError, UnicodeError):
        return None

    # B-10 (Session 24): also read ``last_used_at`` so we can skip
    # the UPDATE when the row was stamped < 60s ago. Pre-fix this
    # fired on every successful auth → ~3.6M UPDATEs/hour for a
    # single hot SDK key.
    query = """
        SELECT o.name, o.slug, o.owner_id, oak.org_id, oak.scopes, oak.id as key_id,
               oak.last_used_at
        FROM org_api_keys oak
        JOIN organizations o ON o.id = oak.org_id
        WHERE oak.key_hash = $1 AND oak.org_id::text = $2
          -- Revoked, disabled and expired keys were all still accepted
          -- here. revoke_api_key only sets active=FALSE + revoked_at, so
          -- a revoked key kept validating; all three columns exist and
          -- the sibling deps.get_current_org_api_key checks every one.
          --
          -- Latent rather than live: the only consumer is
          -- mcp_server/verify.py, behind mcp_http_transport_v1 which
          -- defaults False. It becomes an auth bypass the moment that
          -- flag is turned on, which is exactly when nobody would be
          -- looking for it.
          AND (oak.active IS TRUE OR oak.active IS NULL)
          AND oak.revoked_at IS NULL
          AND (oak.expires_at IS NULL OR oak.expires_at > NOW())
    """
    try:
        client = await get_postgres_client()
        if client is None:
            return None
        row = await client.fetchrow(query, key_hash, org_id)
    except Exception as exc:
        logger.warning(
            "validate_org_api_key: lookup failed for org=%s: %s",
            org_id,
            redact_all(str(exc)),
        )
        return None
    if not row:
        return None

    # B-10 (Session 24): debounce the ``last_used_at`` UPDATE to one
    # write per 60s per key. Hot SDK keys otherwise hammer Postgres
    # with a write per request — pointless work since the column's
    # only consumer is the keys-list UI which rounds to minutes.
    last_used = row.get("last_used_at")
    if last_used is None:
        should_stamp = True
    else:
        # asyncpg may return naive datetimes depending on the server's
        # TimeZone setting; treat them as UTC for the comparison.
        cmp = last_used if last_used.tzinfo else last_used.replace(tzinfo=UTC)
        should_stamp = (datetime.now(UTC) - cmp) >= timedelta(seconds=60)
    if should_stamp:
        # B-10 (Session 24) + audit 2026-07-03 — combine the
        # debounce check and the UPDATE into a single statement
        # so two concurrent auths on the same key cannot race
        # past the 60 s window. The conditional UPDATE writes
        # only when ``last_used_at`` is NULL or stale; the row
        # count is intentionally ignored (an idempotent no-op
        # stamp is correct behaviour).
        try:
            await client.execute(
                """
                UPDATE org_api_keys
                SET last_used_at = NOW()
                WHERE id = $1
                  AND (
                    last_used_at IS NULL
                    OR last_used_at < NOW() - INTERVAL '60 seconds'
                  )
                """,
                row["key_id"],
            )
        except Exception as exc:
            logger.debug("last_used_at UPDATE failed (non-fatal): %s", redact_all(str(exc)))

    key_id = str(row["key_id"])
    return {
        "org_id": str(row["org_id"]),
        "name": row["name"],
        "slug": row["slug"],
        "scopes": row["scopes"],
        "key_id": key_id,
        "api_key_id": key_id,
        "auth_method": "api_key",
    }


# Dependency for routes that accept API key auth
async def get_current_org_api_key(
    x_org_id: str = Header(..., alias="X-Org-Id"),
    x_org_api_key: str | None = Header(None, alias="X-Org-Api-Key"),
):
    """Validate X-Org-Api-Key header and return org context.

    This is an alternative to cookie-based auth for programmatic access.
    """
    if not x_org_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Org-Api-Key header required",
        )

    org_context = await validate_org_api_key(x_org_id, x_org_api_key)
    if not org_context:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )

    return org_context
