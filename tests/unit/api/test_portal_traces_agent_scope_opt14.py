"""OPT-14 — /traces must support server-side agent scoping.

Previously the Agents detail page fetched the org-wide, unscoped,
most-recent-50/24h trace list and did ``.filter(t => t.agentId ===
agent.id)`` client-side. An agent whose activity is older than the
org's most-recent 50 traces then rendered an empty run list even
though it genuinely had runs. This guards the real fix: ``agent_id``
is a first-class query param that scopes the SQL itself.
"""

from __future__ import annotations

import inspect
from unittest.mock import AsyncMock, patch

import pytest

from eden.api.routes import portal as portal_mod


def test_list_portal_traces_accepts_agent_id_param():
    sig = inspect.signature(portal_mod.list_portal_traces)
    assert "agent_id" in sig.parameters


def test_list_portal_traces_sql_filters_by_resolved_agent_id():
    src = inspect.getsource(portal_mod.list_portal_traces)
    # Filter must apply to the *preferred* (alias-collapsed) agent_id,
    # matching the id the /agents cards show — not a raw per-event label.
    assert "trace_agent AS (" in src
    assert "$4::text IS NULL OR agent_id = $4" in src


class _FakeClient:
    """Routed by SQL shape; returns two traces on two different agents."""

    def __init__(self):
        self.fetch_calls: list[tuple[str, tuple]] = []

    async def fetch(self, query: str, *args):
        self.fetch_calls.append((query, args))
        if "FROM telemetry_events e" in query and "INNER JOIN ids" in query:
            agent_id = args[3] if len(args) > 3 else None
            rows = [
                {
                    "trace_id": "t-agent-a",
                    "agent_id": "agent-a",
                    "name": "run a",
                    "started_at": "2026-08-05T00:00:00+00:00",
                    "outcome": "ok",
                    "duration_ms": 100,
                    "tokens": 10,
                    "input_tokens": 5,
                    "output_tokens": 5,
                    "cost_usd": 0.01,
                    "model": "gpt-4o",
                    "session_id": None,
                    "error_detail": None,
                },
                {
                    "trace_id": "t-agent-b",
                    "agent_id": "agent-b",
                    "name": "run b",
                    "started_at": "2026-08-04T00:00:00+00:00",
                    "outcome": "ok",
                    "duration_ms": 200,
                    "tokens": 20,
                    "input_tokens": 10,
                    "output_tokens": 10,
                    "cost_usd": 0.02,
                    "model": "gpt-4o",
                    "session_id": None,
                    "error_detail": None,
                },
            ]
            if agent_id is None:
                return rows
            return [r for r in rows if r["agent_id"] == agent_id]
        raise AssertionError(f"unexpected query in fake client: {query[:120]}")


@pytest.mark.asyncio
async def test_agent_id_param_scopes_traces_server_side():
    fake = _FakeClient()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=fake),
    ):
        scoped = await portal_mod.list_portal_traces(
            org_id="org_1",
            window="24h",
            limit=50,
            agent_id="agent-a",
            participant_agent_id=None,
            _user={"sub": "u1"},
        )
        unscoped = await portal_mod.list_portal_traces(
            org_id="org_1",
            window="24h",
            limit=50,
            agent_id=None,
            participant_agent_id=None,
            _user={"sub": "u1"},
        )

    assert [t.id for t in scoped] == ["t-agent-a"]
    assert {t.id for t in unscoped} == {"t-agent-a", "t-agent-b"}
    # Args: org_id, window_secs, limit, agent_id, participant_agent_id (FEAT-147).
    assert fake.fetch_calls[0][1][-2:] == ("agent-a", None)
    assert fake.fetch_calls[1][1][-2:] == (None, None)
