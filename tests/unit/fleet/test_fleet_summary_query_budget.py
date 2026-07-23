"""FleetHealthService.summary must stay O(1) DB round-trips vs agent count."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.fleet.service import FleetHealthService


class _Row(dict):
    """dict that also supports attribute access like asyncpg.Record."""

    pass


class _CountingClient:
    """Minimal asyncpg-like client that counts fetch/execute calls."""

    def __init__(self, registry_rows: list[dict[str, Any]]) -> None:
        self.registry_rows = registry_rows
        self.fetch_calls = 0
        self.execute_calls = 0
        self.fetchrow_calls = 0

    async def execute(self, query: str, *args: Any) -> str:
        self.execute_calls += 1
        return "INSERT 0 0"

    async def fetch(self, query: str, *args: Any) -> list[Any]:
        self.fetch_calls += 1
        q = " ".join(query.lower().split())
        if "from agent_registry" in q and "group by" not in q:
            return [_Row(r) for r in self.registry_rows]
        # Aggregate queries return empty — metrics default to zeros.
        return []

    async def fetchrow(self, query: str, *args: Any) -> Any:
        self.fetchrow_calls += 1
        return None


def _row(agent_id: str) -> dict[str, Any]:
    return {
        "agent_id": agent_id,
        "display_name": agent_id,
        "tier": "standard",
        "slo_config": {},
        "last_seen": None,
    }


@pytest.mark.asyncio
async def test_summary_query_count_bounded_vs_agent_count() -> None:
    """50 agents must not produce ~250 SELECTs (old N+1); stay under a fixed budget."""
    n = 50
    client = _CountingClient([_row(f"agent-{i}") for i in range(n)])
    svc = FleetHealthService()

    async def _client() -> Any:
        return client

    with (
        patch.object(svc, "_client", _client),
        patch(
            "eden.closed_loop.autonomy_policy.resolve",
            new_callable=AsyncMock,
        ) as resolve_mock,
    ):
        from eden.closed_loop.autonomy_policy import AutonomousMaintenancePolicy

        resolve_mock.return_value = AutonomousMaintenancePolicy(org_id="org-1")
        result = await svc.summary("org-1")

    assert result["count"] == n, result
    # Budget: 1 registry SELECT + ≤4 metric aggregates + 1 autonomy SELECT
    # (+ 1 ensure-registry execute). Must NOT scale with n.
    total_reads = client.fetch_calls + client.fetchrow_calls
    assert total_reads <= 8, f"expected ≤8 reads, got {total_reads}"
    assert client.fetchrow_calls == 0, "per-agent fetchrow must not be used"
    # Old path: 5 fetchrow per agent = 250. Guard against regression.
    assert total_reads < n, f"reads ({total_reads}) must be O(1), not O(n={n})"


@pytest.mark.asyncio
async def test_summary_empty_registry() -> None:
    client = _CountingClient([])
    svc = FleetHealthService()

    async def _client() -> Any:
        return client

    with patch.object(svc, "_client", _client):
        result = await svc.summary("org-1")
    assert result["count"] == 0
    assert result["agents"] == []
