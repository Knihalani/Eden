"""M4 (D12) — GET /orgs/{org_id}/settings/autonomy/budget.

One endpoint answers "why didn't Eden act": today's unified maintenance
spend vs cap (``check_budget``), the code-patch count vs
``patch_max_per_day``, and today's suppressed-by-budget audit rows
(decision='deny', tier='budget').
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from eden.closed_loop.autonomy_policy import AutonomousMaintenancePolicy

ORG = "org_test"


def _policy(**overrides: Any) -> AutonomousMaintenancePolicy:
    return AutonomousMaintenancePolicy(org_id=ORG, **overrides)


def _client() -> Any:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from eden.api.deps import get_current_user, require_path_org_access

    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: {
        "sub": "u1",
        "org_id": ORG,
    }
    app.dependency_overrides[require_path_org_access] = lambda: ORG
    import eden.api.routes.autonomy as mod

    async def _flag_on() -> None:
        return None

    for r in mod.router.routes:
        if not hasattr(r, "dependant"):
            continue
        for d in r.dependant.dependencies:
            if d.call.__name__ == "_dependency":
                app.dependency_overrides[d.call] = _flag_on
    app.include_router(mod.router)
    return TestClient(app)


def test_budget_route_reports_spend_caps_and_suppressions() -> None:
    from eden.closed_loop import autonomy_policy as ap
    from eden.improvement import plans_repo

    audit_row = {
        "id": uuid.uuid4(),
        "agent_id": None,
        "action": "maintenance",
        "tier_applied": "budget",
        "decision": "deny",
        "reason": "daily maintenance budget exhausted",
        "created_at": datetime.now(UTC),
    }
    pg = MagicMock()
    pg.fetch = AsyncMock(return_value=[audit_row])

    with (
        patch.object(ap, "resolve", new=AsyncMock(return_value=_policy())),
        patch.object(
            ap, "check_budget", new=AsyncMock(return_value=(False, 30.0, 25.0))
        ),
        patch.object(
            plans_repo, "count_code_patches_today", new=AsyncMock(return_value=4)
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=pg),
        ),
    ):
        r = _client().get(f"/orgs/{ORG}/settings/autonomy/budget")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    data = body["data"]
    assert data["budget"] == {
        "spent_usd": 30.0,
        "limit_usd": 25.0,
        "within_budget": False,
    }
    assert data["patches"]["used_today"] == 4
    assert data["patches"]["max_per_day"] == 10
    assert data["patches"]["within_cap"] is True
    assert data["suppressed_count"] == 1
    row = data["suppressed_by_budget"][0]
    assert row["decision"] == "deny"
    assert row["tier_applied"] == "budget"
    # datetime/uuid serialized, not repr'd objects.
    assert isinstance(row["created_at"], str)
    assert isinstance(row["id"], str)

    # The audit query is scoped: today's budget denials only.
    q = pg.fetch.await_args.args[0]
    assert "decision = 'deny'" in q
    assert "tier_applied = 'budget'" in q
    assert "date_trunc('day'" in q


def test_budget_route_degrades_without_postgres() -> None:
    from eden.closed_loop import autonomy_policy as ap
    from eden.improvement import plans_repo

    with (
        patch.object(ap, "resolve", new=AsyncMock(return_value=_policy())),
        patch.object(
            ap, "check_budget", new=AsyncMock(return_value=(True, 0.5, 25.0))
        ),
        patch.object(
            plans_repo, "count_code_patches_today", new=AsyncMock(return_value=0)
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ),
    ):
        r = _client().get(f"/orgs/{ORG}/settings/autonomy/budget")

    assert r.status_code == 200
    data = r.json()["data"]
    assert data["budget"]["within_budget"] is True
    assert data["suppressed_by_budget"] == []
    assert data["suppressed_count"] == 0
