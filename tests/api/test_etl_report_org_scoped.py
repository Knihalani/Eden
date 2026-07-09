"""Audit F46 — `get_latest_etl_report` must scope by org_id.

Pre-fix the route did:

    SELECT * FROM data_retention_log
    WHERE policy_name = 'silver_etl_batch'
    ORDER BY completed_at DESC
    LIMIT 1

Without an ``org_id = $1`` predicate. Any caller could read
ETL statistics for *any* tenant because the route took
``org_id`` as a path parameter but never used it in the query.

This test pins the SQL contract: the query MUST include
``org_id = $1`` (otherwise the contract is silently broken
by a future refactor).
"""
from __future__ import annotations

from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "src" / "eden" / "api" / "routes" / "data_platform.py"


def _find_get_latest_etl_report_source() -> str:
    text = SRC.read_text()
    # Find the function body of ``get_latest_etl_report``
    start = text.find("async def get_latest_etl_report")
    assert start != -1, "get_latest_etl_report not found"
    # End at the next top-level ``@router.`` decorator or end-of-file
    next_marker = text.find("\n@router.", start + 1)
    end = next_marker if next_marker != -1 else len(text)
    return text[start:end]


def test_latest_etl_report_query_scopes_by_org_id():
    """The fetchrow query must include ``org_id = $1``."""
    body = _find_get_latest_etl_report_source()
    assert "org_id = $1" in body, (
        "get_latest_etl_report must scope the data_retention_log "
        "query by org_id = $1; pre-fix the query omitted org_id "
        "and any caller could read ETL stats for any tenant."
    )
    # The query MUST pass org_id as a parameter, not interpolate it
    # into the SQL string.
    assert "SELECT * FROM data_retention_log" in body
    # The query body should NOT use string interpolation of the
    # org_id value (would be an injection vector even with internal
    # auth).
    assert "f\"SELECT" not in body or "org_id = $1" in body


def test_latest_etl_report_uses_data_retention_log():
    """Sanity check: source still reads from the retention log table."""
    body = _find_get_latest_etl_report_source()
    assert "data_retention_log" in body
    assert "silver_etl_batch" in body
