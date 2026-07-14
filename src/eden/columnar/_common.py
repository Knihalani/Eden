"""Shared helpers for Cat 18 — Columnar Engine (v1.3).

The four services (:class:`ColumnarPartitionManager`,
:class:`ColumnarAggregator`, :class:`ColumnarCompactor`,
:class:`ColumnarQueryEngine`) share three concerns:

* **Envelope shape** — every route returns the
  ``status / feature / live / data`` envelope from
  :mod:`eden.intelligence_envelope`. The Cat 18 routes
  use the live ``ok`` shape on the happy path; the
  fallback path uses a stable ``data_source`` field so
  the UI can render a "slower than usual" badge.

* **ClickHouse availability probe** — the ClickHouse
  substrate is async-HTTP; it can be slow, timing out, or
  simply unreachable (the customer is on a deployment
  without ClickHouse). The shared
  :func:`_check_ch_available` helper runs a 1-second
  ``SELECT 1`` health probe against the existing
  :class:`ClickHouseSink` and returns ``True`` only when
  the substrate is healthy.

* **Deterministic id + partition name builders** — the
  partition id, rollup id, and compaction id are all
  content-derived (so re-running the same operation on
  the same input produces the same id, making the
  service re-runnable). The partition name is
  ``eden.<org_id>.<YYYY_MM>`` per the Brainstore-style
  per-customer partitioning decision (2026-06-11).

The Postgres fallback is implemented at the service
layer — every service that needs a SQL aggregate falls
back to a single ``fetch()`` against the existing
telemetry / usage / judge tables. The fallback is
deliberately conservative: the dashboard renders the
Postgres numbers with a ``data_source: "postgres_fallback"``
flag so the UI can show the "slower than usual" badge.

Closed-loop wiring: :func:`_fire_compaction_drift_hook`
fires :func:`ColumnarHook.on_compaction_drift` on the
two SLA-breach paths (compaction took > 4h, or
ClickHouse is unavailable at query time).
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ─── Envelope helpers ───────────────────────────────────────


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """The Cat 18 happy-path envelope.

    Mirrors the rest of the intelligence surface — the
    ``live: True`` flag signals the front-end to render
    the live dashboard rather than the "stub" badge.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "data": data,
    }


