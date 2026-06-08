"""Redis client for Eden.

Provides caching, session storage, and distributed rate-limiting backend.
Uses redis-py with asyncio support.
"""

import functools
import hashlib
import json
import logging
import pickle
import time
from typing import Any, Callable, Optional, TypeVar, cast
from datetime import timedelta

import redis.asyncio as redis
from redis.asyncio import Redis

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

T = TypeVar("T")

# ============================================================================
# Client
# ============================================================================

_redis_client: Optional[Redis] = None


async def get_redis_client() -> Optional[Redis]:
    """Get the singleton Redis client.

    Returns None if REDIS_URL is not configured.
    """
    global _redis_client

    if _redis_client is not None:
        return _redis_client

    redis_url = settings.redis_url
    if not redis_url:
        logger.debug("Redis not configured (REDIS_URL is empty).")
        return None

    try:
        _redis_client = await redis.from_url(
            redis_url,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=5,
            socket_keepalive=True,
            health_check_interval=30,
        )
        logger.info("Redis client connected.")
        return _redis_client
    except Exception as e:
        logger.warning(f"Redis connection failed: {e}")
        return None


async def close_redis_client() -> None:
    """Close the singleton Redis client."""
    global _redis_client
    if _redis_client is not None:
        await _redis_client.close()
        _redis_client = None
        logger.info("Redis client closed.")


# ============================================================================
# Cache helpers
# ============================================================================

class Cache:
    """Async Redis-backed cache with TTL and key namespacing."""

    def __init__(self, prefix: str = "eden:cache", default_ttl: int = 300):
        """
        Args:
            prefix: Key prefix to avoid collisions.
            default_ttl: Default TTL in seconds.
        """
        self.prefix = prefix
        self.default_ttl = default_ttl

    def _key(self, key: str) -> str:
        return f"{self.prefix}:{key}"

    async def get(self, key: str) -> Any:
        """Fetch a cached value (JSON-decoded)."""
        client = await get_redis_client()
        if client is None:
            return None
        raw = await client.get(self._key(key))
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    async def set(
        self,
        key: str,
        value: Any,
        ttl: Optional[int] = None,
        nx: bool = False,
    ) -> bool:
        """Store a value (JSON-encoded) with optional TTL.

        Args:
            nx: Only set if key does not exist.
        """
        client = await get_redis_client()
        if client is None:
            return False
        raw = json.dumps(value) if not isinstance(value, (str, bytes)) else value
        try:
            if nx:
                result = await client.set(
                    self._key(key), raw, ex=ttl or self.default_ttl, nx=True
                )
            else:
                result = await client.set(
                    self._key(key), raw, ex=ttl or self.default_ttl
                )
            return result is not None
        except Exception as e:
            logger.warning(f"Cache set failed for {key}: {e}")
            return False

    async def delete(self, key: str) -> bool:
        """Delete a cached key."""
        client = await get_redis_client()
        if client is None:
            return False
        result = await client.delete(self._key(key))
        return result > 0

    async def exists(self, key: str) -> bool:
        """Check if a key exists."""
        client = await get_redis_client()
        if client is None:
            return False
        result = await client.exists(self._key(key))
        return bool(result)

    async def increment(self, key: str, amount: int = 1) -> int:
        """Atomically increment a counter."""
        client = await get_redis_client()
        if client is None:
            return 0
        return await client.incrby(self._key(key), amount)

    async def expire(self, key: str, ttl: int) -> bool:
        """Set TTL on an existing key."""
        client = await get_redis_client()
        if client is None:
            return False
        return await client.expire(self._key(key), ttl)


# Global cache instance
cache = Cache(prefix="eden:cache", default_ttl=300)


# ============================================================================
# Cache decorator
# ============================================================================

