"""RCA per-trace chain endpoint — implicated span_ids + ordered causal chain.

The engine (``RootCauseAnalyzer``) is reused for the failure category; the
route overlays a deep-linkable span chain derived from the trace's events.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_path_org_access
from eden.config import get_settings


def _events() -> list[dict[str, Any]]:
    return [
        {
            "span_id": "span-a",
            "parent_span_id": None,
            "event_type": "agent.start",
            "name": "start",
            "outcome": "ok",
            "error": None,
        },
        {
            "span_id": "span-b",
            "parent_span_id": "span-a",
            "event_type": "tool.call",
            "name": "search",
            "outcome": "error",
            "error": {"type": "Timeout"},
        },
        {
            "span_id": "span-c",
            "parent_span_id": "span-a",
            "event_type": "tool.call",
            "name": "fetch",
            "outcome": "error",
            "error": {"type": "HTTP500"},
        },
    ]


def _app() -> FastAPI:
    from eden.api.routes import intelligence_rca as rca_routes

    app = FastAPI()

    async def _fake_user() -> dict[str, Any]:
        return {"id": "u1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_path_org_access] = _path_org
    app.include_router(rca_routes.router)
    return app


def test_rca_chain_returns_ordered_chain_with_span_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(get_settings(), "intelligence_gap_v0", True, raising=False)
    evs = _events()
    with (
        patch(
            "eden.api.routes.intelligence_rca._fetch_trace_events",
            AsyncMock(return_value=evs),
        ),
        patch(
            "eden.insights.rca.analyzer._fetch_trace_events",
            AsyncMock(return_value=evs),
        ),
        patch(
            "eden.insights.rca.analyzer._fetch_judge_scores",
            AsyncMock(return_value=[]),
        ),
        patch(
            "eden.insights.rca.analyzer._delete_then_insert_rca",
            AsyncMock(return_value=None),
        ),
    ):
        client = TestClient(_app())
        resp = client.get("/orgs/org_1/intelligence/rca/trace-1/chain")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    data = body["data"]

    # Implicated spans (both failing tool calls), deep-link ready + ordered.
    assert data["implicated_span_ids"] == ["span-b", "span-c"]
    assert data["root_cause_span_id"] == "span-b"

    # Ordered causal chain: one node per event, steps monotonically increasing.
    chain = data["causal_chain"]
    assert [n["step"] for n in chain] == [0, 1, 2]
    assert [n["span_id"] for n in chain] == ["span-a", "span-b", "span-c"]
    assert chain[0]["implicated"] is False
    assert chain[1]["implicated"] is True
    assert chain[1]["error_type"] == "Timeout"
    assert chain[1]["parent_span_id"] == "span-a"

    # Category comes from the reused engine (tool error rule).
    assert data["category"] == "tool"
    assert data["span_count"] == 3


def test_rca_chain_missing_trace_is_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(get_settings(), "intelligence_gap_v0", True, raising=False)
    with patch(
        "eden.api.routes.intelligence_rca._fetch_trace_events",
        AsyncMock(return_value=[]),
    ):
        client = TestClient(_app())
        resp = client.get("/orgs/org_1/intelligence/rca/missing/chain")
    assert resp.status_code == 200
    assert resp.json()["status"] == "not_found"
