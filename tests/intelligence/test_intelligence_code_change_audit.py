"""S-4 audit-trail forgery tests for Cat 23 routes.

The S-4 audit found 4 endpoints that accepted ``granted_by_user_id``,
``delegator_user_id``, ``revoked_by_user_id``, ``requested_by_user_id``,
``actor_user_id``, and ``connected_by_user_id`` from the request body,
letting any caller forge audit-trail entries as someone else.

These tests pin the post-fix behavior: the schema field is removed
(``extra='forbid'`` would be ideal but the existing schemas use
``extra='ignore'`` defaults; the runtime check is that the route passes
``user["user_id"]`` — never the body — to the service layer).

We assert the call to the service uses the auth-context user id, by
inspecting the bound kwargs on the service method mocks.
"""

from __future__ import annotations

import importlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _fake_user() -> dict:
    """Authenticated caller. Note ``user_id`` — the routes read THIS."""
    return {
        "user_id": "auth-user-AAA",
        "sub": "auth-user-AAA",
        "org_id": "org-test",
        "email": "auth@e.com",
        "role": "owner",
    }


def _build_app() -> FastAPI:
    """Build a minimal FastAPI app that mounts the Cat 23 router with
    all destructive deps overridden to admin.
    """
    from eden.api.deps import get_current_user, require_org_member, require_org_admin, require_org_permission_dep
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True

    app = FastAPI(title="eden-cat23-audit-test")
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = _fake_user

    mod = importlib.import_module("eden.api.routes.intelligence_code_change")
    app.include_router(mod.router)

    # Override admin deps so destructive routes pass the gate.
    app.dependency_overrides[require_org_admin] = _fake_user

    # The factory closures — walk every route and override any
    # ``require_org_permission_dep("...")`` closure with the fake admin.
    for route in app.routes:
        for dep in getattr(route, "dependant", None).dependencies if getattr(route, "dependant", None) else []:
            if "permission" in str(dep.call).lower() or "owner" in str(dep.call).lower():
                app.dependency_overrides[dep.call] = _fake_user
    return app


@pytest.fixture
def service_mocks() -> dict[str, AsyncMock]:
    """Replace every service singleton's called method with an AsyncMock
    for the duration of one test, restoring originals on teardown.

    Ponytail: the singletons in the route module are class instances
    (``ApprovalGrantService()`` etc.). We swap the SINGLE method the
    route under test calls (``_grants.create_grant``), then restore it
    on yield. This avoids polluting tests that run later in the same
    process — the existing CRUD tests share the same singletons.
    """
    mod = importlib.import_module("eden.api.routes.intelligence_code_change")
    targets = {
        "connect_repo": ("_repo_connector", "connect"),
        "list_repos": ("_repo_connector", "list_repos"),
        "get_repo": ("_repo_connector", "get_repo"),
        "disconnect_repo": ("_repo_connector", "disconnect"),
        "update_policy": ("_policy", "update"),
        "get_policy": ("_policy", "get"),
        "generate_patch": ("_patch_generator", "generate"),
        "inbox_action": ("_review", "act"),
        "create_grant": ("_grants", "create_grant"),
        "revoke_grant": ("_grants", "revoke_grant"),
        "list_grants": ("_grants", "list_grants"),
        "create_delegation": ("_delegations", "create_delegation"),
        "list_delegations": ("_delegations", "list_delegations"),
        "auto_approval_evaluate": ("_auto_approval_rules", "evaluate"),
        "auto_approval_dry_run": ("_auto_approval_dry_run", "run"),
        "auto_approval_metrics": ("_auto_approval_metrics", "collect"),
    }
    mocks: dict[str, AsyncMock] = {}
    originals: list[tuple[Any, str, Any]] = []
    for route_name, (singleton_attr, method_name) in targets.items():
        singleton = getattr(mod, singleton_attr)
        originals.append((singleton, method_name, getattr(singleton, method_name)))
        method_mock = AsyncMock(
            return_value={"ok": True, "route": route_name, "data": {}}
        )
        setattr(singleton, method_name, method_mock)
        mocks[route_name] = method_mock

    # Mock the policy resolver for auto_approval_evaluate.
    policy_mod = importlib.import_module("eden.code_change.policy")
    policy_original = getattr(policy_mod, "get_org_code_change_policy", None)
    if policy_original is not None:
        policy_mock = AsyncMock(
            return_value={"code_change_enabled": False, "auto_pr_enabled": False}
        )
        setattr(policy_mod, "get_org_code_change_policy", policy_mock)
        originals.append((policy_mod, "get_org_code_change_policy", policy_original))

    yield mocks

    # Restore — must run even if the test failed mid-way.
    for singleton, method_name, original in originals:
        try:
            setattr(singleton, method_name, original)
        except Exception:  # noqa: BLE001
            pass


def _build_app(service_mocks: dict[str, AsyncMock]) -> FastAPI:
    """Build a minimal FastAPI app that mounts the Cat 23 router with
    all destructive deps overridden to admin.
    """
    from eden.api.deps import get_current_user, require_org_member, require_org_admin, require_org_permission_dep
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True

    app = FastAPI(title="eden-cat23-audit-test")
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = _fake_user

    mod = importlib.import_module("eden.api.routes.intelligence_code_change")
    app.include_router(mod.router)

    app.dependency_overrides[require_org_admin] = _fake_user
    return app


