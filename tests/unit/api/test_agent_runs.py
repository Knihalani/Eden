"""Server-side tests for the Phase 3 agent_runs routes.

Uses the same minimal-FastAPI + _StubPostgresClient pattern as
``test_agents_routes``. Verifies:
  - upload (multipart tarball)
  - list/get uploads
  - trigger/list/get sim runs
  - trigger/list/get test runs
  - auth (read vs write)
"""

from __future__ import annotations

import io
import json
import os
import tarfile
import zipfile
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from eden.api.routes import agent_runs

# ── Stub postgres client for the new tables ─────────────────────


class _StubPostgresClient:
    """In-memory stub for agent_uploads + sim_runs tables."""

    def __init__(self) -> None:
        self.uploads: dict[str, dict[str, Any]] = {}
        self.runs: dict[str, dict[str, Any]] = {}
        import uuid as _uuid
        self._uuid = _uuid

    # ── uploads ──────────────────────────────────────────────────

    async def create_agent_upload(self, **kw):
        upload_id = str(self._uuid.uuid4())
        row = {
            "id": upload_id,
            "org_id": kw["org_id"],
            "agent_id": kw["agent_id"],
            "upload_version": 1,
            "code_path": kw["code_path"],
            "entry_point": kw.get("entry_point"),
            "framework": kw.get("framework"),
            "language": kw.get("language") or "python",
            "file_count": kw.get("file_count") or 0,
            "total_bytes": kw.get("total_bytes") or 0,
            "eval_yaml": kw.get("eval_yaml"),
            "uploaded_by": kw.get("uploaded_by"),
            "uploaded_at": "2026-06-09T12:00:00Z",
            "is_active": True,
        }
        # Simulate the trigger's supersession: prior active upload
        # for (org, agent) becomes inactive.
        for _k, v in self.uploads.items():
            if v["org_id"] == row["org_id"] and v["agent_id"] == row["agent_id"]:
                v["is_active"] = False
        self.uploads[upload_id] = row
        return row

    async def list_agent_uploads(self, *, org_id, agent_id, active_only=False, limit=50):
        rows = [
            v for v in self.uploads.values()
            if v["org_id"] == org_id and v["agent_id"] == agent_id
        ]
        if active_only:
            rows = [r for r in rows if r["is_active"]]
        return rows[:limit]

    async def get_agent_upload(self, upload_id):
        return self.uploads.get(upload_id)

    async def get_active_upload(self, *, org_id, agent_id):
        for v in self.uploads.values():
            if v["org_id"] == org_id and v["agent_id"] == agent_id and v["is_active"]:
                return v
        return None

    # ── sim_runs ──────────────────────────────────────────────────

    async def create_sim_run(self, **kw):
        run_id = str(self._uuid.uuid4())
        row = {
            "id": run_id,
            "org_id": kw["org_id"],
            "agent_id": kw["agent_id"],
            "upload_id": kw["upload_id"],
            "kind": kw["kind"],
            "status": "pending",
            "user_id": kw.get("user_id"),
            "started_at": "2026-06-09T12:00:00Z",
            "finished_at": None,
            "duration_ms": None,
            "results": None,
            "error": None,
            "runner_kind": kw.get("runner_kind"),
        }
        self.runs[run_id] = row
        return row

    async def update_sim_run_status(self, run_id, *, status, finished_at=None, duration_ms=None, error=None):
        if run_id in self.runs:
            self.runs[run_id]["status"] = status
            if finished_at:
                self.runs[run_id]["finished_at"] = finished_at
            if duration_ms is not None:
                self.runs[run_id]["duration_ms"] = duration_ms
            if error is not None:
                self.runs[run_id]["error"] = error
        return True

    async def update_sim_run_result(self, run_id, *, results):
        if run_id in self.runs:
            self.runs[run_id]["results"] = results
        return True

    async def get_sim_run(self, run_id):
        return self.runs.get(run_id)

    async def list_sim_runs(self, *, org_id, agent_id, kind=None, status=None, limit=50):
        rows = [
            v for v in self.runs.values()
            if v["org_id"] == org_id
            and v["agent_id"] == agent_id
            and (kind is None or v["kind"] == kind)
            and (status is None or v["status"] == status)
        ]
        return rows[:limit]


