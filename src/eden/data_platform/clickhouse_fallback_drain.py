"""Replay ``clickhouse_fallback`` rows back into ClickHouse.

``ClickHouseSink._fallback_to_postgres`` has always described itself as
writing "failed ClickHouse rows to PostgreSQL for later retry". The
retry was never written. Before this module, nothing in ``src/`` issued a
``SELECT`` against ``clickhouse_fallback`` and nothing ever set
``resolved_at`` — so every ClickHouse insert failure produced a row that
was stored, never replayed, and never deleted. The columnar copy of that
batch was lost permanently while the Postgres table grew forever.

The rows are replayable: 008 stores the whole serialized row in
``payload JSONB`` alongside the ``target_table`` it was destined for,
which is exactly the ``(table, rows)`` pair ``_insert_json`` takes.

Design notes that are easy to get wrong:

* **Replay goes through ``_insert_json``, not through the public batch
  path.** The public path calls ``_fallback_to_postgres`` on failure, so
  draining through it would append a *fresh* fallback row for every row
  that fails to drain — turning a retry loop into an amplifier. The
  private primitive raises instead, which is what a retry needs.

* **A terminal state is mandatory.** A payload ClickHouse structurally
  cannot accept (dropped column, type change, schema drift) fails
  identically on every attempt. Without a give-up bound it is retried
  forever and, because the queue is oldest-first, it sits at the head of
  that queue starving every row behind it. After ``_MAX_ATTEMPTS`` the
  row is marked ``dead_at`` and counted through the drop counter.

* **Give-ups are counted, not just logged.** ``record_drop("sink_ch",
  "write_error", n)`` — an already-seeded pair in the closed vocabulary
  of ``observability/drop_metrics``. Abandoning a fallback row *is* the
  ClickHouse sink losing events; it is the same loss the sink counts when
  the original insert fails, only deferred, so it belongs on the same
  series rather than on a new parallel one.

* **Concurrency is bounded and Postgres stays sequential.**
  ``PostgresClient.acquire`` can hand back a request-pinned connection
  shared across a context and asyncpg permits one operation in flight per
  connection, so fanning out concurrent queries on it corrupts the
  protocol. The ClickHouse replays are pure HTTP and are overlapped with
  ``bounded_gather``; every Postgres statement in this module runs one at
  a time, awaited to completion.

* **Draining alone does not bound the table.** Resolved and dead rows
  still accumulate, so the same unbounded growth returns in a slower
  form. A bounded purge of long-settled rows runs on the same tick.
"""

from __future__ import annotations

import logging
import os
import socket
from typing import Any

logger = logging.getLogger(__name__)

#: Rows pulled per drain pass. Bounded so a large backlog is worked off
#: over many ticks instead of one tick trying to replay everything and
#: holding a connection for minutes.
_BATCH_LIMIT = 500

#: Attempts before a row is declared undeliverable. Five attempts across
#: the exponential backoff below spans roughly half an hour, which clears
#: any transient ClickHouse outage; anything still failing after that is
#: a payload ClickHouse will never accept.
_MAX_ATTEMPTS = 5

#: Backoff base. A row that has failed ``n`` times is not retried until
#: ``2^n`` minutes have passed, capped by ``_BACKOFF_CAP_MINUTES``.
_BACKOFF_BASE_MINUTES = 1
_BACKOFF_CAP_MINUTES = 60

#: How long settled rows are kept before the purge removes them.
#: Resolved rows are pure audit trail once replayed; dead rows are kept
#: longer because they are the only record of what was lost.
_PURGE_RESOLVED_AFTER_DAYS = 7
_PURGE_DEAD_AFTER_DAYS = 30

#: Distinct target tables replayed concurrently. Each is one HTTP round
#: trip to ClickHouse and holds no Postgres connection.
_REPLAY_CONCURRENCY = 4

#: Leader lock. Shared name across replicas so exactly one drains.
_LOCK_NAME = "clickhouse_fallback_drain"
_LOCK_TTL_SECONDS = 300


def _identity() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


