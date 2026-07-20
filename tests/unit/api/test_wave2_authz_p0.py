"""Wave 2/4 Authz P0s — SSO list IDOR, judges:run, improve/closed-loop approve gates."""

from __future__ import annotations

import inspect
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


def test_list_sso_providers_requires_org_admin() -> None:
    from eden.api.routes import sso as sso_routes

    src = inspect.getsource(sso_routes.list_sso_providers)
    assert "require_org_admin" in src
    assert "payload" in src


def test_list_sso_providers_non_admin_forbidden() -> None:
    from eden.api.routes import sso as sso_routes

    app = FastAPI()
    app.include_router(sso_routes.router)
    app.dependency_overrides[sso_routes.get_current_user] = lambda: {
        "user_id": "u-1",
        "email": "x@y.z",
    }
    app.dependency_overrides[sso_routes._try_resolve_token_payload] = lambda: {
        "sub": "u-1",
    }

    async def _deny(_org_id: str | None = None, _payload: dict | None = None):
        raise HTTPException(status_code=403, detail="Admin or owner role required")

    with patch.object(sso_routes, "require_org_admin", side_effect=_deny):
        client = TestClient(app)
        r = client.get("/sso/providers", params={"org_id": "org-foreign"})
    assert r.status_code == 403


def test_run_judges_requires_judges_run() -> None:
    from eden.api.routes import judges as judges_routes

    src = inspect.getsource(judges_routes.run_judges)
    assert "require_judges_run" in src


def test_run_judges_viewer_forbidden() -> None:
    from eden.api.routes import judges as judges_routes

    app = FastAPI()
    app.include_router(judges_routes.router)

    app.dependency_overrides[judges_routes.get_current_user] = lambda: {
        "user_id": "u-1",
        "email": "x@y.z",
    }
    app.dependency_overrides[judges_routes._require_path_org] = lambda: "org-A"
    app.dependency_overrides[judges_routes._try_resolve_token_payload] = lambda: {
        "sub": "u-1",
    }

    async def _deny_viewer(x_org_id: str | None = None, payload: dict | None = None):
        raise HTTPException(status_code=403, detail="Permission denied: judges:run")

    with patch.object(judges_routes, "require_judges_run", side_effect=_deny_viewer):
        client = TestClient(app)
        r = client.post(
            "/orgs/org-A/observability/judges/run",
            json={"trace_id": "tr-1", "sync": True},
        )
    assert r.status_code == 403
    assert "judges:run" in r.text


