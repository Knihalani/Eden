"""Unit tests for F23 agent sessions service."""

from __future__ import annotations

import pytest

from eden.services.agent_sessions import AgentSessionService


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
