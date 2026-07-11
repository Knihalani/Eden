"""F48 — portal ↔ API autonomous contract repair (Wave 0, G3/G5).

The portal historically sent ``{question, trace_id?}`` while the API
required ``{trigger}`` → 422. The backend now accepts either and
resolves a trigger server-side. Also verifies the incident trigger
resolver queries ``incident_clusters.id`` (G5), not ``cluster_id``.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _make_client() -> tuple[TestClient, Any]:
    from eden.api.deps import get_current_user, require_org_member

    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: {
        "sub": "u1",
        "org_id": "org_test",
    }
    app.dependency_overrides[require_org_member] = lambda: {
        "sub": "u1",
        "org_id": "org_test",
    }

    import eden.api.routes.intelligence_autonomous as mod

    async def _flag_on() -> None:
        return None

    for r in mod.router.routes:
        if not hasattr(r, "dependant"):
            continue
        for d in r.dependant.dependencies:
            if d.call.__name__ == "_dependency":
                app.dependency_overrides[d.call] = _flag_on

    app.include_router(mod.router)
    return TestClient(app), mod


def test_investigate_accepts_trigger() -> None:
    client, mod = _make_client()
    captured: dict[str, Any] = {}

    async def _investigate(org_id: str, *, trigger: str) -> dict[str, Any]:
        captured["trigger"] = trigger
        return {"status": "ok", "live": True, "data": {"findings": []}}

    with patch.object(mod._investigator, "investigate", _investigate):
        r = client.post(
            "/orgs/org_test/intelligence/autonomous/investigate",
            json={"trigger": "incident:abc"},
        )
    assert r.status_code == 200
    assert captured["trigger"] == "incident:abc"


def test_investigate_resolves_trace_id_to_incident() -> None:
    client, mod = _make_client()
    captured: dict[str, Any] = {}

    async def _investigate(org_id: str, *, trigger: str) -> dict[str, Any]:
        captured["trigger"] = trigger
        return {"status": "ok", "live": True, "data": {"findings": []}}

    pg = MagicMock()
    pg.fetchrow = AsyncMock(return_value={"cluster_id": "clu_xyz"})

    with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
        with patch.object(mod._investigator, "investigate", _investigate):
            r = client.post(
                "/orgs/org_test/intelligence/autonomous/investigate",
                json={"trace_id": "trc_1", "question": "why fail?"},
            )
    assert r.status_code == 200
    assert captured["trigger"] == "incident:clu_xyz"


def test_investigate_without_trigger_or_trace_returns_needs_trigger() -> None:
    client, _mod = _make_client()
    r = client.post(
        "/orgs/org_test/intelligence/autonomous/investigate",
        json={"question": "why fail?"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "needs_trigger"
    assert body["data"]["findings"] == []


@pytest.mark.asyncio
async def test_incident_resolver_uses_id_column() -> None:
    """G5 — the incident trigger resolver must filter on
    ``incident_clusters.id`` (the table PK), not ``cluster_id``."""
    from eden.autonomous._common import _resolve_trigger_context

    seen: dict[str, str] = {}

    async def _fetchrow(sql: str, *args: Any) -> dict[str, Any] | None:
        if "incident_clusters" in sql:
            seen["sql"] = sql
            return {"id": "clu_abc", "severity": "high", "member_count": 12}
        return None

    pg = MagicMock()
    pg.fetchrow = AsyncMock(side_effect=_fetchrow)

    with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
        ctx = await _resolve_trigger_context("org_test", "incident:clu_abc")

    assert ctx is not None
    assert ctx["trigger_type"] == "incident"
    assert "WHERE org_id = $1 AND id = $2" in seen["sql"]
    assert "cluster_id" not in seen["sql"]