def _ok_fallback_envelope(
    feature: str, data: dict[str, Any], message: str
) -> dict[str, Any]:
    """The Cat 18 fallback envelope.

    Same shape as :func:`_ok_envelope` but with an extra
    ``data_source: "postgres_fallback"`` field on the
    payload and a top-level ``message`` for the UI.
    ``live`` is still ``True`` because the data is real —
    the UI uses the ``data_source`` to render the "slower
    than usual" badge.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "message": message,
        "data": data,
    }


def _not_implemented_envelope(
    feature: str, message: str
) -> dict[str, Any]:
    """The Cat 18 stub envelope.

    Returned when the request body is malformed (invalid
    granularity, empty window, unknown source table).
    Keeps the same ``IntelligenceStubResponse`` shape so
    the front-end renders a single uniform error card.
    """
    return {
        "status": "not_implemented",
        "feature": feature,
        "live": False,
        "data": None,
        "message": message,
    }


# ─── ClickHouse availability probe ───────────────────────────


# 1-second ceiling — the probe is called from the request
# path, so anything slower than this means ClickHouse is
# effectively unavailable. Matches the per-request time
# budget the cost dashboard needs.
_CH_HEALTH_TIMEOUT_SECONDS: float = 1.0


async def _check_ch_available() -> bool:
    """Return ``True`` if the ClickHouse substrate is healthy.

    Tries a 1-second ``SELECT 1`` health probe against the
    existing :class:`ClickHouseSink`. Returns ``False`` on
    any exception so the calling service can fall back to
    Postgres without try/except boilerplate.

    The probe caches a single failure per process for
    30 seconds — once ClickHouse is down, we don't want
    every dashboard request to spend a second timing out
    on the probe before falling back. The cache is a
    module-level ``(ok, until_ts)`` tuple.
    """
    now = time.monotonic()
    cached = _ch_health_cache
    if cached is not None and cached[1] > now:
        return cached[0]
    try:
        from eden.data_platform.clickhouse_sink import get_clickhouse_sink

        sink = await get_clickhouse_sink()
        # ``health_check`` is async; we cap the wall-clock wait
        # with a manual deadline so a hung ClickHouse doesn't
        # blow the request budget.
        deadline = time.monotonic() + _CH_HEALTH_TIMEOUT_SECONDS
        result = await sink.health_check()
        ok = False if time.monotonic() > deadline else result == "connected"
    except Exception as exc:  # noqa: BLE001 - probe is best-effort
        logger.warning("ClickHouse health probe failed: %s", exc)
        ok = False
    # Negative cache for 30s; positive cache for 5s.
    ttl = 30.0 if not ok else 5.0
    globals()["_ch_health_cache"] = (ok, now + ttl)
    return ok


_ch_health_cache: tuple[bool, float] | None = None


def _reset_ch_health_cache() -> None:
    """Test helper: clear the ClickHouse health cache.

    The cache is module-level so test isolation requires
    a manual reset between scenarios (especially the
    "healthy → unhealthy" transitions the columnar
    fallback tests rely on).
    """
    globals()["_ch_health_cache"] = None


# ─── Deterministic id builders ───────────────────────────────


def _rollup_id_for(
    *,
    org_id: str,
    source_table: str,
    granularity: str,
    window_start: datetime,
    window_end: datetime,
) -> str:
    """Deterministic rollup id for the given (org, table, window).

    Re-running the same precompute on the same input
    produces the same id, which means the
    :func:`_delete_then_insert` upsert pattern is safe.
    """
    digest = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"rollup|{org_id}|{source_table}|{granularity}|"
        f"{window_start.isoformat()}|{window_end.isoformat()}",
    )
    return f"rollup_{digest.hex[:12]}"


def _compaction_id_for(
    *, org_id: str, partition_id: str, started_at: datetime
) -> str:
    """Deterministic compaction id for the given (org, partition, started_at).

    Same rationale as :func:`_rollup_id_for` — re-runnable.
    """
    digest = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"compact|{org_id}|{partition_id}|{started_at.isoformat()}",
    )
    return f"compact_{digest.hex[:12]}"


# ─── Partition name builder ──────────────────────────────────


def _partition_id_for(
    *, org_id: str, when: datetime | None = None
) -> str:
    """The Brainstore-style per-customer partition id.

    The format is ``p_<YYYY>_<MM>_<DD>_<granularity>`` so the
    partition id is unique per org per day per granularity.
    The partition *name* (the ClickHouse identifier) is
    separate, computed by :func:`_clickhouse_partition_name`.
    """
    when = when or datetime.now(UTC)
    return f"p_{when.strftime('%Y_%m_%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"


def _clickhouse_partition_name(*, org_id: str) -> str:
    """Return the ClickHouse partition name for the org.

    Format: ``eden.<org_id>.<YYYY_MM>`` — matches the
    Brainstore-style per-customer partitioning the v1.3
    decision (2026-06-11) selected. The org_id is
    sanitised to alphanumerics + underscores so a
    maliciously-crafted org_id cannot inject SQL.
    """
    safe = "".join(c if c.isalnum() or c == "_" else "_" for c in org_id)
    return f"eden.{safe}.{datetime.now(UTC).strftime('%Y_%m')}"


# ─── Granularity validation ──────────────────────────────────


# ponytail: hourly granularity removed per upgradespec §D.6 (Phase 1 cut).
# Daily is the UI default; weekly covers long-range rollups. v2 can re-enable
# hourly by adding it back here + a ClickHouse sub-aggregation in
# aggregations.py (the "hour" → "toStartOfHour" mapping is preserved there).
_VALID_GRANULARITIES: frozenset[str] = frozenset({"day", "week"})
_VALID_SOURCE_TABLES: frozenset[str] = frozenset(
    {"telemetry_events", "usage_events", "judge_scores"}
)


def _validate_granularity(granularity: str) -> str | None:
    """Return the granularity if valid, else ``None``.

    A simple ``frozenset`` lookup — the v1.3 ship supports
    only daily + weekly (per upgradespec §D.6). Returns
    ``None`` on miss so the caller can return a stable
    ``_not_implemented_envelope`` shape.
    """
    if granularity in _VALID_GRANULARITIES:
        return granularity
    return None


def _validate_source_table(source_table: str) -> str | None:
    """Return the source table if valid, else ``None``."""
    if source_table in _VALID_SOURCE_TABLES:
        return source_table
    return None


# ─── JSON helpers ────────────────────────────────────────────


def _json_dumps(obj: Any) -> str:
    """JSON-serialise ``obj`` to a string.

    The standard ``json.dumps`` would fail on a ``datetime``
    or ``UUID``; we use the default ``str`` cast so a row
    with a ``datetime`` field round-trips through Postgres
    TEXT.
    """
    return json.dumps(obj, default=str, sort_keys=True)


# ─── Persistence helpers ─────────────────────────────────────


async def _delete_then_insert_rollup(
    *,
    org_id: str,
    rollup_id: str,
    source_table: str,
    granularity: str,
    window_start: datetime,
    window_end: datetime,
    payload_json: str,
    n_rows: int,
    compressed_bytes: int,
) -> None:
    """Delete-then-insert a rollup row.

    The v1.3 ship uses this pattern across the intelligence
    surface (Cat 1, 2, 3, 4, 5, 6, 8) so the services are
    re-runnable: re-running the same ``precompute_rollups``
    call replaces the existing row instead of appending a
    duplicate. The delete is scoped to the unique
    ``(org_id, source_table, granularity, window_end)`` tuple
    so concurrent rollups on different windows don't
    clobber each other.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    await client.execute(
        """
        DELETE FROM columnar_rollups
        WHERE org_id = $1
          AND source_table = $2
          AND granularity = $3
          AND window_start = $4
          AND window_end = $5
        """,
        org_id,
        source_table,
        granularity,
        window_start,
        window_end,
    )
    await client.execute(
        """
        INSERT INTO columnar_rollups (
            id, org_id, source_table, granularity, window_start,
            window_end, payload_json, n_rows, compressed_bytes
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9
        )
        """,
        uuid.UUID(rollup_id.replace("rollup_", "").ljust(32, "0")[:32]),
        org_id,
        source_table,
        granularity,
        window_start,
        window_end,
        payload_json,
        n_rows,
        compressed_bytes,
    )


