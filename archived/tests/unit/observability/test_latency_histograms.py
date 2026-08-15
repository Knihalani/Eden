"""Admin latency-histograms endpoint — §11.1 percentiles from buckets.

Mirrors ``test_slow_query.py``: static auth-shape assertions on the
route source plus unit tests that seed the middleware histogram via
``observe`` and assert the payload shape / percentile plausibility.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException


@pytest.fixture(autouse=True)
def _reset():
    from eden.api.middleware.latency import reset_metrics_snapshot

    reset_metrics_snapshot()
    yield
    reset_metrics_snapshot()


def _observe(method: str, route: str, status: int, latency_ms: float) -> None:
    # The endpoint reads the process-wide singleton behind
    # get_metrics_snapshot(); seed it the same way the middleware does.
    from eden.api.middleware import latency

    latency._histogram.observe(method, route, status, latency_ms)


def test_admin_route_requires_org_admin() -> None:
    """Static: the endpoint sits on the admin router with the same
    auth dependencies as its /slow-queries sibling."""
    from pathlib import Path

    src = (
        Path(__file__).resolve().parents[3]
        / "src/eden/api/routes/admin_status.py"
    )
    text = src.read_text(encoding="utf-8")
    assert '@router.get("/latency-histograms")' in text
    # Isolate the handler body (up to the next route decorator) and
    # check it carries the admin auth pattern.
    handler = text.split('@router.get("/latency-histograms")', 1)[1]
    handler = handler.split("@router.", 1)[0]
    assert "Depends(require_path_org_access)" in handler
    assert "Depends(require_org_admin)" in handler
    assert "_assert_path_org(org_id, org)" in handler


async def test_rejects_cross_org_path() -> None:
    """Token org must match the path org — 403 otherwise."""
    from eden.api.routes.admin_status import latency_histograms

    with pytest.raises(HTTPException) as exc:
        await latency_histograms(org_id="org_a", org={"org_id": "org_b"})
    assert exc.value.status_code == 403


async def test_payload_shape_and_percentiles() -> None:
    from eden.api.routes.admin_status import latency_histograms

    # 90 fast (8ms), 9 medium (180ms), 1 slow (450ms) → count=100.
    for _ in range(90):
        _observe("GET", "/v1/things", 200, 8.0)
    for _ in range(9):
        _observe("GET", "/v1/things", 200, 180.0)
    _observe("GET", "/v1/things", 200, 450.0)
    _observe("POST", "/v1/things", 201, 40.0)

    payload = await latency_histograms(org_id="org_a", org={"org_id": "org_a"})

    assert payload["org_id"] == "org_a"
    assert isinstance(payload["buckets_ms"], list) and payload["buckets_ms"]
    assert "note" in payload

    rows = payload["routes"]
    assert {(r["method"], r["route"]) for r in rows} == {
        ("GET", "/v1/things"),
        ("POST", "/v1/things"),
    }
    get_row = next(r for r in rows if r["method"] == "GET")
    assert set(get_row) == {"method", "route", "count", "p50_ms", "p95_ms", "p99_ms"}
    assert get_row["count"] == 100

    # Plausibility: percentiles land in the right buckets and are ordered.
    # p50 of 90x8ms falls in the (5, 10] bucket; p95 in (100, 200];
    # p99 at most the 500ms bound that captures the 450ms outlier.
    assert 5.0 < get_row["p50_ms"] <= 10.0
    assert 100.0 < get_row["p95_ms"] <= 200.0
    assert get_row["p99_ms"] <= 500.0
    assert get_row["p50_ms"] <= get_row["p95_ms"] <= get_row["p99_ms"]

    post_row = next(r for r in rows if r["method"] == "POST")
    assert post_row["count"] == 1
    # Single 40ms observation: every percentile in the (25, 50] bucket.
    for key in ("p50_ms", "p95_ms", "p99_ms"):
        assert 25.0 < post_row[key] <= 50.0


async def test_empty_histogram_returns_no_routes() -> None:
    from eden.api.routes.admin_status import latency_histograms

    payload = await latency_histograms(org_id="org_a", org={"org_id": "org_a"})
    assert payload["routes"] == []


def test_percentile_clamps_inf_bucket_to_highest_finite_bound() -> None:
    """Observations beyond the last bucket clamp — never fabricated."""
    from eden.api.routes.admin_status import _percentile_from_buckets

    buckets_ms = [5, 10, 25, 50, 100, 200, 500, 1000, 2500, 5000, 10000]
    row = {str(b): 0.0 for b in buckets_ms} | {"+Inf": 3.0}
    assert _percentile_from_buckets(buckets_ms, row, 3.0, 0.50) == 10000.0
    # Zero observations → no percentile, not a fake zero.
    assert _percentile_from_buckets(buckets_ms, row, 0.0, 0.50) is None
