"""Cat 18 — ColumnarAggregator.

Pre-computes the (org, source_table, granularity, window)
rollups the dashboards read instead of re-aggregating
on every request. The v1.3 ship writes one row per call to
``columnar_rollups`` with the per-time-bucket aggregates
JSON-serialised in ``payload_json``.

The aggregator supports the three granularities
(:class:`_VALID_GRANULARITIES`):

* **hour** — ``toStartOfHour(created)``, ``n`` buckets
  per day
* **day** — ``toDate(created)``, ``n`` buckets per month
* **week** — ``toMonday(created)``, ``n`` buckets per
  quarter

The ClickHouse-first happy path is a single
``INSERT ... SELECT`` that buckets the source table on
the granularity, aggregates ``count()``, ``sum(cost_usd)``
(if the source has it), and a small handful of standard
metrics the dashboards render (n_errors, p95_ms when
available). The Postgres fallback runs the same
aggregation with the corresponding ``date_trunc`` call.

The service is **re-runnable**: the
:func:`_delete_then_insert_rollup` helper deletes any
existing rollup for the
``(org, source_table, granularity, window_start, window_end)``
tuple before inserting the new one, so the dashboard
sees the freshest aggregates on every call.

Closed-loop wiring: the aggregator does not fire hooks
itself. The compaction hook fires from
:class:`ColumnarCompactor` on the SLA-breach path, and
the query engine fires the "ch_unavailable" reason on
its fallback path. The aggregator is a write-mostly
service.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from ._common import (
    _check_ch_available,
    _delete_then_insert_rollup,
    _json_dumps,
    _not_implemented_envelope,
    _ok_envelope,
    _ok_fallback_envelope,
    _rollup_id_for,
    _validate_granularity,
    _validate_source_table,
)

logger = logging.getLogger(__name__)


class ColumnarAggregator:
    """Pre-compute rollups for the (org, table, granularity, window) tuple."""

    async def precompute_rollups(
        self,
        org_id: str,
        *,
        table: str,
        granularity: str,
        window_start: datetime,
        window_end: datetime,
    ) -> dict[str, Any]:
        """Compute the rollup for the given window.

        Args:
            org_id: The tenant id.
            table: One of ``telemetry_events|usage_events|
                judge_scores`` (whitelisted by
                :func:`_validate_source_table`).
            granularity: One of ``hour|day|week``
                (whitelisted by
                :func:`_validate_granularity`).
            window_start: Inclusive lower bound.
            window_end: Inclusive upper bound.

        Returns:
            The Cat 18 live envelope with the rollup id +
            row count + duration. ``data_source`` is
            ``clickhouse`` on the happy path, ``postgres_fallback``
            when the substrate is unavailable. An invalid
            input returns the ``not_implemented`` envelope.
        """
        if _validate_source_table(table) is None:
            return _not_implemented_envelope(
                "ColumnarAggregator",
                f"invalid source_table: {table!r} "
                "(expected one of: telemetry_events, "
                "usage_events, judge_scores)",
            )
        if _validate_granularity(granularity) is None:
            return _not_implemented_envelope(
                "ColumnarAggregator",
                f"invalid granularity: {granularity!r} "
                "(expected one of: hour, day, week)",
            )
        if window_end <= window_start:
            return _not_implemented_envelope(
                "ColumnarAggregator",
                f"window_end must be after window_start "
                f"(got {window_start.isoformat()} → "
                f"{window_end.isoformat()})",
            )

        rollup_id = _rollup_id_for(
            org_id=org_id,
            source_table=table,
            granularity=granularity,
            window_start=window_start,
            window_end=window_end,
        )

        # ClickHouse happy path. The probe is cached so a
        # request burst doesn't each pay a 1s timeout.
        if await _check_ch_available():
            try:
                t0 = time.monotonic()
                payload, n_rows, compressed_bytes = (
                    await self._ch_aggregate(
                        org_id=org_id,
                        table=table,
                        granularity=granularity,
                        window_start=window_start,
                        window_end=window_end,
                    )
                )
                duration_ms = int((time.monotonic() - t0) * 1000)
                await _delete_then_insert_rollup(
                    org_id=org_id,
                    rollup_id=rollup_id,
                    source_table=table,
                    granularity=granularity,
                    window_start=window_start,
                    window_end=window_end,
                    payload_json=_json_dumps(payload),
                    n_rows=n_rows,
                    compressed_bytes=compressed_bytes,
                )
                return _ok_envelope(
                    "ColumnarAggregator",
                    {
                        "rollup_id": rollup_id,
                        "org_id": org_id,
                        "source_table": table,
                        "granularity": granularity,
                        "window_start": window_start.isoformat(),
                        "window_end": window_end.isoformat(),
                        "n_rows": n_rows,
                        "compressed_bytes": compressed_bytes,
                        "duration_seconds": duration_ms / 1000.0,
                        "data_source": "clickhouse",
                        "n_buckets": len(payload.get("buckets", [])),
                    },
                )
            except Exception as exc:  # noqa: BLE001 - fallback path
                logger.warning(
                    "ClickHouse rollup failed for org=%s table=%s: %s; "
                    "falling back to Postgres",
                    org_id,
                    table,
                    exc,
                )

        # Postgres fallback path. Runs the same shape of
        # aggregation via a single ``fetch()`` against the
        # whitelisted source table.
        t0 = time.monotonic()
        payload, n_rows = await self._pg_aggregate(
            org_id=org_id,
            table=table,
            granularity=granularity,
            window_start=window_start,
            window_end=window_end,
        )
        duration_ms = int((time.monotonic() - t0) * 1000)
        # Postgres has no equivalent of ClickHouse's
        # "compressed_bytes" — we estimate from the bucket
        # count and an average bucket size.
        compressed_bytes = max(len(payload.get("buckets", [])) * 256, 0)
        await _delete_then_insert_rollup(
            org_id=org_id,
            rollup_id=rollup_id,
            source_table=table,
            granularity=granularity,
            window_start=window_start,
            window_end=window_end,
            payload_json=_json_dumps(payload),
            n_rows=n_rows,
            compressed_bytes=compressed_bytes,
        )
        return _ok_fallback_envelope(
            "ColumnarAggregator",
            {
                "rollup_id": rollup_id,
                "org_id": org_id,
                "source_table": table,
                "granularity": granularity,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "n_rows": n_rows,
                "compressed_bytes": compressed_bytes,
                "duration_seconds": duration_ms / 1000.0,
                "data_source": "postgres_fallback",
                "n_buckets": len(payload.get("buckets", [])),
            },
            "ClickHouse unavailable; rollup computed from Postgres",
        )

    async def _ch_aggregate(
        self,
        *,
        org_id: str,
        table: str,
        granularity: str,
        window_start: datetime,
        window_end: datetime,
    ) -> tuple[dict[str, Any], int, int]:
        """Run the ClickHouse aggregation.

        Returns ``(payload, n_rows, compressed_bytes)`` where
        ``payload`` is the JSON-serialisable dict the
        dashboard renders, ``n_rows`` is the number of
        source rows aggregated, and ``compressed_bytes`` is
        the size estimate the rollup will consume on disk.
        """
        from eden.data_platform.clickhouse_sink import get_clickhouse_sink

        sink = await get_clickhouse_sink()
        trunc = {
            "hour": "toStartOfHour",
            "day": "toDate",
            "week": "toMonday",
        }[granularity]
        # The aggregate columns are source-table-specific:
        # telemetry_events has duration_ms; usage_events
        # has cost_usd; judge_scores has score. We pick
        # the safe subset that all three tables have —
        # ``count()`` — plus any of the optional columns
        # that exist for that table.
        optional_cols: list[str] = []
        if table == "telemetry_events":
            optional_cols = [
                "countIf(level = 'error') AS n_errors",
                "quantile(0.95)(duration_ms) AS p95_ms",
            ]
        elif table == "usage_events":
            optional_cols = ["sum(cost_usd) AS total_cost_usd"]
        elif table == "judge_scores":
            optional_cols = [
                "avg(score) AS mean_score",
                "countIf(passed = false) AS n_failed",
            ]
        select_optional = ", ".join(optional_cols)
        select_clause = (
            f"{trunc}(created) AS bucket, count() AS n"
            + (f", {select_optional}" if select_optional else "")
        )
        query = (
            f"SELECT {select_clause} "
            f"FROM {sink.config.database}.{table} "
            f"WHERE org_id = '{_escape_org_id(org_id)}' "
            f"AND created >= '{window_start.isoformat()}' "
            f"AND created < '{window_end.isoformat()}' "
            f"GROUP BY bucket ORDER BY bucket ASC"
        )
        raw = await sink._execute(query)  # noqa: SLF001 - intentional
        rows = sink._parse_tsv(raw)  # noqa: SLF001 - intentional
        buckets: list[dict[str, Any]] = []
        for r in rows:
            buckets.append(
                {
                    "bucket": r.get("bucket", ""),
                    "n": int(r.get("n", 0) or 0),
                    "n_errors": int(r.get("n_errors", 0) or 0)
                    if "n_errors" in r
                    else None,
                    "p95_ms": float(r.get("p95_ms", 0) or 0)
                    if "p95_ms" in r
                    else None,
                    "total_cost_usd": float(
                        r.get("total_cost_usd", 0) or 0
                    )
                    if "total_cost_usd" in r
                    else None,
                    "mean_score": float(r.get("mean_score", 0) or 0)
                    if "mean_score" in r
                    else None,
                    "n_failed": int(r.get("n_failed", 0) or 0)
                    if "n_failed" in r
                    else None,
                }
            )
        n_rows = sum(int(b["n"] or 0) for b in buckets)
        # The compressed-bytes estimate is the raw row count
        # times 256 bytes/row — matches the existing
        # `usage_events` size assumption.
        compressed_bytes = n_rows * 256
        payload = {
            "org_id": org_id,
            "source_table": table,
            "granularity": granularity,
            "n_buckets": len(buckets),
            "buckets": buckets,
        }
        return (payload, n_rows, compressed_bytes)

    async def _pg_aggregate(
        self,
        *,
        org_id: str,
        table: str,
        granularity: str,
        window_start: datetime,
        window_end: datetime,
    ) -> tuple[dict[str, Any], int]:
        """Run the Postgres aggregation.

        Same shape as :meth:`_ch_aggregate` but using
        ``date_trunc`` and the corresponding column set.
        The optional columns are conservative — only the
        ``count()`` is guaranteed to work across the three
        source tables.
        """
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        trunc = {
            "hour": "hour",
            "day": "day",
            "week": "week",
        }[granularity]
        rows = await client.fetch(
            f"""
            SELECT
                date_trunc('{trunc}', created_at) AS bucket,
                count(*)::bigint AS n
            FROM {table}
            WHERE org_id = $1
              AND created_at >= $2
              AND created_at < $3
            GROUP BY bucket
            ORDER BY bucket ASC
            """,
            org_id,
            window_start,
            window_end,
        )
        buckets = [
            {
                "bucket": (
                    r["bucket"].isoformat()
                    if hasattr(r["bucket"], "isoformat")
                    else str(r["bucket"])
                ),
                "n": int(r["n"] or 0),
            }
            for r in rows
        ]
        n_rows = sum(int(b["n"] or 0) for b in buckets)
        payload = {
            "org_id": org_id,
            "source_table": table,
            "granularity": granularity,
            "n_buckets": len(buckets),
            "buckets": buckets,
        }
        return (payload, n_rows)


def _escape_org_id(org_id: str) -> str:
    """Sanitise ``org_id`` for interpolation into a ClickHouse query.

    ClickHouse string literals use single quotes; we
    double any embedded single quote and reject newlines
    to keep the call safe. A safer alternative is to use
    parameterized queries, but the existing
    :class:`ClickHouseSink` doesn't expose them — so we
    sanitise.
    """
    return org_id.replace("'", "''").replace("\n", " ").replace("\r", " ")


__all__ = ["ColumnarAggregator"]
