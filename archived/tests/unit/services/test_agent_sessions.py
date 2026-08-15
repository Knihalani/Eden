"""Unit tests for F23 agent sessions service."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from eden.services.agent_sessions import AgentSession, AgentSessionService, _as_timestamptz


@pytest.mark.asyncio
async def test_session_lifecycle_memory() -> None:
    svc = AgentSessionService()
    started = await svc.start("org-1", agent_id="bot", user_id="u-1")
    await svc.attach_trace("org-1", started.id, "trace-1")
    ended = await svc.complete(
        "org-1", started.id, success=False, failure_reason="abandoned"
    )
    assert ended is not None
    assert ended.success is False
    assert "trace-1" in ended.trace_ids
    loaded = await svc.get("org-1", started.id)
    assert loaded is not None
    assert loaded.failure_reason == "abandoned"


@pytest.mark.asyncio
async def test_attach_traces_single_persist() -> None:
    svc = AgentSessionService()
    started = await svc.start("org-1", agent_id="bot")
    persist_calls = 0
    orig = svc._persist

    async def _count(session: object) -> None:
        nonlocal persist_calls
        persist_calls += 1
        await orig(session)

    svc._persist = _count  # type: ignore[method-assign]
    added = await svc.attach_traces(
        "org-1", started.id, ["a", "b", "a", "c"]
    )
    assert added == 3
    assert persist_calls == 1
    loaded = await svc.get("org-1", started.id)
    assert loaded is not None
    assert loaded.trace_ids == ["a", "b", "c"]


def test_as_timestamptz_coerces_iso_strings() -> None:
    dt = _as_timestamptz("2026-07-20T23:21:59.762126+00:00")
    assert isinstance(dt, datetime)
    assert dt.tzinfo is not None
    assert _as_timestamptz("2026-07-20T23:21:59.762126Z") is not None
    assert _as_timestamptz(None) is None
    aware = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)
    assert _as_timestamptz(aware) is aware


@pytest.mark.asyncio
async def test_persist_binds_datetime_not_iso_string() -> None:
    """Regression: asyncpg rejects ISO strings for timestamptz (prod 503)."""
    captured: dict[str, Any] = {}

    class _FakePg:
        async def execute(self, _query: str, *args: Any) -> str:
            captured["args"] = args
            return "OK"

    svc = AgentSessionService(pg=_FakePg())
    session = AgentSession(
        id="11111111-1111-1111-1111-111111111111",
        org_id="org-1",
        agent_id="bot",
        started_at="2026-07-20T23:21:59.762126+00:00",
        ended_at=None,
    )
    await svc._persist(session)
    args = captured["args"]
    assert isinstance(args[8], datetime), f"started_at bound as {type(args[8])}"
    assert args[9] is None
