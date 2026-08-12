"""Wave 5 pinning tests — 5.1 canaries route + 5.2 autonomy agents route.

Both are thin read routes added for the portal surfaces:
``GET /orgs/{org_id}/prompts/canaries`` (org-wide canary experiments for
the cockpit) and ``GET /orgs/{org_id}/settings/autonomy/agents``
(per-agent policy rows for the settings matrix).
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
