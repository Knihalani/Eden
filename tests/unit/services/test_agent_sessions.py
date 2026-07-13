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
