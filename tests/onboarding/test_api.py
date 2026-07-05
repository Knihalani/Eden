"""D.14 onboarding API route tests (upgradespec §G.1).

Three tests covering the 4 routes:
- ``GET  /v1/internal/onboarding/{org_id}/state``
- ``POST /v1/internal/onboarding/{org_id}/advance``
- ``POST /v1/internal/onboarding/{org_id}/milestone``
- ``POST /v1/internal/onboarding/{org_id}/enable_cat``

We use ``app.dependency_overrides`` to stub the auth deps
(``patch`` doesn't work for FastAPI's ``Depends`` because
the function reference is captured at route-registration
time).
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

# ── helpers ───────────────────────────────────────────────────────────


def _state_row(
    org_id: str = "00000000-0000-0000-0000-000000000001",
    current_step: str = "install",
    completed_steps: list[str] | None = None,
    milestones_reached: list[str] | None = None,
) -> dict:
    now = datetime.now(UTC)
    return {
        "org_id": org_id,
        "current_step": current_step,
        "completed_steps": completed_steps or [],
        "cat_enablements": {},
        "first_trace_at": None,
        "milestones_reached": milestones_reached or [],
        "created_at": now,
        "updated_at": now,
    }


async def _fake_user() -> dict:
    """Stands in for ``get_current_user`` — the test is
    not exercising the JWT path."""
    return {"id": "u-1", "email": "t@test.io", "sub": "u-1"}


async def _fake_member() -> dict:
    return {"id": "u-1", "role": "member"}


async def _fake_admin() -> dict:
    return {"id": "u-1", "role": "admin"}


async def _deny_admin() -> None:
    raise HTTPException(status_code=403, detail="admin only")


@pytest.fixture
def onboarding_client(mock_postgres_client: MagicMock) -> TestClient:
    """TestClient with auth deps stubbed via ``dependency_overrides``.

    ``patch`` doesn't work for FastAPI ``Depends`` because the
    function reference is captured at route-registration time;
    ``app.dependency_overrides`` is the official override
    mechanism and works regardless of when the route was
    registered.
    """
    from eden.api.app import app
    from eden.api.deps import (
        get_current_user,
        require_org_admin,
        require_org_member,
    )

    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = _fake_member
    app.dependency_overrides[require_org_admin] = _fake_admin
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


# ── 3 route tests ─────────────────────────────────────────────────────


class TestOnboardingApi:
    """The 3 spec-mandated API tests (upgradespec §G.1)."""

    def test_get_state_returns_current_step(
        self, mock_postgres_client: MagicMock, onboarding_client: TestClient,
    ):
        """GET /state returns the row from the DB plus the 7-step list."""
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM onboarding_state", _state_row(current_step="connect"))
        )
        response = onboarding_client.get(
            "/v1/internal/onboarding/org-1/state",
            headers={"X-Org-Id": "org-1"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "ok"
        assert body["data"]["current_step"] == "connect"
        assert body["data"]["source"] == "db"
        # The 7-step list comes back too (the portal uses it
        # to render the checklist without re-importing the enum).
        assert body["steps"] == [
            "install", "org", "connect", "wait", "done", "tour", "autonomous",
        ]

    def test_advance_requires_org_admin(
        self, mock_postgres_client: MagicMock,
    ):
        """POST /advance without org-admin gating MUST 403.

        A second TestClient (separate from the fixture) overrides
        ``require_org_admin`` to raise 403 — mirroring the real
        RBAC: members can read state, only admins can advance.
        """
        from eden.api.app import app
        from eden.api.deps import (
            get_current_user,
            require_org_admin,
            require_org_member,
        )
        app.dependency_overrides[get_current_user] = _fake_user
        app.dependency_overrides[require_org_member] = _fake_member
        app.dependency_overrides[require_org_admin] = _deny_admin
        try:
            client = TestClient(app)
            response = client.post(
                "/v1/internal/onboarding/org-1/advance",
                json={"target_step": "org", "force": False},
                headers={"X-Org-Id": "org-1"},
            )
        finally:
            app.dependency_overrides.clear()
        # 403 is the "denied" path — the test asserts the route
        # IS gated, not the underlying advance.
        assert response.status_code == 403

    def test_milestone_endpoint_advances_to_done(
        self, mock_postgres_client: MagicMock, onboarding_client: TestClient,
    ):
        """POST /milestone with body ``{milestone: "first_judge_score"}``
        records the milestone AND auto-advances to 'done' (per
        ``MILESTONE_ADVANCES``).

        Queue 4 SELECTs (see test_state_machine for the call sequence).
        """
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM onboarding_state", _state_row(current_step="wait"))
        )
        # After milestone recorded (in-DB view).
        mock_postgres_client._fetchrow_overrides.append(
            (
                "FROM onboarding_state",
                _state_row(
                    current_step="wait",
                    milestones_reached=["first_judge_score"],
                ),
            )
        )
        # Same view from the auto-advance's get_state.
        mock_postgres_client._fetchrow_overrides.append(
            (
                "FROM onboarding_state",
                _state_row(
                    current_step="wait",
                    milestones_reached=["first_judge_score"],
                ),
            )
        )
        # After the advance is upserted.
        mock_postgres_client._fetchrow_overrides.append(
            (
                "FROM onboarding_state",
                _state_row(
                    current_step="done",
                    completed_steps=["wait"],
                    milestones_reached=["first_judge_score"],
                ),
            )
        )
        response = onboarding_client.post(
            "/v1/internal/onboarding/org-1/milestone",
            json={"milestone": "first_judge_score"},
            headers={"X-Org-Id": "org-1"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["data"]["current_step"] == "done"
        assert "first_judge_score" in body["data"]["milestones_reached"]
        assert "wait" in body["data"]["completed_steps"]
