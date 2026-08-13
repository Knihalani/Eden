"""FEAT-147 — filter traces by any participating agent (not just preferred).

``_PREFERRED_AGENT_ID_SQL`` collapses a trace to one display winner.
Investigators need ``participant_agent_id`` so a sub-delegate still
matches even when it is not that winner. ``participants`` is returned
as a facet; preferred ``agentId`` is unchanged.
"""

from __future__ import annotations

import inspect
from unittest.mock import AsyncMock, patch

import pytest

from eden.api.routes import portal as portal_mod



def _main_calls(fake):
    """Trace-list queries only — W4-6 added a trace_bookmarks enrichment
    query per list_portal_traces call, which shifts positional indexing."""
    return [c for c in fake.fetch_calls if "trace_bookmarks" not in c[0]]

def test_list_portal_traces_accepts_participant_agent_id_param():
    sig = inspect.signature(portal_mod.list_portal_traces)
    assert "participant_agent_id" in sig.parameters
    assert "agent_id" in sig.parameters


def test_list_portal_traces_sql_keeps_preferred_and_adds_participant_filter():
    src = inspect.getsource(portal_mod.list_portal_traces)
    assert "trace_agent AS (" in src
    # Preferred filter (OPT-14) still present.
    assert "$4::text IS NULL OR agent_id = $4" in src
    # Participant filter is a separate WHERE on any event agent_id.
    assert "$5::text IS NULL" in src
    assert "WHERE r.agent_id = $5" in src
    # Preferred display column + participants facet both selected.
    assert "AS participants" in src
    assert "{_PREFERRED_AGENT_ID_SQL}" in src
    assert "{_PARTICIPANT_AGENT_IDS_SQL_ALIASED}" in src
    # Constants exist and are distinct shapes.
    assert "ARRAY_AGG(agent_id" in portal_mod._PREFERRED_AGENT_ID_SQL
    assert "ARRAY_AGG(DISTINCT" in portal_mod._PARTICIPANT_AGENT_IDS_SQL_ALIASED


def test_participants_list_coerces_pg_array():
    assert portal_mod._participants_list(None) == []
    assert portal_mod._participants_list(["a", "b", None, ""]) == ["a", "b"]
    assert portal_mod._participants_list("solo") == ["solo"]


class _FakeClient:
    """Routes list SQL; participant filter matches any listed participant."""

    def __init__(self):
        self.fetch_calls: list[tuple[str, tuple]] = []

    async def fetch(self, query: str, *args):
        self.fetch_calls.append((query, args))
        if "FROM telemetry_events e" in query and "INNER JOIN ids" in query:
            preferred_filter = args[3] if len(args) > 3 else None
            participant_filter = args[4] if len(args) > 4 else None
            rows = [
                {
                    "trace_id": "t-primary-a",
                    "agent_id": "agent-a",
                    "participants": ["agent-a"],
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
                    # Preferred winner is agent-a; agent-b only participates.
                    "trace_id": "t-sub-b",
                    "agent_id": "agent-a",
                    "participants": ["agent-a", "agent-b"],
                    "name": "delegated run",
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
                {
                    "trace_id": "t-primary-b",
                    "agent_id": "agent-b",
                    "participants": ["agent-b"],
                    "name": "run b",
                    "started_at": "2026-08-03T00:00:00+00:00",
                    "outcome": "ok",
                    "duration_ms": 150,
                    "tokens": 15,
                    "input_tokens": 8,
                    "output_tokens": 7,
                    "cost_usd": 0.015,
                    "model": "gpt-4o",
                    "session_id": None,
                    "error_detail": None,
                },
            ]
            out = rows
            if preferred_filter is not None:
                out = [r for r in out if r["agent_id"] == preferred_filter]
            if participant_filter is not None:
                out = [
                    r
                    for r in out
                    if participant_filter in (r.get("participants") or [])
                ]
            return out
        raise AssertionError(f"unexpected query in fake client: {query[:120]}")


@pytest.mark.asyncio
async def test_participant_agent_id_includes_sub_delegate_traces():
    fake = _FakeClient()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=fake),
    ):
        # Preferred-only filter: agent-b's primary card only.
        preferred = await portal_mod.list_portal_traces(
            org_id="org_1",
            window="24h",
            limit=50,
            agent_id="agent-b",
            participant_agent_id=None,
            _user={"sub": "u1"},
        )
        # Participant filter: preferred primary + sub-delegate appearance.
        as_participant = await portal_mod.list_portal_traces(
            org_id="org_1",
            window="24h",
            limit=50,
            agent_id=None,
            participant_agent_id="agent-b",
            _user={"sub": "u1"},
        )

    assert [t.id for t in preferred] == ["t-primary-b"]
    assert {t.id for t in as_participant} == {"t-sub-b", "t-primary-b"}
    # Preferred display column unchanged on the sub-delegate hit.
    sub = next(t for t in as_participant if t.id == "t-sub-b")
    assert sub.agentId == "agent-a"
    assert "agent-b" in sub.participants
    assert _main_calls(fake)[0][1][3] == "agent-b"
    assert _main_calls(fake)[0][1][4] is None
    assert _main_calls(fake)[1][1][3] is None
    assert _main_calls(fake)[1][1][4] == "agent-b"
