"""Server-side tests for the new RBAC routes (Phase A.2):

  - GET  /orgs/{org_id}/permissions           (static catalogue)
  - POST /orgs/{org_id}/roles/assign          (one-call give-permission)
  - POST /orgs/{org_id}/roles/unassign        (one-call revoke)

The tests build a minimal FastAPI app with the real routes mounted and
override the postgres client + auth dependency so the routes can be
exercised end-to-end without external services.
"""

from __future__ import annotations

from datetime import UTC, datetime, timezone
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from eden.api.routes import rbac

_NOW = datetime(2026, 6, 14, 0, 0, 0, tzinfo=UTC)


# ── Stub postgres client ──────────────────────────────────────────


class _StubPostgresClient:
    """In-memory stub for the queries issued by the new RBAC routes:

      - find auto-role by (org_id, name)
      - create role_definitions
      - insert role_permissions
      - insert role_assignments (idempotent via COALESCE UNIQUE INDEX)
      - delete role_assignments by user_id + role_id (via name lookup)
    """

    def __init__(self) -> None:
        # role_id -> {org_id, name, base_role, description, created_at}
        self.roles: dict[str, dict[str, Any]] = {}
        # (role_id, permission_key) -> bool
        self.role_perms: set[tuple[str, str]] = set()
        # assignment_id -> {role_id, user_id, resource_type, resource_id, ...}
        self.assignments: dict[str, dict[str, Any]] = {}

    async def fetchrow(self, query: str, *args, **kwargs):
        q = " ".join(query.split())

        if "FROM role_definitions" in q and "WHERE org_id = $1 AND name = $2" in q:
            org, name = args[0], args[1]
            for rid, r in self.roles.items():
                if r["org_id"] == org and r["name"] == name:
                    return {"id": rid}
            return None

        if "INSERT INTO role_definitions" in q and "RETURNING id" in q:
            # The route hardcodes base_role='viewer' in the SQL, so
            # only 3 params are passed: org, name, description.
            org, name, desc = args
            rid = str(uuid4())
            self.roles[rid] = {
                "org_id": org, "name": name,
                "base_role": "viewer", "description": desc,
                "created_at": _NOW,
            }
            return {"id": rid}

        if "INSERT INTO role_assignments" in q and "RETURNING" in q:
            role_id, user_id, rtype, rid_res, granted_by = args
            # Idempotency: skip if (role_id, user_id, rtype, rid_res) exists
            for a in self.assignments.values():
                if (a["role_id"] == role_id and a["user_id"] == user_id
                        and a["resource_type"] == rtype
                        and a["resource_id"] == rid_res):
                    return None  # ON CONFLICT DO NOTHING → no row returned
            aid = str(uuid4())
            self.assignments[aid] = {
                "id": aid, "role_id": role_id, "user_id": user_id,
                "resource_type": rtype, "resource_id": rid_res,
                "granted_by": granted_by, "created_at": _NOW,
            }
            return self.assignments[aid]

        if "SELECT id, role_id, user_id" in q and "FROM role_assignments" in q:
            # Fetch existing assignment by (role_id, user_id, rtype, rid_res)
            role_id, user_id, rtype, rid_res = args
            for a in self.assignments.values():
                if (a["role_id"] == role_id and a["user_id"] == user_id
                        and (a["resource_type"] or "") == (rtype or "")
                        and (a["resource_id"] or "") == (rid_res or "")):
                    return {
                        "id": a["id"], "role_id": a["role_id"],
                        "user_id": a["user_id"],
                        "resource_type": a["resource_type"],
                        "resource_id": a["resource_id"],
                        "granted_by": a["granted_by"],
                        "created_at": a["created_at"],
                    }
            return None

        return None

    async def execute(self, query: str, *args, **kwargs):
        q = " ".join(query.split())

        if "INSERT INTO role_permissions" in q:
            role_id, perm = args
            self.role_perms.add((role_id, perm))
            return None

        if "DELETE FROM role_assignments" in q:
            # DELETE ... WHERE user_id = $1 AND role_id IN (SELECT id ...)
            user_id, org, role_name = args
            role_ids = {rid for rid, r in self.roles.items()
                        if r["org_id"] == org and r["name"] == role_name}
            to_delete = [aid for aid, a in self.assignments.items()
                         if a["user_id"] == user_id and a["role_id"] in role_ids]
            for aid in to_delete:
                self.assignments.pop(aid, None)
            return None

        return None