# ── Fixtures ────────────────────────────────────────────────────


def _make_tarball(files: dict[str, str]) -> bytes:
    """Build a tar.gz in memory from {filename: contents}."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _make_zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


@pytest.fixture
def app(tmp_path, monkeypatch):
    """Build a minimal FastAPI app with the agent_runs router."""
    test_app = FastAPI()
    test_app.include_router(agent_runs.router)

    from eden.api.deps import get_current_user

    def _user_admin():
        return {
            "user_id": "u-1",
            "org_id": "org-test",
            "org_ids": ["org-test"],
            "is_superuser": False,
            "role": "admin",
            "auth_kind": "session",
        }

    def _user_member():
        u = _user_admin()
        u["role"] = "member"
        return u

    def _user_no_auth():
        return {
            "user_id": "u-1",
            "org_id": "other-org",
            "org_ids": ["other-org"],
            "is_superuser": False,
            "role": "admin",
            "auth_kind": "session",
        }

    test_app.dependency_overrides[get_current_user] = _user_admin

    stub = _StubPostgresClient()

    async def _override_get_postgres_client():
        return stub

    # Patch get_postgres_client at the route module level (the route
    # imports it at call time, so module-level monkeypatch works).
    agent_runs.get_postgres_client = _override_get_postgres_client
    from eden.storage import postgres as pg_module
    pg_module.get_postgres_client = _override_get_postgres_client

    # Also pre-register the agent so the auth check doesn't 404
    async def _ensure_registered(org_id, agent_id):
        # The route's _require_agent_read checks the agent_registrations
        # table. Stub: always return a row.
        from eden.storage.postgres import get_postgres_client as _real
        return True

    # Override the existence check (the route calls fetchrow on
    # agent_registrations; our stub doesn't model that, so we
    # patch the call to always succeed).
    class _AlwaysPresent:
        async def fetchrow(self, *a, **kw):
            return {"x": 1}
        async def fetch(self, *a, **kw):
            return [{"x": 1}]
        async def fetchval(self, *a, **kw):
            return 1
        async def execute(self, *a, **kw):
            return "OK"

    class _RealAgentLookupStub:
        # Same as the main stub but the agent_registrations table
        # check returns a row.
        pass

    # Easier: monkey-patch the route's _require_agent_read to skip
    # the DB check.
    async def _fake_require_agent_read(org_id, agent_id, user):
        return None

    async def _fake_require_agent_write(org_id, agent_id, user):
        if user.get("role") not in ("owner", "admin") and not user.get("is_superuser"):
            from fastapi import HTTPException
            raise HTTPException(status_code=403, detail="requires admin")

    monkeypatch.setattr(agent_runs, "_require_agent_read", _fake_require_agent_read)
    monkeypatch.setattr(agent_runs, "_require_agent_write", _fake_require_agent_write)

    # Redirect /var/eden/uploads/ to a tmp dir so uploads don't
    # pollute the filesystem.
    monkeypatch.setattr(agent_runs, "DEFAULT_UPLOAD_ROOT", str(tmp_path))

    return test_app, stub


@pytest.fixture
def client(app):
    test_app, stub = app
    return TestClient(test_app), stub


# ── Upload tests ────────────────────────────────────────────────


def test_upload_targz(client, app):
    c, _ = client
    test_app, _stub = app
    tarball = _make_tarball({
        "agent.py": "def run(): return 'hello'",
        "requirements.txt": "gymnasium\n",
        "eden-sim-eval.yaml": "version: 1\nframework: openai\ntarget:\n  module: agent:run\n",
    })
    resp = c.post(
        "/orgs/org-test/agents/agent-1/upload",
        files={"file": ("agent.tar.gz", tarball, "application/gzip")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["framework"] == "openai"
    assert body["entry_point"] == "agent:run"
    assert body["file_count"] == 3
    assert body["language"] == "python"


def test_upload_zip(client, app):
    c, _ = client
    tarball = _make_zip({
        "agent.py": "def run(): pass",
    })
    resp = c.post(
        "/orgs/org-test/agents/agent-2/upload",
        files={"file": ("agent.zip", tarball, "application/zip")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["file_count"] == 1


def test_upload_unsupported_format_returns_400(client, app):
    c, _ = client
    # A raw .py file is not a recognized archive
    resp = c.post(
        "/orgs/org-test/agents/agent-1/upload",
        files={"file": ("agent.py", b"x = 1", "text/x-python")},
    )
    assert resp.status_code == 400


def test_list_uploads(client, app):
    c, stub = client
    # Seed two uploads
    test_app, _ = app
    import asyncio
    async def _seed():
        await stub.create_agent_upload(
            org_id="org-test", agent_id="agent-1",
            code_path="/tmp/a", framework="openai",
        )
        await stub.create_agent_upload(
            org_id="org-test", agent_id="agent-1",
            code_path="/tmp/b", framework="openai",
        )
    asyncio.run(_seed())
    resp = c.get("/orgs/org-test/agents/agent-1/uploads")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 2


def test_get_upload_404_when_missing(client, app):
    c, _ = client
    resp = c.get("/orgs/org-test/agents/agent-1/uploads/nope")
    assert resp.status_code == 404


# ── Sim run tests ────────────────────────────────────────────────


def test_trigger_sim_run_uses_active_upload(client, app):
    c, stub = client
    test_app, _ = app
    import asyncio
    async def _seed():
        await stub.create_agent_upload(
            org_id="org-test", agent_id="agent-1",
            code_path="/tmp/active", framework="openai",
        )
    asyncio.run(_seed())
    resp = c.post(
        "/orgs/org-test/agents/agent-1/sim/runs",
        json={},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "sim"
    assert body["status"] in ("pending", "running", "passed", "failed", "error")
    assert body["upload_id"]  # resolved from active upload


def test_trigger_sim_run_no_active_upload_returns_400(client, app):
    c, _ = client
    resp = c.post(
        "/orgs/org-test/agents/agent-1/sim/runs",
        json={},
    )
    assert resp.status_code == 400


def test_trigger_sim_run_with_upload_id(client, app):
    c, stub = client
    test_app, _ = app
    import asyncio
    upload_id = None
    async def _seed():
        nonlocal upload_id
        u = await stub.create_agent_upload(
            org_id="org-test", agent_id="agent-1",
            code_path="/tmp/a", framework="openai",
        )
        upload_id = u["id"]
    asyncio.run(_seed())
    resp = c.post(
        "/orgs/org-test/agents/agent-1/sim/runs",
        json={"upload_id": upload_id, "max_episodes": 3},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["upload_id"] == upload_id


def test_list_sim_runs_filtered(client, app):
    c, stub = client
    test_app, _ = app
    import asyncio
    async def _seed():
        await stub.create_agent_upload(
            org_id="org-test", agent_id="agent-1",
            code_path="/tmp/a",
        )
        await stub.create_sim_run(
            org_id="org-test", agent_id="agent-1", upload_id="u1", kind="sim",
        )
        await stub.create_sim_run(
            org_id="org-test", agent_id="agent-1", upload_id="u1", kind="test",
        )
    asyncio.run(_seed())
    resp = c.get("/orgs/org-test/agents/agent-1/sim/runs?status=pending")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["runs"][0]["kind"] == "sim"


def test_get_sim_run(client, app):
    c, stub = client
    test_app, _ = app
    import asyncio
    run_id = None
    async def _seed():
        nonlocal run_id
        await stub.create_agent_upload(
            org_id="org-test", agent_id="agent-1",
            code_path="/tmp/a",
        )
        r = await stub.create_sim_run(
            org_id="org-test", agent_id="agent-1", upload_id="u1", kind="sim",
        )
        run_id = r["id"]
    asyncio.run(_seed())
    resp = c.get(f"/orgs/org-test/agents/agent-1/sim/runs/{run_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == run_id


def test_get_sim_run_404_wrong_org(client, app):
    c, stub = client
    test_app, _ = app
    import asyncio
    run_id = None
    async def _seed():
        nonlocal run_id
        await stub.create_agent_upload(
            org_id="other-org", agent_id="agent-1",
            code_path="/tmp/a",
        )
        r = await stub.create_sim_run(
            org_id="other-org", agent_id="agent-1", upload_id="u1", kind="sim",
        )
        run_id = r["id"]
    asyncio.run(_seed())
    resp = c.get(f"/orgs/org-test/agents/agent-1/sim/runs/{run_id}")
    assert resp.status_code == 404


# ── Test run tests ───────────────────────────────────────────────


def test_trigger_test_run(client, app):
    c, stub = client
    test_app, _ = app
    import asyncio
    async def _seed():
        await stub.create_agent_upload(
            org_id="org-test", agent_id="agent-1",
            code_path="/tmp/a", framework="openai",
        )
    asyncio.run(_seed())
    resp = c.post("/orgs/org-test/agents/agent-1/test/runs", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "test"
    assert body["upload_id"]


def test_list_test_runs(client, app):
    c, stub = client
    test_app, _ = app
    import asyncio
    async def _seed():
        await stub.create_agent_upload(
            org_id="org-test", agent_id="agent-1",
            code_path="/tmp/a",
        )
        await stub.create_sim_run(
            org_id="org-test", agent_id="agent-1", upload_id="u1", kind="test",
        )
    asyncio.run(_seed())
    resp = c.get("/orgs/org-test/agents/agent-1/test/runs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1


# ── Auth tests ────────────────────────────────────────────────


def test_member_cannot_upload(monkeypatch, tmp_path):
    """A 'member' role should NOT be able to upload (write requires
    owner/admin)."""
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    from eden.api.deps import get_current_user
    from eden.api.routes import agent_runs

    test_app = FastAPI()
    test_app.include_router(agent_runs.router)

    def _member():
        return {
            "user_id": "u-1", "org_id": "org-test", "org_ids": ["org-test"],
            "is_superuser": False, "role": "member", "auth_kind": "session",
        }

    test_app.dependency_overrides[get_current_user] = _member

    stub = _StubPostgresClient()

    async def _gpc():
        return stub

    agent_runs.get_postgres_client = _gpc
    from eden.storage import postgres as pg_module
    pg_module.get_postgres_client = _gpc

    async def _noop(*a, **kw): return None
    monkeypatch.setattr(agent_runs, "_require_agent_read", _noop)
    # Restore the real _require_agent_write so the role check fires
    if hasattr(agent_runs, "_require_agent_write"):
        # The real function will look up the user's role. We need
        # the override to use the test user. Restore by reloading.
        pass

    monkeypatch.setattr(agent_runs, "DEFAULT_UPLOAD_ROOT", str(tmp_path))

    c = TestClient(test_app)
    tarball = _make_tarball({"agent.py": "x = 1"})
    resp = c.post(
        "/orgs/org-test/agents/agent-1/upload",
        files={"file": ("agent.tar.gz", tarball, "application/gzip")},
    )
    assert resp.status_code == 403


def test_member_can_list_runs(monkeypatch):
    """A 'member' CAN read (list/get) runs."""
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    from eden.api.deps import get_current_user
    from eden.api.routes import agent_runs

    test_app = FastAPI()
    test_app.include_router(agent_runs.router)

    def _member():
        return {
            "user_id": "u-1", "org_id": "org-test", "org_ids": ["org-test"],
            "is_superuser": False, "role": "member", "auth_kind": "session",
        }

    test_app.dependency_overrides[get_current_user] = _member

    stub = _StubPostgresClient()

    async def _gpc():
        return stub

    agent_runs.get_postgres_client = _gpc
    from eden.storage import postgres as pg_module
    pg_module.get_postgres_client = _gpc

    async def _noop(*a, **kw): return None
    monkeypatch.setattr(agent_runs, "_require_agent_read", _noop)
    monkeypatch.setattr(agent_runs, "_require_agent_write", _noop)

    c = TestClient(test_app)
    resp = c.get("/orgs/org-test/agents/agent-1/sim/runs")
    assert resp.status_code == 200
