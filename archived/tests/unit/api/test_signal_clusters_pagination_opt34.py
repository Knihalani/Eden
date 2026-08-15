"""OPT-34 — paginated signal cluster listing."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_path_org_access


class _FakePg:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.last_sql: str | None = None
        self.last_args: tuple[Any, ...] = ()

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        self.last_sql = " ".join(sql.split())
        self.last_args = args
        return self.rows


def _app() -> FastAPI:
    from eden.api.routes import signal_investigator as sig_routes

    app = FastAPI()

    async def _fake_user() -> dict[str, Any]:
        return {"id": "u1"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_path_org_access] = _path_org
    app.include_router(sig_routes.router)
    return app


def test_list_signal_clusters_default_pagination() -> None:
    pg = _FakePg([])
    with patch(
        "eden.api.routes.signal_investigator.get_postgres_client",
        AsyncMock(return_value=pg),
    ):
        client = TestClient(_app())
        resp = client.get("/orgs/org_1/signal-clusters")

    assert resp.status_code == 200
    body = resp.json()
    assert body["limit"] == 50
    assert body["offset"] == 0
    assert body["count"] == 0
    assert "LIMIT $3 OFFSET $4" in pg.last_sql
    assert pg.last_args[-2:] == (50, 0)


def test_list_signal_clusters_custom_limit_offset() -> None:
    pg = _FakePg(
        [
            {
                "id": "c1",
                "signal_id": "s1",
                "name": "cluster",
                "status": "open",
                "event_count": 3,
                "first_seen": None,
                "last_seen": None,
                "sample_trace_ids": [],
            }
        ]
    )
    with patch(
        "eden.api.routes.signal_investigator.get_postgres_client",
        AsyncMock(return_value=pg),
    ):
        client = TestClient(_app())
        resp = client.get(
            "/orgs/org_1/signal-clusters",
            params={"limit": 10, "offset": 20, "status": "all"},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["limit"] == 10
    assert body["offset"] == 20
    assert body["count"] == 1
    assert pg.last_args[-2:] == (10, 20)


def test_list_signal_clusters_rejects_limit_over_cap() -> None:
    with patch(
        "eden.api.routes.signal_investigator.get_postgres_client",
        AsyncMock(return_value=_FakePg([])),
    ):
        client = TestClient(_app())
        resp = client.get(
            "/orgs/org_1/signal-clusters", params={"limit": 500}
        )

    assert resp.status_code == 422