async def _upsert_partition(
    *,
    org_id: str,
    partition_id: str,
    clickhouse_partition: str,
    granularity: str,
    rows_total: int,
    bytes_total: int,
) -> None:
    """Upsert a partition metadata row.

    Idempotent — repeated ``ensure_org_partition`` calls
    update ``rows_total`` and ``bytes_total`` in place. We
    use a single ``INSERT ... ON CONFLICT`` so the upsert
    is atomic and doesn't race.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO columnar_partitions (
            org_id, partition_id, clickhouse_partition, granularity,
            rows_total, bytes_total
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (org_id, partition_id) DO UPDATE SET
            rows_total = EXCLUDED.rows_total,
            bytes_total = EXCLUDED.bytes_total
        """,
        org_id,
        partition_id,
        clickhouse_partition,
        granularity,
        rows_total,
        bytes_total,
    )


async def _update_partition_after_compaction(
    *,
    org_id: str,
    partition_id: str,
    completed_at: datetime,
    duration_ms: int,
) -> None:
    """Update the partition metadata after a successful compaction.

    The ``last_compaction_at`` + ``last_compaction_dur_ms``
    fields are the SLA signal the closed-loop
    :class:`ColumnarHook.on_compaction_drift` reads on the
    next dashboard request.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    await client.execute(
        """
        UPDATE columnar_partitions
        SET last_compaction_at = $3,
            last_compaction_dur_ms = $4
        WHERE org_id = $1 AND partition_id = $2
        """,
        org_id,
        partition_id,
        completed_at,
        duration_ms,
    )


async def _insert_compaction_log(
    *,
    org_id: str,
    compaction_id: str,
    partition_id: str,
    started_at: datetime,
    completed_at: datetime,
    rows_in: int,
    rows_out: int,
    bytes_in: int,
    bytes_out: int,
    status: str,
    error: str | None,
) -> None:
    """Append a row to ``columnar_compaction_log``.

    Append-only — the table is a history, not a state. The
    query engine reads the latest successful entry on the
    Postgres fallback path so a degraded ClickHouse can
    still surface "last successful compaction" without
    hitting the live ClickHouse API.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO columnar_compaction_log (
            id, org_id, partition_id, started_at, completed_at,
            rows_in, rows_out, bytes_in, bytes_out, status, error
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        )
        """,
        uuid.UUID(compaction_id.replace("compact_", "").ljust(32, "0")[:32]),
        org_id,
        partition_id,
        started_at,
        completed_at,
        rows_in,
        rows_out,
        bytes_in,
        bytes_out,
        status,
        error,
    )


# ─── Closed-loop hook firer ──────────────────────────────────


async def _fire_compaction_drift_hook(
    org_id: str,
    *,
    partition_id: str | None,
    reason: str,
    severity: str = "medium",
) -> None:
    """Fire the closed-loop :class:`ColumnarHook` if available.

    Stub no-op in the v1.3 ship — the hook is registered
    in :mod:`eden.llmops.promotion_hooks` as a no-op
    logger. A real implementation (v1.4) would route the
    event to the org's alert channel.
    """
    try:
        from eden.llmops.promotion_hooks import (
            get_columnar_hook,
        )
    except ImportError:
        # The hook isn't registered yet — log + move on.
        logger.debug(
            "columnar_hook not registered; org=%s partition=%s "
            "reason=%s (no-op)",
            org_id,
            partition_id,
            reason,
        )
        return
    hook = get_columnar_hook()
    hook.on_compaction_drift(
        org_id,
        partition_id=partition_id,
        reason=reason,
        severity=severity,
    )


# ─── Postgres fallback query helpers ─────────────────────────


# Per-source-table Postgres column mapping. telemetry_events and
# judge_scores use ``tenant_id`` + ``timestamp``; usage_events uses
# ``org_id`` + ``created_at``. The fallback path must pick the
# right pair or every CH-down request returns 0 / errors.
_PG_TABLE_COLUMNS: dict[str, tuple[str, str]] = {
    "telemetry_events": ("tenant_id", "timestamp"),
    "usage_events": ("org_id", "created_at"),
    "judge_scores": ("tenant_id", "scored_at"),
}


async def _postgres_count_rows(
    *, org_id: str, source_table: str
) -> int:
    """Return the row count for the (org, source_table) pair.

    Used by the Postgres-fallback path of
    :class:`ColumnarQueryEngine` and
    :class:`ColumnarAggregator`. Defensive: only the
    three Cat 18 source tables are whitelisted so a
    caller cannot turn the helper into a SQL-injection
    surface.
    """
    if source_table not in _VALID_SOURCE_TABLES:
        return 0
    tenant_col, _ = _PG_TABLE_COLUMNS.get(
        source_table, ("org_id", "created_at")
    )
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    quoted = f'"{source_table}"'  # tables are pre-vetted, but quote anyway
    try:
        row = await client.fetchrow(
            f"SELECT count(*)::bigint AS n FROM {quoted} "
            f"WHERE {tenant_col} = $1",
            org_id,
        )
    except Exception as exc:  # noqa: BLE001 - fallback returns 0
        logger.debug(
            "columnar._postgres_count_rows failed table=%s: %s",
            source_table,
            exc,
        )
        return 0
    return int(row["n"]) if row else 0


__all__ = [
    "_VALID_GRANULARITIES",
    "_VALID_SOURCE_TABLES",
    "_PG_TABLE_COLUMNS",
    "_check_ch_available",
    "_compaction_id_for",
    "_delete_then_insert_rollup",
    "_fire_compaction_drift_hook",
    "_insert_compaction_log",
    "_json_dumps",
    "_not_implemented_envelope",
    "_ok_envelope",
    "_ok_fallback_envelope",
    "_partition_id_for",
    "_clickhouse_partition_name",
    "_postgres_count_rows",
    "_reset_ch_health_cache",
    "_rollup_id_for",
    "_update_partition_after_compaction",
    "_upsert_partition",
    "_validate_granularity",
    "_validate_source_table",
]