# ── Test fixtures ───────────────────────────────────────────────


@pytest.fixture
def stub_pg():
    return _StubPostgresClient()


@pytest.fixture
def admin_member():
    return rbac.OrgMember(
        user_id=str(uuid4()),
        org_id="org-test",
        role="admin",
        email="admin@test.io",
        name="Admin User",
    )


@pytest.fixture
def app(stub_pg, admin_member, monkeypatch):
    """Build a minimal FastAPI app with the rbac routes and stubbed deps."""

    # Patch get_postgres_client on the rbac module (it imports it at
    # module level).
    async def _get_pg():
        return stub_pg
    monkeypatch.setattr(rbac, "get_postgres_client", _get_pg)

    # Auth: do NOT monkeypatch the get_current_org_member function
    # object — the route captured the original reference via
    # ``Depends(get_current_org_member)`` at decoration time, and
    # replacing the function object would break the override key. Use
    # FastAPI's dependency_overrides instead, keyed on the original
    # function object that the route captured.
    from eden.api import deps as eden_deps
    original_get_member = rbac.get_current_org_member  # same as eden_deps.get_current_org_member at import time

    async def _get_member() -> rbac.OrgMember:
        return admin_member

    app = FastAPI()
    app.include_router(rbac.router)
    app.include_router(rbac.permissions_router)
    # Key the override on the original function object the route captured.
    app.dependency_overrides[original_get_member] = _get_member
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


# ── Tests: GET /permissions catalogue ────────────────────────────


def test_permissions_catalogue_returns(client):
    """The catalogue is the union of PERMISSION_MAP across all roles,
    annotated with which built-in roles grant each permission."""
    resp = client.get("/orgs/org-test/permissions")
    assert resp.status_code == 200
    body = resp.json()
    assert body["org_id"] == "org-test"
    assert body["count"] == len(body["permissions"])
    # Each entry has the expected shape
    for entry in body["permissions"]:
        assert "key" in entry
        assert "resource" in entry
        assert "action" in entry
        assert "granted_by_default" in entry
        # The key splits correctly
        assert entry["key"] == f"{entry['resource']}:{entry['action']}"
    # `audit:view` is in the catalogue and granted by multiple roles
    audit = next(p for p in body["permissions"] if p["key"] == "audit:view")
    assert "owner" in audit["granted_by_default"]
    assert "admin" in audit["granted_by_default"]


def test_permissions_catalogue_includes_phase_7_3d(client):
    """Phase 7.3d added 4 new permissions — they should be in the catalogue."""
    resp = client.get("/orgs/org-test/permissions")
    body = resp.json()
    keys = {p["key"] for p in body["permissions"]}
    for new_perm in ("pii:edit", "judges:run", "gdpr:execute", "retention:override"):
        assert new_perm in keys, f"missing Phase 7.3d permission: {new_perm}"


# ── Tests: POST /roles/assign ────────────────────────────────────


