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


# ── FEAT-65: cross-agent delegation-chain traversal ─────────────────────


def _events_with_delegation_attrs() -> list[dict[str, Any]]:
    """Child-trace events; the root span carries A2A delegation metadata."""
    return [
        {
            "span_id": "child-span-a",
            "parent_span_id": None,
            "event_type": "agent.start",
            "name": "start",
            "outcome": "error",
            "error": {"type": "ToolError"},
            "attributes": {
                "parent_agent_span_id": "parent-span-x",
                "child_agent_trace_id": "trace-child",
                "a2a": {
                    "invocation_type": "a2a.send_message",
                    "parent_agent_id": "agent-parent",
                    "child_agent_id": "agent-child",
                    "response_status": "failed",
                },
            },
        },
    ]


def _parent_link_row(
    *,
    parent_trace_id: str = "trace-parent",
    parent_span_id: str = "parent-span-x",
    response_status: str = "failed",
    error_kind: str | None = "downstream_error",
) -> dict[str, Any]:
    return {
        "parent_trace_id": parent_trace_id,
        "child_trace_id": "trace-child",
        "parent_agent_id": "agent-parent",
        "child_agent_id": "agent-child",
        "parent_span_id": parent_span_id,
        "invocation_type": "a2a.send_message",
        "response_status": response_status,
        "error_kind": error_kind,
    }


def test_rca_chain_surfaces_per_event_delegation_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Attributes-carried ``parent_agent_span_id`` / ``a2a.*`` show up on
    the chain node so a UI can render delegation context even without an
    ``a2a_links`` row."""
    monkeypatch.setattr(get_settings(), "intelligence_gap_v0", True, raising=False)
    evs = _events_with_delegation_attrs()
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
        patch(
            "eden.api.routes.intelligence_rca._a2a.get_links_for_trace",
            AsyncMock(return_value={"parent": [], "children": []}),
        ),
    ):
        client = TestClient(_app())
        resp = client.get("/orgs/org_1/intelligence/rca/trace-child/chain")

    assert resp.status_code == 200
    data = resp.json()["data"]
    node = data["causal_chain"][0]
    assert node["delegation"] == {
        "parent_agent_span_id": "parent-span-x",
        "child_agent_trace_id": "trace-child",
        "parent_agent_id": "agent-parent",
        "child_agent_id": "agent-child",
        "invocation_type": "a2a.send_message",
    }
    # No a2a_links row -> no cross-trace ancestors to walk.
    assert data["delegation_chain"] == []
    assert data["cross_agent_root_cause"] == {
        "trace_id": "trace-child",
        "span_id": data["root_cause_span_id"],
    }


def test_rca_chain_walks_delegation_ancestor_and_flags_propagated_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failing child-agent span's ``a2a_links`` parent row is walked to
    the parent agent's trace; the parent's own delegating span also shows
    an error, so the blast radius is recorded as having propagated
    upward and ``cross_agent_root_cause`` points at the parent."""
    monkeypatch.setattr(get_settings(), "intelligence_gap_v0", True, raising=False)
    child_events = _events_with_delegation_attrs()
    parent_events = [
        {
            "span_id": "parent-span-x",
            "parent_span_id": None,
            "event_type": "agent.delegate",
            "name": "delegate_to_child",
            "outcome": "error",
            "error": {"type": "DelegationFailed"},
        },
    ]

    async def _fake_fetch_events(
        org_id: str, trace_id: str, *, thin: bool = False, **_: Any
    ) -> list[dict[str, Any]]:
        if trace_id == "trace-child":
            return child_events
        if trace_id == "trace-parent":
            return parent_events
        return []

    with (
        patch(
            "eden.api.routes.intelligence_rca._fetch_trace_events",
            _fake_fetch_events,
        ),
        patch(
            "eden.insights.rca.analyzer._fetch_trace_events",
            AsyncMock(return_value=child_events),
        ),
        patch(
            "eden.insights.rca.analyzer._fetch_judge_scores",
            AsyncMock(return_value=[]),
        ),
        patch(
            "eden.insights.rca.analyzer._delete_then_insert_rca",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.api.routes.intelligence_rca._a2a.get_links_for_trace",
            AsyncMock(
                side_effect=lambda trace_id, org_id=None: (
                    {"parent": [_parent_link_row()], "children": []}
                    if trace_id == "trace-child"
                    else {"parent": [], "children": []}
                )
            ),
        ),
    ):
        client = TestClient(_app())
        resp = client.get("/orgs/org_1/intelligence/rca/trace-child/chain")

    assert resp.status_code == 200
    data = resp.json()["data"]

    delegation_chain = data["delegation_chain"]
    assert len(delegation_chain) == 1
    hop = delegation_chain[0]
    assert hop["trace_id"] == "trace-parent"
    assert hop["span_id"] == "parent-span-x"
    assert hop["parent_agent_id"] == "agent-parent"
    assert hop["child_agent_id"] == "agent-child"
    assert hop["error_kind"] == "downstream_error"
    assert hop["delegating_span_failed"] is True
    assert hop["delegating_span_error_type"] == "DelegationFailed"

    # The parent agent's own delegating span also failed -> the incident's
    # practical origin is walked back to the parent, not the local trace.
    assert data["cross_agent_root_cause"] == {
        "trace_id": "trace-parent",
        "span_id": "parent-span-x",
    }


def test_rca_chain_delegation_ancestor_healthy_keeps_local_root_cause(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If the parent's delegating span did NOT itself fail, the local
    trace's own root-cause span remains authoritative."""
    monkeypatch.setattr(get_settings(), "intelligence_gap_v0", True, raising=False)
    child_events = _events_with_delegation_attrs()
    healthy_parent_events = [
        {
            "span_id": "parent-span-x",
            "parent_span_id": None,
            "event_type": "agent.delegate",
            "name": "delegate_to_child",
            "outcome": "ok",
            "error": None,
        },
    ]

    async def _fake_fetch_events(
        org_id: str, trace_id: str, *, thin: bool = False, **_: Any
    ) -> list[dict[str, Any]]:
        if trace_id == "trace-child":
            return child_events
        if trace_id == "trace-parent":
            return healthy_parent_events
        return []

    with (
        patch(
            "eden.api.routes.intelligence_rca._fetch_trace_events",
            _fake_fetch_events,
        ),
        patch(
            "eden.insights.rca.analyzer._fetch_trace_events",
            AsyncMock(return_value=child_events),
        ),
        patch(
            "eden.insights.rca.analyzer._fetch_judge_scores",
            AsyncMock(return_value=[]),
        ),
        patch(
            "eden.insights.rca.analyzer._delete_then_insert_rca",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.api.routes.intelligence_rca._a2a.get_links_for_trace",
            AsyncMock(
                side_effect=lambda trace_id, org_id=None: (
                    {
                        "parent": [
                            _parent_link_row(
                                response_status="ok", error_kind=None
                            )
                        ],
                        "children": [],
                    }
                    if trace_id == "trace-child"
                    else {"parent": [], "children": []}
                )
            ),
        ),
    ):
        client = TestClient(_app())
        resp = client.get("/orgs/org_1/intelligence/rca/trace-child/chain")

    assert resp.status_code == 200
    data = resp.json()["data"]

    hop = data["delegation_chain"][0]
    assert hop["delegating_span_failed"] is False

    assert data["cross_agent_root_cause"] == {
        "trace_id": "trace-child",
        "span_id": data["root_cause_span_id"],
    }
    assert data["root_cause_span_id"] == "child-span-a"
