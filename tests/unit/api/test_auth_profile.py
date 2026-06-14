"""Server-side tests for the new profile mutation routes (Phase A.4):

  - PATCH  /users/me            (update name / avatar_url)
  - POST   /users/me/password   (change password)
  - POST   /users/me/avatar     (upload avatar)
  - DELETE /users/me            (soft-delete)

The tests build a minimal FastAPI app with the real auth routes mounted
and override the postgres client + auth dependency. Avatar upload is
exercised against ``/tmp/eden-uploads-test`` (overridable via env).
"""

from __future__ import annotations

import io
import json as _json
import os
from datetime import UTC, datetime, timezone
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from eden.api.routes import auth
from eden.api.utils.auth import hash_password

# ── Stub postgres client ──────────────────────────────────────────


class _StubPostgresClient:
    """In-memory stub for the queries issued by the profile mutations:

      - SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL
      - UPDATE users SET password_hash = $1, token_version = ...
      - UPDATE users SET deleted_at = NOW(), ...
      - UPDATE users SET name = $1, avatar_url = $2 WHERE id = $3
      - UPDATE users SET avatar_url = $1 WHERE id = $2
    """

    def __init__(self) -> None:
        # user_id → {email, password_hash, name, deleted_at, token_version, avatar_url}
        self.users: dict[str, dict[str, Any]] = {}

    async def fetchrow(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        if "SELECT password_hash FROM users" in q and "deleted_at IS NULL" in q:
            uid = args[0]
            u = self.users.get(uid)
            if not u or u.get("deleted_at") is not None:
                return None
            return {"password_hash": u["password_hash"]}
        return None

    async def fetch(self, query: str, *args, **kwargs):
        return []

    async def execute(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        if "UPDATE users SET password_hash" in q:
            new_hash, uid = args[0], args[1]
            if uid in self.users:
                self.users[uid]["password_hash"] = new_hash
                self.users[uid]["token_version"] = self.users[uid].get("token_version", 0) + 1
            return None
        if "UPDATE users SET deleted_at" in q:
            uid = args[0]
            if uid in self.users and self.users[uid].get("deleted_at") is None:
                self.users[uid]["deleted_at"] = datetime.now(UTC)
                self.users[uid]["token_version"] = self.users[uid].get("token_version", 0) + 1
            return None
        # UPDATE users SET name = $1, avatar_url = $2 WHERE id = $3
        # (when PATCH /me provides both fields)
        if "UPDATE users SET name" in q and "avatar_url" in q and "name = $1" in q and "avatar_url = $2" in q:
            uid = args[-1]
            if uid in self.users:
                self.users[uid]["name"] = args[0]
                self.users[uid]["avatar_url"] = args[1]
            return None
        # UPDATE users SET name = $1 WHERE id = $2  (PATCH /me name-only)
        if "UPDATE users SET name = $1" in q and "WHERE id = $2" in q:
            uid = args[1]
            if uid in self.users:
                self.users[uid]["name"] = args[0]
            return None
        # UPDATE users SET avatar_url = $1 WHERE id = $2
        # (PATCH /me avatar_url-only, or POST /me/avatar)
        if "UPDATE users SET avatar_url" in q and "WHERE id = $2" in q:
            url, uid = args[0], args[1]
            if uid in self.users:
                self.users[uid]["avatar_url"] = url
            return None
        return None


# ── Test fixtures ───────────────────────────────────────────────


@pytest.fixture
def upload_dir(monkeypatch, tmp_path):
    """Redirect avatar uploads to a tmp path so tests don't pollute /tmp."""
    d = tmp_path / "uploads"
    monkeypatch.setenv("EDEN_UPLOAD_DIR", str(d))
    return d


@pytest.fixture
def stub_pg(upload_dir):
    return _StubPostgresClient()


@pytest.fixture
def test_user(stub_pg):
    uid = str(uuid4())
    stub_pg.users[uid] = {
        "email": "user@test.io",
        "password_hash": hash_password("old-pass-1234"),
        "name": "Old Name",
        "deleted_at": None,
        "token_version": 0,
        "avatar_url": None,
    }
    return uid, stub_pg.users[uid]


@pytest.fixture
def app(stub_pg, test_user, monkeypatch):
    """Build a minimal FastAPI app with auth routes and stubbed deps."""
    uid, _ = test_user

    async def _get_pg():
        return stub_pg
    monkeypatch.setattr(auth, "get_postgres_client", _get_pg)

    # Stub get_user_by_id (used by GET /me + PATCH /me) to return from stub_pg.
    from eden.api import deps as eden_deps

    async def _get_user_by_id(uid):
        u = stub_pg.users.get(uid)
        if not u or u.get("deleted_at") is not None:
            return None
        return {
            "id": uid, "email": u["email"], "name": u["name"],
            "two_factor_enabled": False, "preferred_org_id": None,
        }
    monkeypatch.setattr(eden_deps, "get_user_by_id", _get_user_by_id)
    monkeypatch.setattr(auth, "get_user_by_id", _get_user_by_id)

    async def _get_user():
        return {"user_id": uid, "email": "user@test.io", "org_id": "org-test"}
    # Use dependency_overrides, not monkeypatch, so the original
    # function object the route captured is used as the key.
    app = FastAPI()
    app.include_router(auth.router)
    app.dependency_overrides[auth.get_current_user] = _get_user
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


# ── Tests: PATCH /users/me ───────────────────────────────────────


def test_update_name(client, test_user):
    uid, u = test_user
    resp = client.patch("/auth/users/me", json={"name": "New Name"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "New Name"
    assert u["name"] == "New Name"


def test_update_avatar_url(client, test_user):
    uid, u = test_user
    resp = client.patch("/auth/users/me", json={"avatar_url": "https://cdn.example/me.png"})
    assert resp.status_code == 200
    assert u["avatar_url"] == "https://cdn.example/me.png"


def test_update_empty_body_400(client):
    resp = client.patch("/auth/users/me", json={})
    assert resp.status_code == 400


# ── Tests: POST /users/me/password ───────────────────────────────


def test_change_password_happy_path(client, test_user):
    uid, u = test_user
    resp = client.post(
        "/auth/users/me/password",
        json={"old_password": "old-pass-1234", "new_password": "New-Pass-5678!"},
    )
    assert resp.status_code == 204
    # The token_version was rotated
    assert u["token_version"] == 1
    # The hash is now different
    assert u["password_hash"] != hash_password("old-pass-1234")


def test_change_password_wrong_old_401(client, test_user):
    resp = client.post(
        "/auth/users/me/password",
        json={"old_password": "WRONG", "new_password": "New-Pass-5678!"},
    )
    assert resp.status_code == 401


def test_change_password_same_as_old_400(client):
    resp = client.post(
        "/auth/users/me/password",
        json={"old_password": "old-pass-1234", "new_password": "old-pass-1234"},
    )
    assert resp.status_code == 400


def test_change_password_too_weak_400(client, test_user):
    resp = client.post(
        "/auth/users/me/password",
        json={"old_password": "old-pass-1234", "new_password": "123"},
    )
    assert resp.status_code == 400


# ── Tests: POST /users/me/avatar ─────────────────────────────────


def test_avatar_upload_png(client, test_user, upload_dir):
    uid, u = test_user
    # Tiny valid PNG (1×1)
    png_bytes = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff"
        b"\xff?\x00\x05\xfe\x02\xfe\xa6\x9c\x82\xe0\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    resp = client.post(
        "/auth/users/me/avatar",
        files={"file": ("avatar.png", io.BytesIO(png_bytes), "image/png")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["avatar_url"].startswith("/uploads/avatars/")
    # File was actually written
    files_written = list((upload_dir / "avatars").iterdir())
    assert len(files_written) == 1
    # User row was updated
    assert u["avatar_url"] == body["avatar_url"]


def test_avatar_upload_unsupported_type_400(client, test_user):
    resp = client.post(
        "/auth/users/me/avatar",
        files={"file": ("doc.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")},
    )
    assert resp.status_code == 400


def test_avatar_upload_too_large_413(client, test_user, upload_dir):
    # 3 MB > 2 MB cap
    big = b"\x00" * (3 * 1024 * 1024)
    resp = client.post(
        "/auth/users/me/avatar",
        files={"file": ("big.png", io.BytesIO(big), "image/png")},
    )
    assert resp.status_code == 413


# ── Tests: DELETE /users/me ──────────────────────────────────────


def test_delete_account_happy_path(client, test_user):
    uid, u = test_user
    resp = client.request(
        "DELETE", "/auth/users/me",
        content=_json.dumps({"confirm": "DELETE"}),
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 204
    # The deleted_at is now set and token_version was rotated
    assert u["deleted_at"] is not None
    assert u["token_version"] == 1


def test_delete_account_wrong_confirm_400(client, test_user):
    resp = client.request(
        "DELETE", "/auth/users/me",
        content=_json.dumps({"confirm": "delete"}),  # lowercase
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 400
    # Account is NOT deleted
    assert test_user[1]["deleted_at"] is None


def test_deleted_user_cannot_change_password(client, test_user):
    """After soft-delete, change-password is rejected because the
    lookup filter ``deleted_at IS NULL`` returns no row."""
    uid, u = test_user
    # Delete first
    client.request(
        "DELETE", "/auth/users/me",
        content=_json.dumps({"confirm": "DELETE"}),
        headers={"content-type": "application/json"},
    )
    # Now try to change password
    resp = client.post(
        "/auth/users/me/password",
        json={"old_password": "old-pass-1234", "new_password": "New-Pass-5678!"},
    )
    assert resp.status_code == 401
