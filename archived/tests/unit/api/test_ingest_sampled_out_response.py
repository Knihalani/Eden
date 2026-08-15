"""The ingest API must report sampled-out events, not hide them in ``accepted``.

``accepted`` is the only number the SDK gets back. While sampled-out
events were folded into it, the count Eden returned was larger than the
number of events it had stored, could show in the UI, or would bill for —
and nothing in the response said why.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

_ORG = "00000000-0000-0000-0000-000000000099"

_EVENT = {
    "event_id": "evt-sampled-1",
    "project_id": "default",
    "trace_id": "trace-sampled-1",
    "realm": "environment",
    "event_type": "llm.completion",
    "timestamp": "2026-07-20T00:00:00Z",
}


@pytest.fixture
def collector() -> AsyncMock:
    return AsyncMock()


@pytest.fixture
def ingest_client(api_client: TestClient, collector, monkeypatch):
    """``api_client`` with auth overridden and the collector stubbed."""
    from eden.api.app import app
    from eden.api.deps import get_ingest_auth
    from eden.api.routes import observability as obs_module
    from eden.observability import telemetry_collector as tc_module

    async def _get():
        return collector

    monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(obs_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(obs_module, "_get_collector", _get)
    app.dependency_overrides[get_ingest_auth] = lambda: {
        "org_id": _ORG,
        "scopes": ["ingest:write"],
        "key_id": "key-abc",
    }
    api_client.cookies.clear()
    try:
        yield api_client
    finally:
        app.dependency_overrides.pop(get_ingest_auth, None)


def test_batch_response_reports_sampled_out(ingest_client, collector) -> None:
    collector.ingest_batch = AsyncMock(
        return_value={
            "accepted": 2,
            "rejected": 0,
            "deduplicated": 0,
            "sampled_out": 8,
            "total": 10,
        }
    )
    response = ingest_client.post(
        f"/orgs/{_ORG}/observability/telemetry/ingest/batch",
        json={"events": [_EVENT]},
        headers={"X-Org-Id": _ORG, "X-Org-Api-Key": "k"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sampled_out"] == 8
    assert body["accepted"] == 2, (
        "accepted must be what Eden stored, not what it was sent"
    )
    assert (
        body["accepted"] + body["sampled_out"] + body["rejected"]
        + body["deduplicated"]
        == body["total"]
    )


def test_single_response_reports_sampled_out(ingest_client, collector) -> None:
    collector.ingest_one = AsyncMock(
        return_value={
            "accepted": 0,
            "rejected": 0,
            "deduplicated": 0,
            "sampled_out": 1,
            "total": 1,
        }
    )
    response = ingest_client.post(
        f"/orgs/{_ORG}/observability/telemetry/ingest",
        json=_EVENT,
        headers={"X-Org-Id": _ORG, "X-Org-Api-Key": "k"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {
        "accepted": 0,
        "rejected": 0,
        "deduplicated": 0,
        "sampled_out": 1,
        "total": 1,
    }


def test_single_failure_is_not_counted_twice(ingest_client, collector) -> None:
    """A deduplicated event is *only* deduplicated.

    The old route body set ``deduplicated`` and ``rejected`` from the same
    bool, so one non-stored event came back as two.
    """
    collector.ingest_one = AsyncMock(
        return_value={
            "accepted": 0,
            "rejected": 0,
            "deduplicated": 1,
            "sampled_out": 0,
            "total": 1,
        }
    )
    response = ingest_client.post(
        f"/orgs/{_ORG}/observability/telemetry/ingest",
        json=_EVENT,
        headers={"X-Org-Id": _ORG, "X-Org-Api-Key": "k"},
    )
    body = response.json()
    assert body["deduplicated"] == 1
    assert body["rejected"] == 0
    assert (
        body["accepted"] + body["rejected"] + body["deduplicated"]
        + body["sampled_out"]
        == 1
    )


def test_field_is_optional_for_old_collectors(ingest_client, collector) -> None:
    """A four-field body still validates — existing clients are unaffected."""
    collector.ingest_batch = AsyncMock(
        return_value={
            "accepted": 1,
            "rejected": 0,
            "deduplicated": 0,
            "total": 1,
        }
    )
    response = ingest_client.post(
        f"/orgs/{_ORG}/observability/telemetry/ingest/batch",
        json={"events": [_EVENT]},
        headers={"X-Org-Id": _ORG, "X-Org-Api-Key": "k"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["sampled_out"] == 0


def test_multi_format_ingest_response_carries_sampled_out() -> None:
    """``/ingest/{format}`` shares the same accounting."""
    from eden.api.routes.ingestion import IngestResponse

    model = IngestResponse(
        accepted=3, rejected=0, deduplicated=0, sampled_out=7, total=10,
        source_format="otel",
    )
    assert model.sampled_out == 7
    # Defaulted, so a decoder path that does not sample still validates.
    assert IngestResponse(source_format="otel").sampled_out == 0
