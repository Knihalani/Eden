"""Tests for the visual-builder graph save/load API (§8.1).

End-to-end via the FastAPI TestClient with a stub postgres
client — matches the pattern used by ``test_agents_routes.py``
and other unit/api/* tests. Avoids requiring a real Postgres
connection in CI.
"""

from __future__ import annotations

import json
import uuid
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from eden.api.routes import builder_graphs


# ── Stub postgres client ──────────────────────────────────────────


class _StubPostgresClient:
    """In-memory stub for the slice of asyncpg the routes use.

    Persists builder_graphs as a ``dict[(org_id, name), row]``.
    Implements the four methods the route handler calls:
    ``fetch``, ``fetchrow``, ``execute``.
    """

    def __init__(self) -> None:
        self.graphs: dict[tuple[str, str], dict[str, Any]] = {}

    # The route handler passes ``uuid.UUID(org_id)`` as the first
    # arg; we coerce to str for dict lookups.
    @staticmethod
    def _k(*args):
        return tuple(str(a) for a in args)

    async def fetch(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        if "FROM builder_graphs" in q and "ORDER BY" in q and "SELECT id" in q:
            # list_builder_graphs
            org = str(args[0]) if args else None
            limit = kwargs.get("limit", 50)
            offset = kwargs.get("offset", 0)
            rows = sorted(
                (v for (oid, _), v in self.graphs.items() if oid == org),
                key=lambda r: r["updated_at"],
                reverse=True,
            )
            return rows[offset:offset + limit]
        if "RETURNING" in q and "INSERT INTO builder_graphs" in q:
            # upsert
            org_id = str(args[0])
            user_id = str(args[1]) if args[1] is not None else None
            name = args[2]
            graph_json = args[3]
            yaml = args[4]
            agent_id = args[5]
            key = (org_id, name)
            existing = self.graphs.get(key)
            now = "2026-06-14T12:00:00Z"
            row = {
                "id": str(existing["id"] if existing else uuid.uuid4()),
                "org_id": org_id,
                "user_id": user_id,
                "name": name,
                "graph": (
                    json.loads(graph_json)
                    if isinstance(graph_json, str)
                    else graph_json
                ),
                "yaml": yaml,
                "agent_id": agent_id,
                "created_at": existing["created_at"] if existing else now,
                "updated_at": now,
            }
            self.graphs[key] = row
            return [row]
        return []

    async def fetchrow(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        if "SELECT id FROM builder_graphs" in q:
            row = self.graphs.get((str(args[0]), str(args[1])))
            return {"id": row["id"]} if row else None
        if "SELECT count(*)" in q:
            org = str(args[0]) if args else None
            return {"c": sum(1 for (oid, _) in self.graphs if oid == org)}
        if (
            "FROM builder_graphs" in q
            and "WHERE org_id" in q
            and "name =" in q
        ):
            return self.graphs.get((str(args[0]), str(args[1])))
        if "SELECT user_id" in q:
            row = self.graphs.get((str(args[0]), str(args[1])))
            return {"user_id": row["user_id"]} if row else None
        return None

    async def execute(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        if "DELETE FROM builder_graphs" in q:
            self.graphs.pop((str(args[0]), str(args[1])), None)
            return "DELETE 1"
        return "OK"


# ── Test app fixture ───────────────────────────────────────────────


@pytest.fixture
def app():
    test_app = FastAPI()
    test_app.include_router(builder_graphs.router)

    from eden.api.deps import get_current_user

    org_id = str(uuid.uuid4())
    user_id = str(uuid.uuid4())
    test_app.state.org_id = org_id
    test_app.state.user_id = user_id

    async def fake_user():
        return {
            "user_id": user_id,
            "org_ids": [org_id],
            "role": "admin",
            "is_superuser": False,
            "auth_kind": "session",
        }

    test_app.dependency_overrides[get_current_user] = fake_user
    stub = _StubPostgresClient()

    # Patch the get_postgres_client name in the route module AND
    # the storage module so the route's ``from eden.storage.postgres
    # import get_postgres_client`` resolves to the stub.
    builder_graphs.get_postgres_client = AsyncMock(return_value=stub)
    from eden.storage import postgres as pg_module

    pg_module.get_postgres_client = AsyncMock(return_value=stub)

    return test_app, stub, org_id, user_id


@pytest.fixture
def client(app):
    test_app = app[0]
    return TestClient(test_app)


# ── Tests ──────────────────────────────────────────────────────────


def test_upsert_then_list_then_get(app, client):
    """End-to-end: create → list → get → update."""
    _, _, org_id, _ = app
    body = {
        "name": "Test Graph",
        "graph": {
            "nodes": [
                {
                    "id": "agent_1",
                    "type": "agent",
                    "position": {"x": 0, "y": 0},
                    "data": {
                        "kind": "agent",
                        "label": "Agent",
                        "name": "agent",
                        "framework": "langchain",
                    },
                }
            ],
            "edges": [],
        },
        "yaml": "target:\n  module: agent\n",
    }
    r = client.post(f"/orgs/{org_id}/builder/graphs", json=body)
    assert r.status_code == 200, r.text
    created = r.json()
    assert created["created"] is True
    assert created["graph"]["name"] == "Test Graph"
    graph_id = created["graph"]["id"]

    # 2. List
    r = client.get(f"/orgs/{org_id}/builder/graphs")
    assert r.status_code == 200
    listed = r.json()["graphs"]
    assert any(g["id"] == graph_id for g in listed)

    # 3. Get one
    r = client.get(f"/orgs/{org_id}/builder/graphs/Test Graph")
    assert r.status_code == 200
    assert r.json()["id"] == graph_id

    # 4. Upsert (update in place)
    body2 = dict(body)
    body2["yaml"] = "target:\n  module: agent\n  framework: openai\n"
    r = client.post(f"/orgs/{org_id}/builder/graphs", json=body2)
    assert r.status_code == 200
    assert r.json()["created"] is False
    assert r.json()["graph"]["yaml"] == body2["yaml"]


def test_delete(app, client):
    _, _, org_id, _ = app
    body = {
        "name": "Test",
        "graph": {"nodes": [], "edges": []},
    }
    r = client.post(f"/orgs/{org_id}/builder/graphs", json=body)
    assert r.status_code == 200

    r = client.delete(f"/orgs/{org_id}/builder/graphs/Test")
    assert r.status_code == 200
    assert r.json() == {"deleted": True, "name": "Test"}

    r = client.get(f"/orgs/{org_id}/builder/graphs/Test")
    assert r.status_code == 404


def test_validation_rejects_bad_graph(app, client):
    _, _, org_id, _ = app
    r = client.post(
        f"/orgs/{org_id}/builder/graphs",
        json={"name": "Bad", "graph": {"nodes": []}},
    )
    assert r.status_code == 400
    assert "edges" in r.text

    r = client.post(
        f"/orgs/{org_id}/builder/graphs",
        json={"name": "Bad", "graph": {"nodes": "not a list", "edges": []}},
    )
    assert r.status_code == 400


def test_non_member_403():
    """A user from a different org gets 403."""
    test_app = FastAPI()
    test_app.include_router(builder_graphs.router)

    from eden.api.deps import get_current_user

    async def fake_user():
        return {
            "user_id": str(uuid.uuid4()),
            "org_ids": [str(uuid.uuid4())],  # a different org
            "role": "admin",
            "is_superuser": False,
            "auth_kind": "session",
        }

    test_app.dependency_overrides[get_current_user] = fake_user
    stub = _StubPostgresClient()
    builder_graphs.get_postgres_client = AsyncMock(return_value=stub)
    from eden.storage import postgres as pg_module

    pg_module.get_postgres_client = AsyncMock(return_value=stub)
    c = TestClient(test_app)
    org_id = str(uuid.uuid4())
    r = c.get(f"/orgs/{org_id}/builder/graphs")
    assert r.status_code == 403


def test_delete_requires_creator_or_admin():
    """Creator and org admin can delete; other members 403."""
    test_app = FastAPI()
    test_app.include_router(builder_graphs.router)

    from eden.api.deps import get_current_user

    org_id = str(uuid.uuid4())
    creator_id = str(uuid.uuid4())
    other_user_id = str(uuid.uuid4())
    is_admin = [False]

    async def fake_user():
        return {
            "user_id": other_user_id,
            "org_ids": [org_id],
            "role": "admin" if is_admin[0] else "member",
            "is_superuser": False,
            "auth_kind": "session",
        }

    test_app.dependency_overrides[get_current_user] = fake_user
    stub = _StubPostgresClient()
    builder_graphs.get_postgres_client = AsyncMock(return_value=stub)
    from eden.storage import postgres as pg_module

    pg_module.get_postgres_client = AsyncMock(return_value=stub)
    c = TestClient(test_app)

    # Create the graph as the creator by temporarily overriding auth.
    test_app.dependency_overrides[get_current_user] = lambda: {
        "user_id": creator_id,
        "org_ids": [org_id],
        "role": "admin",
        "is_superuser": False,
        "auth_kind": "session",
    }
    r = c.post(
        f"/orgs/{org_id}/builder/graphs",
        json={
            "name": "Owned",
            "graph": {"nodes": [], "edges": []},
        },
    )
    assert r.status_code == 200

    # Switch back to non-creator non-admin.
    test_app.dependency_overrides[get_current_user] = fake_user
    is_admin[0] = False
    r = c.delete(f"/orgs/{org_id}/builder/graphs/Owned")
    assert r.status_code == 403

    # Org admin can delete.
    is_admin[0] = True
    r = c.delete(f"/orgs/{org_id}/builder/graphs/Owned")
    assert r.status_code == 200
