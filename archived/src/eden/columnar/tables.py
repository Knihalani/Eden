"""Logical table/column names → their ClickHouse physical equivalents.

Nothing like this existed, and the columnar read path assumed the two
namespaces were the same. `aggregations.py` built its ClickHouse SQL from the
*Postgres* names, so a single query was wrong five independent ways:

    SELECT toDate(created) AS bucket, count() AS n,
           countIf(level = 'error') AS n_errors,
           quantile(0.95)(duration_ms) AS p95_ms
    FROM eden.telemetry_events
    WHERE org_id = '...' AND created >= '...'

* `eden.telemetry_events` does not exist — the mirror is
  `telemetry_events_ch`.
* `org_id` does not exist there; the column is `tenant_id`.
* `created` does not exist there; the column is `timestamp`.
* `level` does not exist anywhere in the ClickHouse schema; the equivalent
  is `outcome`.
* `usage_events` and `judge_scores` have no ClickHouse mirror at all — no
  DDL, no `.datasource`, nothing.

Every call therefore raised `UNKNOWN_TABLE` or `UNKNOWN_IDENTIFIER` and was
swallowed by an `except Exception` that fell back to Postgres. Combined with
the transport bug in `clickhouse_sink._execute` — which made *every* statement
fail — the result was a columnar aggregation path that had never returned a
single row, and could not have even after the transport was fixed.

The point of putting this in one module is that `has_clickhouse_mirror()` lets
callers skip a round trip that is guaranteed to fail, rather than discovering
it through an exception. A logical table with no mirror is a normal, expected
state — not an error to be caught.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Final

#: Logical (Postgres) table name → ClickHouse table, or ``None`` when no
#: ClickHouse mirror exists. Keys must stay in step with
#: ``columnar.query._PG_ALLOWED_TABLES``.
CLICKHOUSE_TABLES: Final[dict[str, str | None]] = {
    "telemetry_events": "telemetry_events_ch",
    # No ClickHouse DDL exists for either of these. They are listed
    # explicitly, mapped to None, so that "no mirror" is a fact this module
    # states rather than something a caller infers from a query failure.
    "usage_events": None,
    "judge_scores": None,
}

#: Per-table logical column → ClickHouse column. Only differences are listed;
#: anything absent is assumed identical (``duration_ms`` is the same on both
#: sides, for instance).
CLICKHOUSE_COLUMNS: Final[dict[str, dict[str, str]]] = {
    "telemetry_events": {
        "org_id": "tenant_id",
        "tenant_id": "tenant_id",
        "created": "timestamp",
        "created_at": "timestamp",
        "timestamp": "timestamp",
        # Postgres records severity in ``level``; the ClickHouse mirror
        # records the terminal state in ``outcome``. ``level = 'error'`` and
        # ``outcome = 'error'`` are the equivalent predicates.
        "level": "outcome",
        "outcome": "outcome",
    },
}


def clickhouse_datetime(value: datetime) -> str:
    """Format a datetime as a literal ClickHouse will actually parse.

    ``datetime.isoformat()`` produces ``2026-07-29T23:00:00+00:00``, and
    ClickHouse rejects the UTC offset outright::

        Code: 6. Cannot parse string '2026-07-29T23:00:00+00:00'
        as DateTime64(3)

    The aggregation path interpolated ``isoformat()`` straight into its
    ``WHERE`` clause, so every ClickHouse rollup failed with TYPE_MISMATCH
    even once the table and column names were right. Normalise to UTC and
    emit ``YYYY-MM-DD HH:MM:SS``, which both ``DateTime`` and
    ``DateTime64`` accept.

    A naive datetime is assumed to already be UTC, matching how the rest of
    the columnar path treats them.
    """
    if value.tzinfo is None:
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return value.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S")


def has_clickhouse_mirror(logical_table: str) -> bool:
    """Whether ``logical_table`` exists in ClickHouse at all.

    ``False`` means "ask Postgres", not "something went wrong".
    """
    return CLICKHOUSE_TABLES.get(logical_table) is not None


def clickhouse_table(logical_table: str) -> str:
    """Physical ClickHouse table for a logical name.

    Raises ``KeyError`` rather than guessing. Silently passing an unmapped
    name through is what produced ``FROM eden.telemetry_events``, a query
    that parsed, ran, and failed at the storage layer where the failure was
    swallowed.
    """
    physical = CLICKHOUSE_TABLES.get(logical_table)
    if physical is None:
        raise KeyError(
            f"{logical_table!r} has no ClickHouse mirror; call "
            "has_clickhouse_mirror() first and read from Postgres"
        )
    return physical


def clickhouse_column(logical_table: str, logical_column: str) -> str:
    """Physical ClickHouse column, defaulting to the logical name."""
    return CLICKHOUSE_COLUMNS.get(logical_table, {}).get(
        logical_column, logical_column
    )
