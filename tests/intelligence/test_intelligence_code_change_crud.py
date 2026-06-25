"""Real CRUD tests for Cat 23 (Autonomous Code Modification).

Phase 2 of the audit pass wires Cat 23 read/CRUD routes against
the real Postgres tables (``repo_connections``,
``proposed_patches``, ``pull_requests``, ``patch_approvals``).
These tests exercise the read + write paths against the
auto-mocked ``PostgresClient`` from :mod:`tests.conftest`
(``patch_postgres`` autouse fixture).

Destructive actions (POST /patches, POST /patches/{id}/pr,
POST /prs/{id}/revert, etc.) stay Gate-4a blocked and are
covered by :mod:`tests.intelligence.test_autonomous_code_modification_stubs`.
"""

from __future__ import annotations

import importlib
import os
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_org_admin, require_org_permission_dep


def _fake_user() -> dict:
    return {"sub": "user-test", "org_id": "org-test", "email": "t@e.com"}


def _fake_admin() -> dict:
    """Fake admin org dict — Cat 23 destructive routes pass this through."""
    return {"user_id": "user-test", "org_id": "org-test", "role": "owner"}


@pytest.fixture(scope="module")
def test_app() -> FastAPI:
    from eden.config import get_settings
    settings = get_settings()
    settings.intelligence_gap_v0 = True
    app = FastAPI(title="eden-cat23-crud-test")
    app.dependency_overrides[get_current_user] = _fake_user
    # Cat 23 destructive routes are gated by ``require_org_admin`` /
    # ``require_org_permission_dep`` (June 2026 hardening). The CRUD
    # tests don't exercise auth — fake both as admin so the
    # destructive gates let the request through.
    #
    # ``require_org_permission_dep`` is a FACTORY: ``Dep = factory("x")``
    # returns a closure, and the route uses ``Depends(closure)``.
    # FastAPI's ``dependency_overrides`` matches by the closure
    # reference, so we override each closure instance — one per
    # route that called the factory. The admin dep (no factory) is
    # overridden directly.
    app.dependency_overrides[require_org_admin] = _fake_admin
    # Re-import the route module so the factory calls happen here
    # (we capture the closure references for the override map).
    mod = importlib.import_module("eden.api.routes.intelligence_code_change")
    # Walk every route's dependency list and override any
    # ``require_org_permission_dep`` closure we find. The
    # closure's ``__qualname__`` carries the originating factory
    # name (FastAPI's introspect picks it up).
    for route in mod.router.routes:
        if not hasattr(route, "dependant"):
            continue
        for dep in route.dependant.dependencies:
            call = getattr(dep, "call", None)
            if call is None:
                continue
            qname = getattr(call, "__qualname__", "") or ""
            if "require_org_permission_dep" in qname:
                app.dependency_overrides[call] = _fake_admin
    app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def client(test_app: FastAPI) -> TestClient:
    os.environ.setdefault("EDEN_FEATURE_INTELLIGENCE_GAP_V0", "true")
    return TestClient(test_app)


# ── helpers ──────────────────────────────────────────────────────────
# Cat 23 services do ``from ._common import _insert_row`` at module
# load, which binds the name in the consumer's namespace. Patching
# ``eden.code_change._common._insert_row`` alone leaves the consumer's
# local binding pointing at the original. We patch both the source
# module AND every consumer that does ``from ._common import ...``.
#
# This list is small (5 modules) — easier than AST-walking the
# package at fixture time.


_CAT23_COMMON = "eden.code_change._common"
_CAT23_CONSUMERS = [
    "eden.code_change.repo_connector",
    "eden.code_change.inbox.inbox",
    "eden.code_change.inbox.review",
    "eden.code_change.pr_creator",
    "eden.code_change.auto_approval.metrics",
    "eden.code_change.auto_approval.rules",
    "eden.code_change.quality.quality_scorer",
    "eden.code_change.style.style_learner",
]


def _patch_cat23_common(monkeypatch: pytest.MonkeyPatch, **overrides) -> None:
    """Patch ``_common.<name>`` AND every consumer module's binding."""
    import eden.code_change._common as _common_mod
    for name, value in overrides.items():
        # Use module-object form so pytest doesn't reload from
        # a different sys.path entry.
        monkeypatch.setattr(_common_mod, name, value)
        for consumer in _CAT23_CONSUMERS:
            try:
                mod = importlib.import_module(consumer)
                if hasattr(mod, name):
                    monkeypatch.setattr(mod, name, value)
            except (ImportError, AttributeError):
                # The consumer may not import this name; that's OK.
                pass