# ─── S-4 cases ──────────────────────────────────────────────────────
def test_create_grant_does_not_accept_body_grantor(
    service_mocks: dict[str, AsyncMock],
) -> None:
    """``POST /settings/approvals/grants`` — body has no ``granted_by_user_id``.
    The route MUST use ``user['user_id']``, not anything from the body.
    """
    app = _build_app(service_mocks)
    client = TestClient(app)
    # Body includes a FORGED granted_by_user_id AND a real granted_user_id.
    # The schema drops the forged field; the service call gets the auth
    # user id (auth-user-AAA), not the forged id.
    resp = client.post(
        "/orgs/org-test/intelligence/code-change/settings/approvals/grants",
        json={
            "granted_user_id": "user-grantee",
            "granted_by_user_id": "FORGED-user-ZZZ",  # MUST be ignored
            "scope_type": "repo",
            "scope_value": "acme/widgets",
            "reason": "test",
        },
    )
    assert resp.status_code == 200, resp.text
    mock = service_mocks["create_grant"]
    kwargs = mock.call_args.kwargs
    assert kwargs["granted_user_id"] == "user-grantee"  # body is fine
    assert kwargs["granted_by_user_id"] == "auth-user-AAA"  # auth context


def test_revoke_grant_uses_auth_user_not_body(
    service_mocks: dict[str, AsyncMock],
) -> None:
    """``DELETE /settings/approvals/grants/{grant_id}`` — no body field,
    route injects ``revoked_by_user_id = user['user_id']``.
    """
    app = _build_app(service_mocks)
    client = TestClient(app)
    resp = client.delete(
        "/orgs/org-test/intelligence/code-change/settings/approvals/grants/grant-1"
    )
    assert resp.status_code == 200, resp.text
    mock = service_mocks["revoke_grant"]
    assert mock.call_args.kwargs["revoked_by_user_id"] == "auth-user-AAA"


def test_create_delegation_uses_auth_user_as_delegator(
    service_mocks: dict[str, AsyncMock],
) -> None:
    """``POST /settings/approvals/delegations`` — body has no
    ``delegator_user_id`` field; route uses the auth user.
    """
    app = _build_app(service_mocks)
    client = TestClient(app)
    resp = client.post(
        "/orgs/org-test/intelligence/code-change/settings/approvals/delegations",
        json={
            "delegate_user_id": "user-b",
            "starts_at": "2026-01-01T00:00:00Z",
            "ends_at": "2026-12-31T23:59:59Z",
            "scope_filter": "",
        },
    )
    assert resp.status_code == 200, resp.text
    mock = service_mocks["create_delegation"]
    assert mock.call_args.kwargs["delegator_user_id"] == "auth-user-AAA"


def test_inbox_action_uses_auth_user_as_actor(
    service_mocks: dict[str, AsyncMock],
) -> None:
    """``POST /inbox/{patch_id}/{action}`` — the InboxActionRequest schema
    no longer exposes ``actor_user_id``. The route passes
    ``actor_user_id=user['user_id']`` regardless of body.
    """
    app = _build_app(service_mocks)
    client = TestClient(app)
    resp = client.post(
        "/orgs/org-test/intelligence/code-change/inbox/patch-1/approve",
        json={
            "action": "approve",
            "comment": "lgtm",
            "actor_user_id": "FORGED-user-ZZZ",  # MUST be dropped by schema
        },
    )
    assert resp.status_code == 200, resp.text
    mock = service_mocks["inbox_action"]
    assert mock.call_args.kwargs["actor_user_id"] == "auth-user-AAA"


def test_auto_approval_dry_run_uses_auth_user_as_requester(
    service_mocks: dict[str, AsyncMock],
) -> None:
    """``POST /settings/auto-approval/dry-run`` — schema has no
    ``requested_by_user_id``; route injects from auth.
    """
    app = _build_app(service_mocks)
    client = TestClient(app)
    resp = client.post(
        "/orgs/org-test/intelligence/code-change/settings/auto-approval/dry-run",
        json={"window_days": 30},
    )
    assert resp.status_code == 200, resp.text
    mock = service_mocks["auto_approval_dry_run"]
    assert mock.call_args.kwargs["requested_by_user_id"] == "auth-user-AAA"


def test_auto_approval_evaluate_reads_policy_from_db_not_body(
    service_mocks: dict[str, AsyncMock],
) -> None:
    """``POST /settings/auto-approval/evaluate`` — body has no ``policy``
    field; route resolves server-side via ``get_org_code_change_policy``.
    A body attempting to enable auto-mode MUST be ignored.

    Ponytail: the smallest assertion that fails if the fix is reverted
    is ``mock.call_args.kwargs["policy"] == <DB value>``. The route
    passes the DB-resolved policy to the service; the body-supplied
    ``policy`` is dropped by the schema and never reaches the service.
    """
    db_policy = {"code_change_enabled": False, "auto_pr_enabled": False}

    # Override the resolver the route calls (function-local import).
    from eden.code_change import policy as policy_mod

    async def _db(org_id: str) -> dict[str, Any]:
        return db_policy

    original = getattr(policy_mod, "get_org_code_change_policy", None)
    setattr(policy_mod, "get_org_code_change_policy", _db)
    try:
        app = _build_app(service_mocks)
        client = TestClient(app)
        resp = client.post(
            "/orgs/org-test/intelligence/code-change/settings/auto-approval/evaluate",
            json={
                "patch_id": "patch-1",
                "metrics": {},
                "policy": {"code_change_enabled": True, "auto_pr_enabled": True},
            },
        )
        assert resp.status_code == 200, resp.text
        mock = service_mocks["auto_approval_evaluate"]
        assert mock.call_args.kwargs["policy"] == db_policy
        assert mock.call_args.kwargs["patch_id"] == "patch-1"
    finally:
        if original is not None:
            setattr(policy_mod, "get_org_code_change_policy", original)