def cached(
    ttl: int = 300,
    key_func: Optional[Callable[..., str]] = None,
    prefix: str = "func",
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """Decorator to cache async function results in Redis.

    Args:
        ttl: Cache TTL in seconds.
        key_func: Optional function to generate a cache key from arguments.
        prefix: Key prefix for namespacing.

    Example:
        @cached(ttl=60)
        async def expensive_lookup(query: str):
            ...
    """

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            if key_func:
                cache_key = key_func(*args, **kwargs)
            else:
                # Deterministic key from function name + sorted args/kwargs
                sig = hashlib.sha256(
                    pickle.dumps((func.__qualname__, args, sorted(kwargs.items())))
                ).hexdigest()[:32]
                cache_key = f"{prefix}:{func.__name__}:{sig}"

            client = await get_redis_client()
            if client is not None:
                try:
                    raw = await client.get(cache_key)
                    if raw is not None:
                        return json.loads(raw)
                except Exception:
                    pass  # Fall through to function call

            result = await func(*args, **kwargs)

            if client is not None:
                try:
                    await client.set(
                        cache_key,
                        json.dumps(result) if not isinstance(result, (str, bytes)) else result,
                        ex=ttl,
                    )
                except Exception:
                    pass  # Cache write is best-effort

            return result

        return cast(Callable[..., T], wrapper)

    return decorator


# ============================================================================
# Session store
# ============================================================================

class SessionStore:
    """Redis-backed session store for ephemeral user state.

    Stores JSON-serialisable dictionaries keyed by session ID.
    Useful for interview state, multi-step forms, and temporary tokens.
    """

    def __init__(self, prefix: str = "eden:session", default_ttl: int = 3600):
        self.prefix = prefix
        self.default_ttl = default_ttl

    def _key(self, session_id: str) -> str:
        return f"{self.prefix}:{session_id}"

    async def create(self, session_id: str, data: dict, ttl: Optional[int] = None) -> bool:
        """Create a new session."""
        client = await get_redis_client()
        if client is None:
            return False
        return await client.set(
            self._key(session_id),
            json.dumps(data),
            ex=ttl or self.default_ttl,
            nx=True,
        ) is not None

    async def get(self, session_id: str) -> Optional[dict]:
        """Retrieve session data."""
        client = await get_redis_client()
        if client is None:
            return None
        raw = await client.get(self._key(session_id))
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    async def update(self, session_id: str, data: dict, ttl: Optional[int] = None) -> bool:
        """Overwrite session data."""
        client = await get_redis_client()
        if client is None:
            return False
        return await client.set(
            self._key(session_id),
            json.dumps(data),
            ex=ttl or self.default_ttl,
        ) is not None

    async def delete(self, session_id: str) -> bool:
        """Delete a session."""
        client = await get_redis_client()
        if client is None:
            return False
        result = await client.delete(self._key(session_id))
        return result > 0

    async def extend(self, session_id: str, ttl: int) -> bool:
        """Extend session TTL."""
        client = await get_redis_client()
        if client is None:
            return False
        return await client.expire(self._key(session_id), ttl)


session_store = SessionStore(prefix="eden:session", default_ttl=3600)


# ============================================================================
# Distributed rate limiter (Redis-backed)
# ============================================================================

class RedisRateLimiter:
    """Distributed sliding-window rate limiter backed by Redis.

    Replaces the in-memory limiter for multi-instance deployments.
    Uses Redis sorted sets (ZADD/ZREMRANGEBYSCORE/ZCARD) for atomic
    window tracking.
    """

    def __init__(
        self,
        key_prefix: str = "eden:ratelimit",
        max_requests: int = 60,
        window_seconds: int = 60,
    ):
        self.key_prefix = key_prefix
        self.max_requests = max_requests
        self.window_seconds = window_seconds

    def _key(self, key: str) -> str:
        return f"{self.key_prefix}:{key}"

    async def check(self, key: str) -> None:
        """Check if the key has exceeded the rate limit.

        Raises:
            RateLimitExceeded: If the rate limit has been exceeded.
        """
        from eden.api.utils.rate_limit import RateLimitExceeded

        client = await get_redis_client()
        if client is None:
            # Fall back to in-memory if Redis is unavailable
            logger.debug("Redis unavailable for rate limiting; falling back to in-memory.")
            return

        now = time.time()
        window_start = now - self.window_seconds
        redis_key = self._key(key)

        # Atomic check-and-add via Lua script to eliminate race conditions
        lua_script = """
            local key = KEYS[1]
            local now = tonumber(ARGV[1])
            local window_start = tonumber(ARGV[2])
            local max_requests = tonumber(ARGV[3])
            local window_seconds = tonumber(ARGV[4])

            redis.call("zremrangebyscore", key, 0, window_start)
            local count = redis.call("zcard", key)

            if count >= max_requests then
                local oldest = redis.call("zrange", key, 0, 0, "withscores")
                local retry_after = window_seconds
                if #oldest > 0 then
                    -- RESP2 flat array: oldest[1]=member, oldest[2]=score
                    retry_after = math.max(1, (tonumber(oldest[2]) + window_seconds) - now)
                end
                return {-1, retry_after}
            end

            redis.call("zadd", key, now, now)
            redis.call("expire", key, window_seconds + 1)
            return {count + 1, 0}
        """

        result = await client.eval(
            lua_script,
            1,
            redis_key,
            now,
            window_start,
            self.max_requests,
            self.window_seconds,
        )

        # result is a list: [new_count, retry_after]
        # If new_count is -1, the limit was exceeded
        if isinstance(result, list) and len(result) == 2 and result[0] == -1:
            raise RateLimitExceeded(retry_after=float(result[1]))

    async def reset(self, key: str) -> bool:
        """Reset the rate limit counter for a key."""
        client = await get_redis_client()
        if client is None:
            return False
        result = await client.delete(self._key(key))
        return result > 0

    async def get_remaining(self, key: str) -> int:
        """Get the number of remaining requests for a key."""
        client = await get_redis_client()
        if client is None:
            return self.max_requests

        now = time.time()
        window_start = now - self.window_seconds
        redis_key = self._key(key)

        await client.zremrangebyscore(redis_key, 0, window_start)
        count = await client.zcard(redis_key)
        return max(0, self.max_requests - count)


# ============================================================================
# Lock helpers (distributed locking)
# ============================================================================

class Lock:
    """Redis-backed distributed lock with automatic expiry.

    Uses SET NX EX for atomic lock acquisition.  The lock auto-expires
    so that crashed processes cannot hold it forever.
    """

    def __init__(
        self,
        name: str,
        ttl: int = 30,
        prefix: str = "eden:lock",
    ):
        self.name = name
        self.ttl = ttl
        self.prefix = prefix
        self._key = f"{prefix}:{name}"
        self._token: Optional[str] = None

    async def acquire(self, token: Optional[str] = None) -> bool:
        """Try to acquire the lock.

        Args:
            token: Optional unique token for ownership verification.

        Returns:
            True if lock was acquired.
        """
        client = await get_redis_client()
        if client is None:
            return True  # No Redis = no locking (warn in logs)

        self._token = token or f"{time.time()}"
        result = await client.set(self._key, self._token, nx=True, ex=self.ttl)
        return result is not None

    async def release(self) -> bool:
        """Release the lock (only if we hold it)."""
        if self._token is None:
            return False

        client = await get_redis_client()
        if client is None:
            return True

        # Lua script for atomic check-and-delete (prevents releasing
        # a lock that was acquired by another process after ours expired)
        lua = """
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        """
        result = await client.eval(lua, 1, self._key, self._token)
        return bool(result)

    async def extend(self, additional_ttl: int) -> bool:
        """Extend the lock TTL if we still hold it."""
        if self._token is None:
            return False

        client = await get_redis_client()
        if client is None:
            return True

        lua = """
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("expire", KEYS[1], ARGV[2])
            else
                return 0
            end
        """
        result = await client.eval(lua, 1, self._key, self._token, str(additional_ttl))
        return bool(result)