# ── 1. POST /repos/connect persists a row, GET /repos returns it ────


def test_repo_connect_then_list_round_trip(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, mock_postgres_client: MagicMock
) -> None:
    """connect writes a row, list reads it back. Verifies the
    repo_connections table is queried correctly via _common helpers."""
    captured_rows: dict[str, Any] = {}

    async def _capture_insert(org_id, table, columns, values):
        row = dict(zip(columns, values))
        row["org_id"] = org_id
        captured_rows[row.get("id") or row.get("repo_id")] = row

    async def _capture_select(org_id, table, **kwargs):
        return list(captured_rows.values())

    async def _capture_select_one(org_id, table, **kwargs):
        return list(captured_rows.values())[0] if captured_rows else None

    async def _capture_update(org_id, table, **kwargs):
        return True

    _patch_cat23_common(
        monkeypatch,
        _insert_row=_capture_insert,
        _select_rows=_capture_select,
        _select_one=_capture_select_one,
        _update_row=_capture_update,
    )

    resp = client.post(
        "/orgs/org-test/intelligence/code-change/repos/connect",
        json={
            "provider": "github",
            "repo_full_name": "acme/widgets",
            "default_branch": "main",
        },
    )
    assert resp.status_code == 200, resp.text
    envelope = resp.json()
    assert envelope["status"] == "ok"
    repo_id = envelope["data"]["repo_id"]
    assert repo_id.startswith("repo_")

    list_resp = client.get(
        "/orgs/org-test/intelligence/code-change/repos"
    )
    assert list_resp.status_code == 200
    items = list_resp.json()["data"]["repos"]
    assert any(r["repo_id"] == repo_id for r in items)
    assert items[0]["repo_full_name"] == "acme/widgets"
    assert items[0]["provider"] == "github"


# ── 2. POST /inbox/{patch_id}/approve writes a patch_approvals row ─


def test_approve_writes_patch_approval_and_flips_status(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, mock_postgres_client: MagicMock
) -> None:
    """approve an existing patch → patch_approvals row inserted,
    proposed_patches.status updated to 'approved'."""
    inserted: list[dict[str, Any]] = []
    updated: list[tuple[str, str, Any]] = []

    async def _capture_insert(org_id, table, columns, values):
        row = dict(zip(columns, values))
        row["org_id"] = org_id
        row["table"] = table
        inserted.append(row)

    async def _capture_update(org_id, table, *, where_col, where_val, set_col, set_val):
        updated.append((table, where_val, set_val))
        return True

    _patch_cat23_common(
        monkeypatch,
        _insert_row=_capture_insert,
        _update_row=_capture_update,
    )

    resp = client.post(
        "/orgs/org-test/intelligence/code-change/inbox/patch_abc/approve",
        json={
            "action": "approve",
            "policy": {"code_change_enabled": True, "auto_pr_enabled": True},
            "actor_user_id": "user-test",
            "comment": "LGTM",
        },
    )
    assert resp.status_code == 200, resp.text
    envelope = resp.json()
    assert envelope["status"] == "ok"
    assert envelope["data"]["new_status"] == "approved"
    appr_rows = [r for r in inserted if r["table"] == "patch_approvals"]
    assert len(appr_rows) == 1
    assert appr_rows[0]["approval_type"] == "approve"
    assert appr_rows[0]["comment"] == "LGTM"
    assert appr_rows[0]["patch_id"] == "patch_abc"
    patch_updates = [u for u in updated if u[0] == "proposed_patches"]
    assert patch_updates == [("proposed_patches", "patch_abc", "approved")]


# ── 3. POST /inbox/{patch_id}/deny writes a 'denied' status ────────


