"""B9 — acknowledge_alerts_batch uses one SQL UPDATE with ANY(...)."""

from __future__ import annotations

import inspect
import textwrap
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from eden.api.deps import get_current_user
from eden.api.routes import replay


def test_acknowledge_batch_source_uses_single_any_update() -> None:
    source = textwrap.dedent(inspect.getsource(replay.acknowledge_alerts_batch))
    non_comment = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("#")
    )
    assert "ANY($1::uuid[])" in non_comment
    assert "RETURNING id" in non_comment
    assert "for alert_id in req.alert_ids:" not in non_comment


@pytest.mark.asyncio
async def test_acknowledge_alerts_batch_single_sql(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    id1, id2 = str(uuid.uuid4()), str(uuid.uuid4())
    fetch_calls: list[tuple[str, tuple[Any, ...]]] = []

    client = MagicMock()

    async def _fetch(sql: str, *args: Any) -> list[dict[str, str]]:
        fetch_calls.append((sql, args))
        return [{"id": id1}, {"id": id2}]

    client.fetch = _fetch

    async def _get_pg() -> MagicMock:
        return client

    processor = MagicMock()
    processor.acknowledge_alert = AsyncMock(return_value=True)

    monkeypatch.setattr(replay, "get_postgres_client", _get_pg)
    monkeypatch.setattr(
        replay, "get_alert_processor", AsyncMock(return_value=processor)
    )

    application = FastAPI()
    application.dependency_overrides[get_current_user] = lambda: {
        "sub": "clerk_u1",
        "user_id": "user-1",
    }
    application.dependency_overrides[replay.require_path_org_access] = (
        lambda: "org-eden-1"
    )
    application.dependency_overrides[replay._eden_user_id] = lambda: "user-1"
    application.include_router(replay.router)

    id3 = str(uuid.uuid4())
    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        resp = await http.post(
            "/orgs/org_clerk/alerts/acknowledge-batch",
            json={"alert_ids": [id1, id2, id3]},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "status": "ok",
        "acknowledged_count": 2,
        "alert_ids": [id1, id2],
    }
    assert len(fetch_calls) == 1
    sql, args = fetch_calls[0]
    assert "ANY($1::uuid[])" in sql
    assert "RETURNING id" in sql
    assert args[0] == [id1, id2, id3]
    assert args[1] == "user-1"
    assert args[2] == "org-eden-1"
    assert processor.acknowledge_alert.await_count == 2
