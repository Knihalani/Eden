"""Postgres-backed leader lease — a second election backend.

Every background loop in Eden elects through a Redis lock. On 2026-07-29
that turned out to be a single point of total failure: the Upstash free
tier's monthly request cap was reached ("max requests limit exceeded.
Limit: 500000, Usage: 500000"), and past that limit Upstash *serves reads
and silently discards writes*. ``SET NX`` returned null, so every lock
read as "refused" while nothing held it, no loop could start, and the
entire annotate/evaluate/improve half of the product was down for 7.4
days while ``PING`` kept succeeding.

Postgres was healthy throughout. This module provides the same
mutual-exclusion semantics on top of it so a provider quota, an outage, or
a misconfiguration on one datastore cannot take the whole fleet down.

Semantics match ``eden.storage.redis.Lock``:

* ``acquire`` is atomic and returns False when someone else holds a live
  lease (single ``INSERT … ON CONFLICT … WHERE`` — no read-then-write
  race).
* Leases carry a TTL, so a crashed holder releases automatically instead
  of blocking failover forever.
* ``renew`` extends only your own lease; ``release`` deletes only your
  own. Both key on the holder token, so a process that lost its lease can
  never stomp the new owner.

Cost: one statement per acquire/renew. This is the fallback path, so in
the normal case it costs nothing at all.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_TABLE = "eden_leader_leases"

#: Created on first use. The alembic migration is authoritative; this
#: exists so the fallback works even on a database that predates it —
#: which is precisely the situation where you need a fallback.
_CREATE_SQL = f"""
CREATE TABLE IF NOT EXISTS {_TABLE} (
    lock_name  TEXT PRIMARY KEY,
    holder     TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
)
"""

_ensured = False


async def _client() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception as exc:
        logger.debug("pg_lease: no postgres client: %s", exc)
        return None


async def _ensure_table(client: Any) -> bool:
    """Create the table once per process. Idempotent and cheap."""
    global _ensured
    if _ensured:
        return True
    try:
        await client.execute(_CREATE_SQL)
        _ensured = True
        return True
    except Exception as exc:
        logger.warning("pg_lease: table ensure failed: %s", exc)
        return False


async def acquire(lock_name: str, holder: str, ttl_seconds: int) -> bool | None:
    """Take ``lock_name`` for ``holder`` if free or expired.

    One atomic statement: the ``WHERE`` on the conflict target means a
    live lease held by someone else simply does not update, and
    ``RETURNING`` tells us who owns it now.

    Returns:
        True  — we hold the lease.
        False — another process holds a live lease (genuine contention).
        None  — Postgres is unavailable (no client, table ensure failed,
                or the statement raised); callers should fall back to an
                alternative backend rather than treating this as contention.
    """
    client = await _client()
    if client is None or not await _ensure_table(client):
        return None
    try:
        row = await client.fetchrow(
            f"""
            INSERT INTO {_TABLE} (lock_name, holder, expires_at)
            VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval)
            ON CONFLICT (lock_name) DO UPDATE
               SET holder = EXCLUDED.holder,
                   expires_at = EXCLUDED.expires_at
             WHERE {_TABLE}.expires_at < NOW()
                OR {_TABLE}.holder = EXCLUDED.holder
            RETURNING holder
            """,
            lock_name,
            holder,
            str(int(ttl_seconds)),
        )
    except Exception as exc:
        logger.warning("pg_lease: acquire %s failed: %s", lock_name, exc)
        return None
    # Defensive: a row without the expected column means "not leader",
    # never an exception. The DB responded, so treat this as a refusal
    # (False) rather than unavailability (None) to avoid promoting an
    # unexpected schema state into "try another backend".
    try:
        return bool(row is not None and row["holder"] == holder)
    except (KeyError, IndexError, TypeError):
        logger.warning("pg_lease: acquire %s returned an unexpected row", lock_name)
        return False


async def renew(lock_name: str, holder: str, ttl_seconds: int) -> bool:
    """Extend our own lease. False means we no longer hold it."""
    client = await _client()
    if client is None:
        return False
    try:
        row = await client.fetchrow(
            f"""
            UPDATE {_TABLE}
               SET expires_at = NOW() + ($3 || ' seconds')::interval
             WHERE lock_name = $1 AND holder = $2
            RETURNING holder
            """,
            lock_name,
            holder,
            str(int(ttl_seconds)),
        )
    except Exception as exc:
        logger.warning("pg_lease: renew %s failed: %s", lock_name, exc)
        return False
    return row is not None


async def release(lock_name: str, holder: str) -> bool:
    """Drop our own lease. Never removes someone else's."""
    client = await _client()
    if client is None:
        return False
    try:
        await client.execute(
            f"DELETE FROM {_TABLE} WHERE lock_name = $1 AND holder = $2",
            lock_name,
            holder,
        )
        return True
    except Exception as exc:
        logger.warning("pg_lease: release %s failed: %s", lock_name, exc)
        return False


async def current_holder(lock_name: str) -> str | None:
    """Who holds a live lease on ``lock_name``, if anyone."""
    client = await _client()
    if client is None:
        return None
    try:
        return await client.fetchval(
            f"SELECT holder FROM {_TABLE} "
            f"WHERE lock_name = $1 AND expires_at > NOW()",
            lock_name,
        )
    except Exception:
        return None


def reset_for_tests() -> None:
    global _ensured
    _ensured = False