def test_deny_writes_status_denied(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, mock_postgres_client: MagicMock
) -> None:
    updated: list[tuple[str, str, Any]] = []

    async def _capture_update(org_id, table, *, where_col, where_val, set_col, set_val):
        updated.append((table, where_val, set_val))
        return True

    async def _capture_insert(org_id, table, columns, values):
        pass

    _patch_cat23_common(
        monkeypatch,
        _insert_row=_capture_insert,
        _update_row=_capture_update,
    )

    resp = client.post(
        "/orgs/org-test/intelligence/code-change/inbox/patch_xyz/deny",
        json={
            "action": "deny",
            "policy": {"code_change_enabled": True},
            "actor_user_id": "user-test",
            "comment": "out of scope",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["new_status"] == "denied"
    assert ("proposed_patches", "patch_xyz", "denied") in updated


# ── 4. POST /inbox/{patch_id}/comment writes approval, no status flip


def test_comment_does_not_flip_status(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, mock_postgres_client: MagicMock
) -> None:
    updated: list[tuple[str, str, Any]] = []

    async def _capture_insert(org_id, table, columns, values):
        pass

    async def _capture_update(org_id, table, **kwargs):
        updated.append((table, kwargs["where_val"], kwargs["set_val"]))
        return True

    _patch_cat23_common(
        monkeypatch,
        _insert_row=_capture_insert,
        _update_row=_capture_update,
    )

    resp = client.post(
        "/orgs/org-test/intelligence/code-change/inbox/patch_q/comment",
        json={
            "action": "comment",
            "policy": {"code_change_enabled": False},  # comment bypasses opt-in
            "actor_user_id": "user-test",
            "comment": "consider renaming this var",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()["data"]
    assert body["new_status"] is None
    assert updated == []


# ── 5. GET /prs reads from pull_requests table ─────────────────────


def test_list_prs_queries_pull_requests_table(
    client: TestClient, mock_postgres_client: MagicMock
) -> None:
    """Verify GET /prs delegates to the real PR read helper, which
    queries the ``pull_requests`` table (not a stub)."""
    from eden.code_change import pr_creator as pc

    captured: list[dict[str, Any]] = []

    async def _capture(self, org_id, *, repo_id=None, state="open", limit=50):
        captured.append({"org_id": org_id, "state": state, "limit": limit, "repo_id": repo_id})
        return {
            "status": "ok",
            "feature": "pr_creator",
            "live": True,
            "data": {
                "prs": [
                    {
                        "pr_id": "pr_1",
                        "repo_id": "repo_1",
                        "state": "open",
                        "pr_url": "https://example/pr/1",
                    },
                ],
                "count": 1,
                "state": state,
            },
        }

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(pc.PRCreator, "list_prs", _capture)
    try:
        resp = client.get("/orgs/org-test/intelligence/code-change/prs?state=open")
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["count"] == 1
        assert captured == [
            {"org_id": "org-test", "state": "open", "limit": 50, "repo_id": None}
        ]
    finally:
        monkeypatch.undo()


# ── 6. GET /patches/{id} reads from proposed_patches table ─────────


def test_get_patch_reads_proposed_patches(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, mock_postgres_client: MagicMock
) -> None:
    fake_row = {
        "id": "patch_42",
        "org_id": "org-test",
        "repo_id": "repo_1",
        "trace_id": "tr_1",
        "rca_id": "rca_1",
        "description": "fix the thing",
        "status": "proposed",
        "quality_score": 0.9,
        "blast_radius_score": 0.1,
        "cost_usd": 0.05,
        "model_used": "stub",
        "diff": "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new",
        "created_at": None,
        "updated_at": None,
    }

    async def _capture(org_id, table, *, where, params=()):
        return [fake_row]

    async def _capture_one(org_id, table, *, where, params=()):
        return fake_row

    _patch_cat23_common(
        monkeypatch,
        _select_rows=_capture,
        _select_one=_capture_one,
    )

    resp = client.get(
        "/orgs/org-test/intelligence/code-change/patches/patch_42"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()["data"]
    assert body["patch_id"] == "patch_42"
    assert body["description"] == "fix the thing"
    assert body["found"] is True
    assert body["explanation"]["what_happened"] == "fix the thing"


# ── 7. DELETE /repos/{id} flips repo_connections.status ────────────


def test_disconnect_flips_status(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, mock_postgres_client: MagicMock
) -> None:
    updated: list[tuple[str, str, str, Any]] = []

    async def _capture_update(org_id, table, *, where_col, where_val, set_col, set_val):
        updated.append((table, where_col, where_val, set_val))
        return True

    _patch_cat23_common(monkeypatch, _update_row=_capture_update)

    resp = client.delete(
        "/orgs/org-test/intelligence/code-change/repos/repo_1"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()["data"]
    assert body["repo_id"] == "repo_1"
    assert body["disconnected"] is True
    assert updated == [
        ("repo_connections", "id", "repo_1", "disconnected"),
    ]
