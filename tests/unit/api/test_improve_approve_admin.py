"""Wave 6 — improve approve requires org admin (closed_loop path)."""

from __future__ import annotations

import inspect
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user


def test_improve_item_approve_closed_loop_requires_admin() -> None:
    """Non-admin members must get 403 on closed_loop approve."""
    from eden.api.routes import improve as improve_routes

    app = FastAPI()

    async def _fake_user() -> dict:
        return {"id": "user_viewer", "email": "v@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    async def _payload() -> dict:
        return {"sub": "user_viewer"}

    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[improve_routes.require_path_org_access] = _path_org
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
            "/orgs/org_1/improve/items/closed_loop%3Aaction_99/approve",
        )

    assert resp.status_code == 403
    assert "Admin or owner" in resp.text
    approve_mock.assert_not_called()


def test_improve_approve_source_gates_admin_on_closed_loop() -> None:
    from eden.api.routes import improve as improve_routes

    src = inspect.getsource(improve_routes.approve)
    closed_idx = src.index("closed_loop:")
    plan_idx = src.index("improvement_plan:")
    assert "require_org_admin" in src[closed_idx:plan_idx]
