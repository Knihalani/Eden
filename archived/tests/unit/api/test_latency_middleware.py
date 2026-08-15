"""Tests for the §11.1 latency middleware.

Covers:
- Histogram observe records a row with sensible bucket distribution
- ``X-Response-Time-Ms`` header is set on every response
- The snapshot is JSON-serializable so the alerts engine can
  consume it
- /health doesn't get instrumented into one giant row per request
  (the histogram buckets by *route template*, not literal path)
"""

import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.testclient import TestClient

from eden.api.middleware.latency import (
    LatencyHistogram,
    LatencyMiddleware,
    get_metrics_snapshot,
    reset_metrics_snapshot,
)


def _build_app():
    from fastapi import FastAPI
    app = FastAPI()
    app.add_middleware(LatencyMiddleware)

    @app.get("/v1/jobs")
    def jobs():
        return {"jobs": []}

    @app.get("/v1/jobs/{job_id}")
    def job(job_id: str):
        return {"id": job_id}

    @app.post("/v1/environments")
    def create_env():
        return {"id": "env-1"}

    return app


def test_histogram_observe_records_buckets():
    """The histogram is cumulative (Prometheus-style): bucket "N"
    counts all observations with latency <= N. So a 50ms sample
    increments bucket 50, 100, 200, ... +Inf."""
    h = LatencyHistogram()
    h.observe("GET", "/v1/jobs", 200, 50.0)
    h.observe("GET", "/v1/jobs", 200, 150.0)
    h.observe("GET", "/v1/jobs", 200, 600.0)
    snap = h.snapshot()
    row = next(r for r in snap["rows"] if r["method"] == "GET" and r["route"] == "/v1/jobs")
    assert row["count"] == 3
    assert row["sum_ms"] == 800.0
    # Cumulative: bucket "50" → only the 50ms sample
    assert row["buckets"]["50"] == 1
    # bucket "100" → 50ms only (150ms is > 100)
    assert row["buckets"]["100"] == 1
    # bucket "200" → 50ms + 150ms
    assert row["buckets"]["200"] == 2
    # bucket "1000" → all three
    assert row["buckets"]["1000"] == 3
    assert row["buckets"]["+Inf"] == 3


def test_histogram_snapshot_is_json_serializable():
    import json
    h = LatencyHistogram()
    h.observe("GET", "/v1/jobs", 200, 50.0)
    snap = h.snapshot()
    json.dumps(snap)  # should not raise


def test_latency_header_is_set():
    reset_metrics_snapshot()
    app = _build_app()
    client = TestClient(app)
    r = client.get("/v1/jobs")
    assert r.status_code == 200
    assert "X-Response-Time-Ms" in r.headers
    assert float(r.headers["X-Response-Time-Ms"]) > 0


def test_route_template_buckets_by_template_not_literal_path():
    """Different job IDs should land in the same histogram row."""
    reset_metrics_snapshot()
    app = _build_app()
    client = TestClient(app)
    client.get("/v1/jobs/job-a")
    client.get("/v1/jobs/job-b")
    client.get("/v1/jobs/job-c")
    snap = get_metrics_snapshot()
    routes = {r["route"] for r in snap["rows"]}
    # All three calls hit the same route template
    assert "/v1/jobs/{job_id}" in routes
    assert "/v1/jobs/job-a" not in routes
    assert "/v1/jobs/job-b" not in routes
    row = next(r for r in snap["rows"] if r["route"] == "/v1/jobs/{job_id}")
    assert row["count"] == 3


def test_post_endpoint_recorded_separately_from_get():
    reset_metrics_snapshot()
    app = _build_app()
    client = TestClient(app)
    client.get("/v1/jobs")
    client.post("/v1/environments")
    snap = get_metrics_snapshot()
    methods = {(r["method"], r["route"]) for r in snap["rows"]}
    assert ("GET", "/v1/jobs") in methods
    assert ("POST", "/v1/environments") in methods
