"""Organization API Key management routes."""

import contextlib
import hashlib
import logging
import secrets
import time
from collections import deque
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status

from eden.api.deps import get_current_user, require_org_admin
from eden.storage.postgres import get_postgres_client
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/orgs/{org_id}/api-keys", tags=["api-keys"])

# Valid scopes for API keys
VALID_SCOPES = [
    "references:read",
    "references:write",
    "jobs:read",
    "jobs:write",
]

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
    stale = [
        k for k, b in _api_key_create_log.items()
        if not b or now - b[-1] >= window_sec
    ]
    for k in stale:
        _api_key_create_log.pop(k, None)
    # Hard cap on dict cardinality.
    if len(_api_key_create_log) >= _API_KEY_CREATE_DICT_CAP:
        for k in list(_api_key_create_log.keys())[
            : len(_api_key_create_log) - _API_KEY_CREATE_DICT_CAP + 1
        ]:
            _api_key_create_log.pop(k, None)
    bucket = _api_key_create_log.setdefault(
        (org_id, user_id), deque(maxlen=_API_KEY_CREATE_MAX),
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
                oldest = await redis.zrange(
                    redis_key, 0, 0, withscores=True
                )
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
                "apikey-create rate limit Redis path failed; "
                "falling back to in-memory: %s", exc,
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


@router.post("", response_model=dict)
async def create_api_key(
    org_id: str,
    name: str,
    scopes: list[str],
    user: dict = Depends(get_current_user),
):
    """Create a new API key for an organization.

    Returns the raw key once - it cannot be retrieved again.
    The user must save the raw key securely.
    """
    await require_org_admin(org_id)

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

    # Generate the raw key and its hash
    raw_key = generate_api_key()
    key_hash = hash_api_key(raw_key)
    key_prefix = get_key_prefix(raw_key)

    # Store the key metadata (NOT the raw key)
    key_id = str(uuid4())
    await client.execute(
        """
        INSERT INTO org_api_keys (id, org_id, name, key_hash, key_prefix, scopes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        """,
        key_id,
        org_id,
        name,
        key_hash,
        key_prefix,
        scopes,
        user["user_id"],
    )

    return {
        "id": key_id,
        "name": name,
        "key_prefix": key_prefix,
        "scopes": scopes,
        "raw_key": raw_key,  # Only returned once!
        "created_at": None,  # Will be filled by the client
    }


@router.get("", response_model=list[dict])
async def list_api_keys(
    org_id: str,
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = Query(
        None,
        description=(
            "Opaque pagination cursor from the ``X-Next-Cursor`` "
            "response header. Omit for the first page."
        ),
    ),
    response: Response = None,
    user: dict = Depends(get_current_user),
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
    await require_org_admin(org_id)

    client = await get_postgres_client()

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
                detail=(
                    "Invalid cursor; expected ``<created_at_iso>|<id>``."
                ),
            )

    if cursor_created_at is not None and cursor_id is not None:
        query = """
            SELECT id, name, key_prefix, scopes, created_by,
                   last_used_at, created_at
            FROM org_api_keys
            WHERE org_id = $1
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
        query = """
            SELECT id, name, key_prefix, scopes, created_by,
                   last_used_at, created_at
            FROM org_api_keys
            WHERE org_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT $2
        """
        rows = await client.fetch(query, org_id, limit + 1)

    has_more = len(rows) > limit
    page_rows = rows[:limit]

    items = [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "key_prefix": r["key_prefix"],
            "scopes": r["scopes"],
            "created_by": str(r["created_by"]),
            "last_used_at": r["last_used_at"].isoformat() if r.get("last_used_at") else None,
            "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
        }
        for r in page_rows
    ]

    if has_more and page_rows:
        last = page_rows[-1]
        response.headers["X-Next-Cursor"] = (
            f"{last['created_at'].isoformat()}|{last['id']}"
        )
    return items

    return [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "key_prefix": r["key_prefix"],
            "scopes": r["scopes"],
            "created_by": str(r["created_by"]),
            "last_used_at": r["last_used_at"].isoformat() if r.get("last_used_at") else None,
            "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
        }
        for r in rows
    ]


@router.delete("/{key_id}", response_model=dict)
async def revoke_api_key(
    org_id: str,
    key_id: str,
    user: dict = Depends(get_current_user),
):
    """Revoke (delete) an API key."""
    await require_org_admin(org_id)

    client = await get_postgres_client()

    # Verify the key belongs to this org
    key = await client.fetchrow(
        "SELECT id FROM org_api_keys WHERE id = $1 AND org_id = $2",
        key_id,
        org_id,
    )
    if not key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="API key not found",
        )

    await client.execute(
        "DELETE FROM org_api_keys WHERE id = $1",
        key_id,
    )

    return {"message": "API key revoked"}


async def validate_org_api_key(org_id: str, key: str) -> dict | None:
    """Validate an API key and return org context if valid.

    Returns None if key is invalid or doesn't match the org.
    Updates last_used_at timestamp (B-10 debounced to >60s).
    """
    client = await get_postgres_client()

    key_hash = hashlib.sha256(key.encode()).hexdigest()
    # B-10 (Session 24): also read ``last_used_at`` so we can skip
    # the UPDATE when the row was stamped < 60s ago. Pre-fix this
    # fired on every successful auth → ~3.6M UPDATEs/hour for a
    # single hot SDK key.
    query = """
        SELECT o.name, o.slug, o.owner_id, oak.org_id, oak.scopes, oak.id as key_id,
               oak.last_used_at
        FROM org_api_keys oak
        JOIN organizations o ON o.id = oak.org_id
        WHERE oak.key_hash = $1 AND oak.org_id = $2
    """
    row = await client.fetchrow(query, key_hash, org_id)
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
            logger.debug("last_used_at UPDATE failed (non-fatal): %s", exc)

    return {
        "org_id": str(row["org_id"]),
        "name": row["name"],
        "slug": row["slug"],
        "scopes": row["scopes"],
        "key_id": str(row["key_id"]),
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