async def _run_drain(pg: Any, limit: int) -> dict[str, object]:
    """One drain pass. Assumes leadership is already held."""
    # Oldest-first over live rows only, backed by
    # ``idx_clickhouse_fallback_drain`` (migration 125). The backoff
    # comparison is a runtime filter rather than part of the index
    # predicate — a predicate containing NOW() is STABLE, which Postgres
    # rejects for an index (the entire reason migration 083 exists).
    rows = await pg.fetch(
        """
        SELECT id, target_table, payload, retry_count
          FROM clickhouse_fallback
         WHERE resolved_at IS NULL
           AND dead_at IS NULL
           AND (
                last_retry_at IS NULL
             OR last_retry_at < NOW() - make_interval(
                    mins => LEAST($2 * POWER(2, retry_count), $3)::int
                )
           )
         ORDER BY failed_at
         LIMIT $1
        """,
        limit,
        _BACKOFF_BASE_MINUTES,
        _BACKOFF_CAP_MINUTES,
    )
    if not rows:
        return {"claimed": 0, "replayed": 0, "failed": 0, "gave_up": 0}

    # Group by destination so each table is one ClickHouse insert rather
    # than one per row.
    batches: dict[str, list[Any]] = {}
    for row in rows:
        batches.setdefault(str(row["target_table"]), []).append(row)

    from eden.async_tasks import bounded_gather
    from eden.data_platform.clickhouse_sink import get_clickhouse_sink

    sink = await get_clickhouse_sink()

    def _payload(row: Any) -> dict[str, Any]:
        raw = row["payload"]
        if isinstance(raw, str):
            from eden.util.jsonx import loads as _loads

            return dict(_loads(raw))
        return dict(raw)

    async def _replay(table: str, group: list[Any]) -> None:
        # ``_insert_json`` and not the public batch path: the public path
        # writes a new clickhouse_fallback row on failure, which would
        # make every failed drain grow the very table it is draining.
        await sink._insert_json(table, [_payload(r) for r in group])

    names = list(batches.keys())
    # HTTP only — no Postgres connection is held inside these, so the
    # single-operation-per-connection rule does not apply here. The
    # Postgres updates below are strictly sequential for that reason.
    outcomes = await bounded_gather(
        *(_replay(name, batches[name]) for name in names),
        limit=_REPLAY_CONCURRENCY,
        return_exceptions=True,
    )

    replayed = 0
    failed = 0
    gave_up = 0

    for name, outcome in zip(names, outcomes, strict=True):
        ids = [r["id"] for r in batches[name]]
        if not isinstance(outcome, BaseException):
            await pg.execute(
                "UPDATE clickhouse_fallback SET resolved_at = NOW() "
                "WHERE id = ANY($1::uuid[]) AND resolved_at IS NULL",
                ids,
            )
            replayed += len(ids)
            continue

        failed += len(ids)
        message = f"{type(outcome).__name__}: {str(outcome)[:400]}"
        logger.warning(
            "clickhouse_fallback drain: %d row(s) for %s failed to replay: %s",
            len(ids),
            name,
            message,
        )
        # One statement does the increment, the backoff stamp and the
        # give-up decision together, so a row can never be counted as
        # retried without also being considered for the terminal state.
        settled = await pg.fetch(
            """
            UPDATE clickhouse_fallback
               SET retry_count   = retry_count + 1,
                   last_retry_at = NOW(),
                   error_message = $2,
                   dead_at = CASE
                       WHEN retry_count + 1 >= $3 THEN NOW()
                       ELSE NULL
                   END
             WHERE id = ANY($1::uuid[])
               AND resolved_at IS NULL
               AND dead_at IS NULL
            RETURNING dead_at
            """,
            ids,
            message,
            _MAX_ATTEMPTS,
        )
        gave_up += sum(1 for r in settled if r["dead_at"] is not None)

    if gave_up:
        # Same series the sink increments when the original insert fails:
        # this is that same loss, finally made final.
        from eden.observability.drop_metrics import record_drop

        record_drop("sink_ch", "write_error", gave_up)
        logger.error(
            "clickhouse_fallback drain: gave up on %d row(s) after %d attempts; "
            "those events are permanently absent from ClickHouse",
            gave_up,
            _MAX_ATTEMPTS,
        )

    return {
        "claimed": len(rows),
        "replayed": replayed,
        "failed": failed,
        "gave_up": gave_up,
        "tables": len(names),
    }


async def _purge_settled(pg: Any) -> dict[str, object]:
    """Delete long-settled rows so the table stays bounded after draining."""
    tag = await pg.execute(
        """
        DELETE FROM clickhouse_fallback
         WHERE (resolved_at IS NOT NULL
                AND resolved_at < NOW() - make_interval(days => $1))
            OR (dead_at IS NOT NULL
                AND dead_at < NOW() - make_interval(days => $2))
        """,
        _PURGE_RESOLVED_AFTER_DAYS,
        _PURGE_DEAD_AFTER_DAYS,
    )
    return {"purged": tag}


async def run_once(*, limit: int = _BATCH_LIMIT) -> dict[str, object]:
    """Drain one bounded batch, under the shared leader lease.

    Safe to call from every replica: ``_acquire_with_fallback`` is the
    same Redis-primary / Postgres-fallback election the background loops
    use, so a Redis that silently drops writes cannot both prevent
    leadership and hide that it did (the July 2026 outage).
    """
    from eden.storage.postgres import get_postgres_client
    from eden.storage.redis import Lock
    from eden.workers.leader import _acquire_with_fallback

    pg = await get_postgres_client()
    if pg is None:
        return {"skipped": True, "reason": "postgres_unavailable"}

    identity = _identity()
    lock = Lock(_LOCK_NAME, ttl=_LOCK_TTL_SECONDS, prefix="eden:leader")
    acquired, backend = await _acquire_with_fallback(
        lock, _LOCK_NAME, identity, _LOCK_TTL_SECONDS
    )
    if not acquired:
        return {"skipped": True, "reason": "not_leader"}

    try:
        result = await _run_drain(pg, limit)
        result.update(await _purge_settled(pg))
        result["backend"] = backend
        return result
    finally:
        # Release through whichever backend actually granted the lease;
        # releasing the other one is a no-op at best and stomps a peer's
        # lease at worst.
        if backend == "postgres":
            from eden.storage import pg_lease

            await pg_lease.release(_LOCK_NAME, identity)
        else:
            await lock.release()