def test_assign_creates_auto_role_and_assignment(client, stub_pg):
    user_id = str(uuid4())
    resp = client.post(
        "/orgs/org-test/roles/assign",
        json={"user_id": user_id, "permission_key": "audit:view"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["user_id"] == user_id
    assert body["granted_by"] is not None  # populated from member
    # Side effects: a role named "perm:audit:view" was created
    assert any(r["name"] == "perm:audit:view" for r in stub_pg.roles.values())
    # The auto-role has the permission granted
    auto_role_id = next(rid for rid, r in stub_pg.roles.items()
                        if r["name"] == "perm:audit:view")
    assert (auto_role_id, "audit:view") in stub_pg.role_perms
    # The user has an assignment to that role
    assert any(a["user_id"] == user_id and a["role_id"] == auto_role_id
               for a in stub_pg.assignments.values())


def test_assign_is_idempotent(client, stub_pg):
    """Calling assign twice with the same args returns the same assignment."""
    user_id = str(uuid4())
    resp1 = client.post(
        "/orgs/org-test/roles/assign",
        json={"user_id": user_id, "permission_key": "billing:view"},
    )
    resp2 = client.post(
        "/orgs/org-test/roles/assign",
        json={"user_id": user_id, "permission_key": "billing:view"},
    )
    assert resp1.status_code == 201
    assert resp2.status_code == 201
    assert resp1.json()["id"] == resp2.json()["id"]
    # Only one assignment exists
    matching = [a for a in stub_pg.assignments.values() if a["user_id"] == user_id]
    assert len(matching) == 1


def test_assign_invalid_permission_rejected(client):
    """The permission key shape is validated at the Pydantic level."""
    resp = client.post(
        "/orgs/org-test/roles/assign",
        json={"user_id": str(uuid4()), "permission_key": "INVALID-KEY"},
    )
    assert resp.status_code == 422  # Pydantic validation error


def test_assign_invalid_user_id_rejected(client):
    resp = client.post(
        "/orgs/org-test/roles/assign",
        json={"user_id": "not-a-uuid", "permission_key": "audit:view"},
    )
    assert resp.status_code == 422


def test_assign_requires_admin_role(stub_pg, monkeypatch):
    """A non-admin member is rejected with 403."""
    member = rbac.OrgMember(
        user_id=str(uuid4()), org_id="org-test", role="member",
        email="m@t.io", name="Member",
    )

    from eden.api import deps as eden_deps
    original_get_member = rbac.get_current_org_member

    async def _get_member():
        return member
    async def _get_pg():
        return stub_pg
    monkeypatch.setattr(rbac, "get_postgres_client", _get_pg)

    app = FastAPI()
    app.include_router(rbac.router)
    app.include_router(rbac.permissions_router)
    app.dependency_overrides[original_get_member] = _get_member
    c = TestClient(app)

    resp = c.post(
        "/orgs/org-test/roles/assign",
        json={"user_id": str(uuid4()), "permission_key": "audit:view"},
    )
    assert resp.status_code == 403


def test_assign_with_resource_consistency_check(client):
    """resource_type and resource_id must both be set or both be null."""
    resp = client.post(
        "/orgs/org-test/roles/assign",
        json={"user_id": str(uuid4()), "permission_key": "audit:view",
              "resource_type": "job", "resource_id": None},
    )
    assert resp.status_code == 400


# ── Tests: POST /roles/unassign ──────────────────────────────────


def test_unassign_removes_assignment(client, stub_pg):
    user_id = str(uuid4())
    # Set up an assignment first
    client.post(
        "/orgs/org-test/roles/assign",
        json={"user_id": user_id, "permission_key": "audit:view"},
    )
    assert len(stub_pg.assignments) == 1

    resp = client.post(
        "/orgs/org-test/roles/unassign",
        json={"user_id": user_id, "permission_key": "audit:view"},
    )
    assert resp.status_code == 204
    assert len(stub_pg.assignments) == 0


def test_unassign_idempotent_on_missing(client, stub_pg):
    """Unassigning a user with no existing assignment still returns 204."""
    resp = client.post(
        "/orgs/org-test/roles/unassign",
        json={"user_id": str(uuid4()), "permission_key": "audit:view"},
    )
    assert resp.status_code == 204
    assert len(stub_pg.assignments) == 0


def test_unassign_invalid_permission_rejected(client):
    resp = client.post(
        "/orgs/org-test/roles/unassign",
        json={"user_id": str(uuid4()), "permission_key": "BAD"},
    )
    assert resp.status_code == 422
