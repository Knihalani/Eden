"""Wave 5 pinning tests — 5.1 canaries route + 5.2 autonomy agents route.

Both are thin read routes added for the portal surfaces:
``GET /orgs/{org_id}/prompts/canaries`` (org-wide canary experiments for
the cockpit) and ``GET /orgs/{org_id}/settings/autonomy/agents``
(per-agent policy rows for the settings matrix).

W3-9 (9.8): also tests the PATCH split-update route added for the
traffic-split control on /prompts.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_list_org_canaries_returns_across_agents() -> None:
    from eden.api.routes.prompt_canary import list_org_canaries

    client = AsyncMock()
    client.fetch = AsyncMock(
        return_value=[
            {
                "experiment_id": "exp-1",
                "agent": "planner",
                "control_version": 0,
                "candidate_version": 7,
                "traffic_pct": 25,
                "started_at": "2026-08-01T00:00:00Z",
                "expires_at": None,
                "status": "active",
                "notes": "split",
            },
            {
                "experiment_id": "exp-2",
                "agent": "checkout-agent",
                "control_version": 1,
                "candidate_version": 2,
                "traffic_pct": 100,
                "started_at": "2026-07-01T00:00:00Z",
                "expires_at": None,
                "status": "promoted",
                "notes": None,
            },
        ]
    )
    with patch(
        "eden.api.routes.prompt_canary.get_postgres_client",
        AsyncMock(return_value=client),
    ):
        out = await list_org_canaries(org_id="org-1", user={})

    canaries = out["canaries"]
    assert len(canaries) == 2
    assert canaries[0]["agent"] == "planner"
    assert canaries[0]["candidate_version"] == 7
    assert canaries[1]["status"] == "promoted"
    # Org-scoped: tenant_id is the first bound arg.
    assert client.fetch.await_args.args[1] == "org-1"


class _FakePolicy:
    def __init__(self, data: dict) -> None:
        self._data = data

    def to_json(self) -> dict:
        return dict(self._data)

    def effective_mode(self) -> str:
        return str(self._data.get("maintenance_mode", "assisted"))


@pytest.mark.asyncio
async def test_get_autonomy_agents_lists_override_rows() -> None:
    from eden.api.routes.autonomy import get_agents

    client = AsyncMock()
    client.fetch = AsyncMock(
        return_value=[{"agent_id": "checkout-agent"}, {"agent_id": "planner"}]
    )
    resolved = {"maintenance_mode": "assisted", "auto_runtime_heal": True}
    # get_postgres_client / resolve are imported inside the route → patch
    # the source modules.
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.resolve",
            AsyncMock(return_value=_FakePolicy(resolved)),
        ),
    ):
        out = await get_agents(org_id="org-1", current_user={})

    assert out["data"]["count"] == 2
    agents = out["data"]["agents"]
    assert agents[0]["agent_id"] == "checkout-agent"
    assert agents[0]["has_override"] is True
    assert agents[0]["effective_mode"] == "assisted"


@pytest.mark.asyncio
async def test_get_autonomy_agents_empty() -> None:
    from eden.api.routes.autonomy import get_agents

    client = AsyncMock()
    client.fetch = AsyncMock(return_value=[])
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    ):
        out = await get_agents(org_id="org-1", current_user={})

    assert out["data"]["count"] == 0
    assert out["data"]["agents"] == []


# ── W3-9 (9.8): PATCH traffic-split update ───────────────────────────────────


@pytest.mark.asyncio
async def test_update_canary_split_success() -> None:
    """PATCH …/canary/{id} updates traffic_pct on both tables and returns the
    new value. The regression gate is bypassed via mock (≤5% needs no pass)."""
    from eden.api.routes.prompt_canary import CanaryUpdateRequest, update_canary_split

    client = AsyncMock()
    # fetchrow: experiment exists and is active
    client.fetchrow = AsyncMock(return_value={"experiment_id": "exp-1"})
    client.execute = AsyncMock()

    with (
        patch(
            "eden.api.routes.prompt_canary.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch(
            "eden.evaluation.regression_runner.RegressionRunner.require_pass_for_canary",
            AsyncMock(return_value=None),
        ),
    ):
        out = await update_canary_split(
            org_id="org-1",
            agent="planner",
            experiment_id="exp-1",
            body=CanaryUpdateRequest(traffic_pct=10),
            user={},
        )

    assert out["traffic_pct"] == 10
    assert out["status"] == "active"
    assert out["experiment_id"] == "exp-1"
    assert out["agent"] == "planner"
    # Both tables must have been updated
    assert client.execute.await_count == 2
    # Tenant scope enforced on the lookup
    assert client.fetchrow.await_args.args[2] == "org-1"


@pytest.mark.asyncio
async def test_update_canary_split_not_found() -> None:
    """PATCH returns 404 when no active experiment matches the given id."""
    from fastapi import HTTPException

    from eden.api.routes.prompt_canary import CanaryUpdateRequest, update_canary_split

    client = AsyncMock()
    client.fetchrow = AsyncMock(return_value=None)  # no active row

    with (
        patch(
            "eden.api.routes.prompt_canary.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch(
            "eden.evaluation.regression_runner.RegressionRunner.require_pass_for_canary",
            AsyncMock(return_value=None),
        ),
    ):
        try:
            await update_canary_split(
                org_id="org-1",
                agent="planner",
                experiment_id="exp-missing",
                body=CanaryUpdateRequest(traffic_pct=5),
                user={},
            )
            raise AssertionError("Expected HTTPException")
        except HTTPException as exc:
            assert exc.status_code == 404


@pytest.mark.asyncio
async def test_update_canary_split_bounds() -> None:
    """CanaryUpdateRequest rejects traffic_pct outside [1, 50]."""
    from pydantic import ValidationError

    from eden.api.routes.prompt_canary import CanaryUpdateRequest

    import pytest as _pytest

    with _pytest.raises(ValidationError):
        CanaryUpdateRequest(traffic_pct=0)

    with _pytest.raises(ValidationError):
        CanaryUpdateRequest(traffic_pct=51)

    # Boundary values must be valid
    assert CanaryUpdateRequest(traffic_pct=1).traffic_pct == 1
    assert CanaryUpdateRequest(traffic_pct=50).traffic_pct == 50
