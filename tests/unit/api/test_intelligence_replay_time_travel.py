"""Server-side tests for the new replay + time-travel routes (Phase A.6/A.7):

  - POST /orgs/{org_id}/intelligence/replay/sessions     (replay session create)
  - POST /orgs/{org_id}/intelligence/time-travel/record  (snapshot record)

Both routes use feature-flag gating (``intelligence_gap_v0``) and
``get_current_user`` for auth, which we override in the fixture.
"""

from __future__ import annotations

from datetime import UTC, datetime, timezone
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from eden.api.routes import intelligence_replay, intelligence_time_travel

_NOW = datetime(2026, 6, 14, 0, 0, 0, tzinfo=UTC)


# ── Stub postgres client ──────────────────────────────────────────


class _StubPostgresClient:
    """In-memory stub for the two new routes.

    replay:
      - SELECT id, created_at FROM replay_sessions WHERE org=$1 AND trace=$2 AND name=$3
      - INSERT INTO replay_sessions ... RETURNING id, created_at

    time-travel:
      - INSERT INTO time_travel_forks ... RETURNING id, created_at
    """

    def __init__(self) -> None:
        # session_id → {org_id, trace_id, name, created_at}
        self.sessions: dict[str, dict[str, Any]] = {}
        # snapshot_id → {org_id, parent_trace_id, fork_at_step, name, created_at}
        self.snapshots: dict[str, dict[str, Any]] = {}

    async def fetchrow(self, query: str, *args, **kwargs):
        q = " ".join(query.split())

        if "SELECT id, created_at FROM replay_sessions" in q:
            org, trace, name = args
            for sid, s in self.sessions.items():
                if (s["org_id"] == org and s["trace_id"] == trace
                        and s["name"] == name):
                    return {"id": sid, "created_at": s["created_at"]}
            return None

        if "INSERT INTO replay_sessions" in q and "RETURNING" in q:
            sid, org, trace, name = args
            self.sessions[sid] = {
                "id": sid, "org_id": org, "trace_id": trace,
                "name": name, "created_at": _NOW,
            }
            return {"id": sid, "created_at": _NOW}

        if "INSERT INTO time_travel_forks" in q and "RETURNING" in q:
            # The route hardcodes fork_at_step = -1 in the SQL, so
            # only 4 params are passed: sid, org, trace, label.
            sid, org, trace, label = args
            self.snapshots[sid] = {
                "id": sid, "org_id": org, "parent_trace_id": trace,
                "fork_at_step": -1, "name": label, "created_at": _NOW,
            }
            return {"id": sid, "created_at": _NOW}

        return None

    async def fetch(self, query: str, *args, **kwargs):
        return []

    async def execute(self, query: str, *args, **kwargs):
        return None


# ── Test fixtures ───────────────────────────────────────────────


@pytest.fixture
def stub_pg():
    return _StubPostgresClient()


@pytest.fixture
def app(stub_pg, monkeypatch):
    """Build a FastAPI app with replay + time-travel routes and stubbed deps."""

    async def _get_pg():
        return stub_pg
    # Both routes import get_postgres_client inside the function body
    # (not at module scope) — patch eden.storage.postgres.get_postgres_client
    # so the runtime lookup returns our stub.
    from eden.storage import postgres as eden_postgres
    monkeypatch.setattr(eden_postgres, "get_postgres_client", _get_pg)

    async def _get_user():
        return {"user_id": "u-test", "email": "t@test.io", "org_id": "org-test"}

    # Bypass feature flag gating. The route uses a router-level
    # dependency built from ``require_feature_flag(flag_name)``, so the
    # dependency function is a closure baked in at import time. The
    # closure reads ``get_settings()`` at request time and raises 404
    # when the flag is off. Simplest fix: enable the flag on settings.
    from eden.api import deps as eden_deps

    class _FakeSettings:
        intelligence_gap_v0 = True
        # Other flags the closure may check
        experiments_v1 = True
    monkeypatch.setattr(eden_deps, "get_settings", lambda: _FakeSettings())

    app = FastAPI()
    app.include_router(intelligence_replay.router)
    app.include_router(intelligence_time_travel.router)
    # Override auth on the ORIGINAL function the routes captured.
    app.dependency_overrides[intelligence_replay.get_current_user] = _get_user
    app.dependency_overrides[intelligence_time_travel.get_current_user] = _get_user
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


# ── Tests: POST /replay/sessions ──────────────────────────────────


def test_replay_session_create_happy_path(client, stub_pg):
    resp = client.post(
        "/orgs/org-test/intelligence/replay/sessions",
        json={"trace_id": "trace-abc", "name": "investigation #1"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["org_id"] == "org-test"
    assert body["trace_id"] == "trace-abc"
    assert body["name"] == "investigation #1"
    assert body["session_id"].startswith("replay_")
    # Side effect: row persisted
    assert any(s["trace_id"] == "trace-abc" for s in stub_pg.sessions.values())


def test_replay_session_idempotent(client, stub_pg):
    """Re-calling with same (org, trace, name) returns the same session_id."""
    body1 = client.post(
        "/orgs/org-test/intelligence/replay/sessions",
        json={"trace_id": "trace-abc", "name": "investigation #1"},
    ).json()
    body2 = client.post(
        "/orgs/org-test/intelligence/replay/sessions",
        json={"trace_id": "trace-abc", "name": "investigation #1"},
    ).json()
    assert body1["session_id"] == body2["session_id"]
    # Only one row was created
    assert len(stub_pg.sessions) == 1


def test_replay_session_null_name_creates_new_each_time(client, stub_pg):
    """NULL name is treated as scratch session — always new."""
    body1 = client.post(
        "/orgs/org-test/intelligence/replay/sessions",
        json={"trace_id": "trace-abc", "name": None},
    ).json()
    body2 = client.post(
        "/orgs/org-test/intelligence/replay/sessions",
        json={"trace_id": "trace-abc", "name": None},
    ).json()
    assert body1["session_id"] != body2["session_id"]
    assert len(stub_pg.sessions) == 2


# ── Tests: POST /time-travel/record ───────────────────────────────


def test_time_travel_record_happy_path(client, stub_pg):
    resp = client.post(
        "/orgs/org-test/intelligence/time-travel/record",
        json={"trace_id": "trace-xyz", "label": "before deploy"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["trace_id"] == "trace-xyz"
    assert body["label"] == "before deploy"
    assert body["snapshot_id"].startswith("ttrec_")
    # Side effect: row persisted with fork_at_step = -1 (sentinel)
    assert any(
        s["parent_trace_id"] == "trace-xyz" and s["fork_at_step"] == -1
        for s in stub_pg.snapshots.values()
    )


def test_time_travel_record_without_label(client, stub_pg):
    resp = client.post(
        "/orgs/org-test/intelligence/time-travel/record",
        json={"trace_id": "trace-xyz"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["label"] is None
    assert body["snapshot_id"].startswith("ttrec_")


def test_time_travel_record_rejects_empty_trace(client):
    resp = client.post(
        "/orgs/org-test/intelligence/time-travel/record",
        json={"trace_id": ""},
    )
    assert resp.status_code == 422  # Pydantic validation
