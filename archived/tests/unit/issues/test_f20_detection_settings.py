"""F20 — per-org detection settings + task_failure session path."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest


class _SettingsPG:
    def __init__(self, settings: dict[str, Any] | None = None) -> None:
        self.settings = settings or {}

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        if "FROM organizations" in sql:
            return {"settings": dict(self.settings)}
        return None

    async def execute(self, sql: str, *args: Any) -> str:
        if "UPDATE organizations" in sql:
            self.settings = json.loads(args[0])
        return "OK"


@pytest.mark.asyncio
async def test_resolve_profile_defaults_to_standard() -> None:
    from eden.issues import detection_settings as ds

    ds._clear_cache()
    pg = _SettingsPG({})
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        assert await ds.resolve_profile("org1") == "standard"


@pytest.mark.asyncio
async def test_set_and_get_detection_profile() -> None:
    from eden.issues import detection_settings as ds

    ds._clear_cache()
    pg = _SettingsPG({})
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        out = await ds.set_detection_settings("org2", detection_profile="minimal")
        assert out["detection_profile"] == "minimal"
        ds._clear_cache()
        assert await ds.resolve_profile("org2") == "minimal"
    assert pg.settings["detection"]["detection_profile"] == "minimal"


@pytest.mark.asyncio
async def test_invalid_profile_rejected() -> None:
    from eden.issues import detection_settings as ds

    ds._clear_cache()
    pg = _SettingsPG({})
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        with pytest.raises(ValueError):
            await ds.set_detection_settings("org3", detection_profile="bogus")


@pytest.mark.asyncio
async def test_auto_issue_detection_default_true() -> None:
    from eden.config import get_settings

    assert get_settings().auto_issue_detection_v1 is True


@pytest.mark.asyncio
async def test_session_failure_writes_task_failure_stumble() -> None:
    from eden.services.agent_sessions import AgentSession, AgentSessionService

    captured: list[Any] = []

    class _Writer:
        async def create(self, sc: Any) -> dict[str, Any]:
            captured.append(sc)
            return {"stumble_id": "s", "inserted": True, "issue": None}

    svc = AgentSessionService(pg=None)
    session = AgentSession(
        id="sess-1",
        org_id="org",
        agent_id="agent-a",
        user_id="u1",
        trace_ids=["trace-x"],
        success=False,
        failure_reason="ran out of retries",
    )
    with patch("eden.issues.stumble_writer.StumbleWriter", return_value=_Writer()):
        await svc._emit_task_failure("org", session)

    assert len(captured) == 1
    sc = captured[0]
    assert sc.kind == "task_failure"
    assert sc.trace_id == "trace-x"
    assert sc.detail["failure_reason"] == "ran out of retries"
