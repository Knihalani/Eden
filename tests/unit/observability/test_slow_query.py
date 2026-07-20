"""A10 K44 — slow_query module + admin payload shape."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _reset():
    from eden.observability.slow_query import reset_for_tests

    reset_for_tests()
    yield
    reset_for_tests()


def test_record_below_threshold_ignored() -> None:
    from eden.observability.slow_query import record_slow_query, slow_query_count

    ok = record_slow_query(
        org_id="org_a",
        fingerprint="SELECT 1",
        duration_ms=50.0,
        threshold_ms=200.0,
    )
    assert ok is False
    assert slow_query_count("org_a") == 0


def test_record_and_list_tenant_scoped() -> None:
    from eden.observability.slow_query import (
        admin_slow_queries_payload,
        list_slow_queries,
        record_slow_query,
        slow_query_count,
    )

    assert record_slow_query(
        org_id="org_a",
        fingerprint="SELECT * FROM traces WHERE org_id=$1",
        duration_ms=450.0,
        source="list_traces",
    )
    assert record_slow_query(
        org_id="org_b",
        fingerprint="SELECT * FROM jobs",
        duration_ms=300.0,
        source="list_jobs",
    )

    assert slow_query_count("org_a") == 1
    assert slow_query_count("org_b") == 1
    a_rows = list_slow_queries("org_a")
    assert len(a_rows) == 1
    assert a_rows[0]["fingerprint"].startswith("SELECT * FROM traces")

    payload = admin_slow_queries_payload("org_a")
    assert payload["available"] is True
    assert payload["slow_query_count"] == 1
    assert payload["org_id"] == "org_a"
    assert len(payload["events"]) == 1


def test_admin_route_wires_module() -> None:
    """Static: admin_status slow-queries uses slow_query module (no pg_stat)."""
    from pathlib import Path

    src = (
        Path(__file__).resolve().parents[3]
        / "src/eden/api/routes/admin_status.py"
    )
    text = src.read_text(encoding="utf-8")
    assert "admin_slow_queries_payload" in text
    assert "pg_stat_activity" not in text
