"""Phase 0 observability overhaul — EQL alerts vs. the Tinybird schema.

``eden.dsl.alerts.AlertAsCode`` compiles EQL against the logical schema
(table ``telemetry_events``, column ``org_id``) that the read-only
allowlist and tenant-isolation injector in :mod:`eden.dsl._common` are
hardened against. Tinybird's actual mirror is ``telemetry_events_ch``
with a ``tenant_id`` column (see
``tinybird/datasources/telemetry_events_ch.datasource`` and
:mod:`eden.columnar.tables`) — every alert execution against Tinybird
failed with UNKNOWN_TABLE / UNKNOWN_IDENTIFIER until
:func:`eden.dsl._common._to_columnar_physical_sql` translated the
compiled SQL at the ClickHouse execution boundary.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.dsl._common import _to_columnar_physical_sql


def test_translates_table_and_org_id_column() -> None:
    sql = "SELECT * FROM telemetry_events t WHERE t.org_id = 'org_123'"
    out = _to_columnar_physical_sql(sql)
    assert "FROM telemetry_events_ch t" in out
    assert out.count("telemetry_events_ch") == 1
    assert "t.tenant_id = 'org_123'" in out
    assert "org_id" not in out


def test_translates_bare_and_qualified_org_id_references() -> None:
    sql = (
        "SELECT * FROM telemetry_events t WHERE "
        "(org_id = 'a' OR EXISTS (SELECT 1 FROM telemetry_events e "
        "WHERE e.org_id = 'a')) AND t.org_id = 'a'"
    )
    out = _to_columnar_physical_sql(sql)
    assert out.count("tenant_id") == 3
    assert "org_id" not in out
    assert out.count("telemetry_events_ch") == 2


def test_does_not_rewrite_org_id_inside_string_literal() -> None:
    sql = "SELECT * FROM telemetry_events t WHERE t.message = 'contains org_id text'"
    out = _to_columnar_physical_sql(sql)
    # The literal survives untouched.
    assert "'contains org_id text'" in out
    # The table reference is still translated.
    assert "telemetry_events_ch" in out


def test_idempotent_table_rename_does_not_double_suffix() -> None:
    # Applying the translation twice must not turn telemetry_events_ch
    # into telemetry_events_ch_ch — \btelemetry_events\b never matches
    # inside telemetry_events_ch (no word boundary before "_ch").
    sql = "SELECT * FROM telemetry_events t WHERE t.org_id = 'a'"
    once = _to_columnar_physical_sql(sql)
    twice = _to_columnar_physical_sql(once)
    assert once == twice
    assert "telemetry_events_ch_ch" not in twice


def test_empty_sql_is_a_noop() -> None:
    assert _to_columnar_physical_sql("") == ""


def test_no_mirror_table_is_a_noop() -> None:
    with patch("eden.dsl._common.has_clickhouse_mirror", return_value=False):
        sql = "SELECT * FROM telemetry_events WHERE org_id = 'a'"
        assert _to_columnar_physical_sql(sql) == sql


@pytest.mark.asyncio
async def test_run_alert_sql_sends_physical_sql_to_clickhouse() -> None:
    """End-to-end: AlertAsCode._run_alert_sql must hand ClickHouseSink
    the physical-schema SQL, not the logical (Postgres-shaped) SQL that
    Cat 19 compiled and org-scoped."""
    from eden.dsl import alerts as dsl_alerts

    captured: list[str] = []

    class _FakeSink:
        async def _execute(self, sql: str) -> str:  # noqa: SLF001
            captured.append(sql)
            return "n\n0\n"

        def _parse_tsv(self, raw: str) -> list[dict]:  # noqa: SLF001
            return []

    with (
        patch(
            "eden.columnar._common._check_ch_available",
            new=AsyncMock(return_value=True),
        ),
        patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            new=AsyncMock(return_value=_FakeSink()),
        ),
    ):
        rows, data_source = await dsl_alerts._run_alert_sql(
            "SELECT count() AS n FROM telemetry_events t WHERE t.org_id = 'org_123'"
        )

    assert data_source == "clickhouse"
    assert rows == []
    assert len(captured) == 1
    assert "telemetry_events_ch" in captured[0]
    assert "tenant_id = 'org_123'" in captured[0]
    assert "org_id" not in captured[0]