def test_item_approve_improvement_plan_requires_agent_v1() -> None:
    from eden.api.routes import improve as improve_routes

    app = FastAPI()

    async def _fake_user() -> dict:
        return {"id": "user_1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    app.dependency_overrides[improve_routes.get_current_user] = _fake_user
    app.dependency_overrides[improve_routes._require_path_org] = _path_org
    app.include_router(improve_routes.router)
    client = TestClient(app)

    with patch.object(
        improve_routes,
        "_require_agent_v1_async",
        new=AsyncMock(
            side_effect=HTTPException(
                status_code=503,
                detail="improvement_agent_v1 is disabled for this org",
            )
        ),
    ), patch.object(
        improve_routes,
        "approve_plan",
        new=AsyncMock(return_value={"status": "ok"}),
    ) as approve_mock:
        resp = client.post(
            "/orgs/org_1/improve/items/improvement_plan%3Aplan_1/approve",
        )
    assert resp.status_code == 503
    assert "improvement_agent_v1" in resp.text
    approve_mock.assert_not_called()


def test_item_approve_improvement_plan_gates_like_plan_approve() -> None:
    from eden.api.routes import improve as improve_routes

    assert "_require_agent_v1_async" in inspect.getsource(improve_routes.approve)
    assert "_require_agent_v1_async" in inspect.getsource(
        improve_routes.approve_plan_route
    )


def test_item_approve_closed_loop_requires_org_admin() -> None:
    """closed_loop: item-approve must not run on bare membership."""
    from eden.api.routes import improve as improve_routes

    app = FastAPI()

    async def _fake_user() -> dict:
        return {"id": "user_1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    async def _payload() -> dict:
        return {"sub": "user_1"}

    app.dependency_overrides[improve_routes.get_current_user] = _fake_user
    app.dependency_overrides[improve_routes._require_path_org] = _path_org
    app.dependency_overrides[improve_routes._try_resolve_token_payload] = _payload
    app.include_router(improve_routes.router)
    client = TestClient(app)

    with patch.object(
        improve_routes,
        "require_org_admin",
        new=AsyncMock(
            side_effect=HTTPException(
                status_code=403,
                detail="Admin or owner role required",
            )
        ),
    ), patch(
        "eden.llmops.closed_loop_executor.ClosedLoopExecutor.approve",
        new=AsyncMock(return_value={"status": "approved"}),
    ) as approve_mock:
        resp = client.post(
            "/orgs/org_1/improve/items/closed_loop%3Aaction_1/approve",
        )
    assert resp.status_code == 403
    assert "Admin or owner" in resp.text
    approve_mock.assert_not_called()


def test_item_approve_closed_loop_requires_agent_v1() -> None:
    """closed_loop: item-approve must not run when Improve agent_v1 is off."""
    from eden.api.routes import improve as improve_routes

    app = FastAPI()

    async def _fake_user() -> dict:
        return {"id": "user_1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    async def _payload() -> dict:
        return {"sub": "user_1"}

    app.dependency_overrides[improve_routes.get_current_user] = _fake_user
    app.dependency_overrides[improve_routes._require_path_org] = _path_org
    app.dependency_overrides[improve_routes._try_resolve_token_payload] = _payload
    app.include_router(improve_routes.router)
    client = TestClient(app)

    with patch.object(
        improve_routes,
        "require_org_admin",
        new=AsyncMock(return_value={"user_id": "user_1", "role": "admin"}),
    ), patch.object(
        improve_routes,
        "_require_agent_v1_async",
        new=AsyncMock(
            side_effect=HTTPException(
                status_code=503,
                detail="improvement_agent_v1 is disabled for this org",
            )
        ),
    ), patch(
        "eden.llmops.closed_loop_executor.ClosedLoopExecutor.approve",
        new=AsyncMock(return_value={"status": "approved"}),
    ) as approve_mock:
        resp = client.post(
            "/orgs/org_1/improve/items/closed_loop%3Aaction_1/approve",
        )
    assert resp.status_code == 503
    assert "improvement_agent_v1" in resp.text
    approve_mock.assert_not_called()


def test_item_approve_closed_loop_source_gates_org_admin() -> None:
    from eden.api.routes import improve as improve_routes

    src = inspect.getsource(improve_routes.approve)
    assert "closed_loop:" in src
    assert "require_org_admin" in src
    # Both admin and agent_v1 must appear in the closed_loop branch.
    closed_idx = src.index("closed_loop:")
    plan_idx = src.index("improvement_plan:")
    closed_branch = src[closed_idx:plan_idx]
    assert "require_org_admin" in closed_branch
    assert "_require_agent_v1_async" in closed_branch


def test_intelligence_closed_loop_approve_requires_org_admin() -> None:
    """POST /actions/{id}/approve must gate beyond bare membership."""
    from eden.api.routes import intelligence_closed_loop as cl_routes

    app = FastAPI()

    async def _fake_user() -> dict:
        return {"id": "user_1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    async def _payload() -> dict:
        return {"sub": "user_1"}

    async def _flag_on() -> None:
        return None

    app.dependency_overrides[cl_routes.get_current_user] = _fake_user
    app.dependency_overrides[cl_routes.require_path_org_access] = _path_org
    app.dependency_overrides[cl_routes._try_resolve_token_payload] = _payload
    for route in cl_routes.router.routes:
        if not hasattr(route, "dependant"):
            continue
        for dep in route.dependant.dependencies:
            if getattr(dep.call, "__name__", "") == "_dependency":
                app.dependency_overrides[dep.call] = _flag_on
    app.include_router(cl_routes.router)
    client = TestClient(app)

    with patch.object(
        cl_routes,
        "require_org_admin",
        new=AsyncMock(
            side_effect=HTTPException(
                status_code=403,
                detail="Admin or owner role required",
            )
        ),
    ), patch.object(
        cl_routes._executor,
        "approve",
        new=AsyncMock(return_value={"status": "ok", "data": {"status": "approved"}}),
    ) as approve_mock:
        resp = client.post(
            "/orgs/org_1/intelligence/closed-loop/actions/a1/approve",
        )
    assert resp.status_code == 403
    assert "Admin or owner" in resp.text
    approve_mock.assert_not_called()


def test_intelligence_closed_loop_approve_source_gates_org_admin() -> None:
    from eden.api.routes import intelligence_closed_loop as cl_routes

    src = inspect.getsource(cl_routes.approve)
    assert "require_org_admin" in src


def test_intelligence_closed_loop_deny_requires_org_admin() -> None:
    """POST /actions/{id}/deny must gate beyond bare membership."""
    from eden.api.routes import intelligence_closed_loop as cl_routes

    app = FastAPI()

    async def _fake_user() -> dict:
        return {"id": "user_1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    async def _payload() -> dict:
        return {"sub": "user_1"}

    async def _flag_on() -> None:
        return None

    app.dependency_overrides[cl_routes.get_current_user] = _fake_user
    app.dependency_overrides[cl_routes.require_path_org_access] = _path_org
    app.dependency_overrides[cl_routes._try_resolve_token_payload] = _payload
    for route in cl_routes.router.routes:
        if not hasattr(route, "dependant"):
            continue
        for dep in route.dependant.dependencies:
            if getattr(dep.call, "__name__", "") == "_dependency":
                app.dependency_overrides[dep.call] = _flag_on
    app.include_router(cl_routes.router)
    client = TestClient(app)

    with patch.object(
        cl_routes,
        "require_org_admin",
        new=AsyncMock(
            side_effect=HTTPException(
                status_code=403,
                detail="Admin or owner role required",
            )
        ),
    ), patch.object(
        cl_routes._executor,
        "deny",
        new=AsyncMock(return_value={"status": "ok", "data": {"status": "denied"}}),
    ) as deny_mock:
        resp = client.post(
            "/orgs/org_1/intelligence/closed-loop/actions/a1/deny",
        )
    assert resp.status_code == 403
    assert "Admin or owner" in resp.text
    deny_mock.assert_not_called()


def test_intelligence_closed_loop_deny_source_gates_org_admin() -> None:
    from eden.api.routes import intelligence_closed_loop as cl_routes

    src = inspect.getsource(cl_routes.deny)
    assert "require_org_admin" in src
    assert "payload" in src


def test_intelligence_closed_loop_stays_on_intelligence_gap_flag() -> None:
    """Intelligence closed-loop must NOT mirror Improve's agent_v1 gate."""
    from eden.api.routes import intelligence_closed_loop as cl_routes

    module_src = inspect.getsource(cl_routes)
    assert "intelligence_gap_v0" in module_src
    # Route handlers must not invoke Improve's agent_v1 gate.
    for fn in (cl_routes.approve, cl_routes.deny, cl_routes.apply):
        body = inspect.getsource(fn)
        assert "_require_agent_v1_async" not in body
        assert "improvement_agent_enabled" not in body
        assert "improvement_agent_v1" not in body
