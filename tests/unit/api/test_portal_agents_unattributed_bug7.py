"""BUG-7 — telemetry/issues whose events never got an agent_id stamped
must not be silently dropped from the Agents dashboard.

``_load_metrics``'s ``recent`` CTE and ``_load_open_issues`` both filter
``agent_id IS NOT NULL``, so any trace/issue with no agent_id anywhere
on it simply vanishes from every per-agent card. This guards the fix: an
explicit "Unattributed" aggregate surfaces that excluded volume instead
of letting it disappear.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.api.routes import portal as portal_mod


class _FakeClient:
    """Routed by SQL shape, like the BUG-6 fake this mirrors."""

    def __init__(
        self,
        *,
        unattributed_runs: int = 0,
        unattributed_cost: float | None = None,
        unattributed_open_issues: int = 0,
        unattributed_open_p0: int = 0,
    ):
        self._unattributed_runs = unattributed_runs
        self._unattributed_cost = unattributed_cost
        self._unattributed_open_issues = unattributed_open_issues
        self._unattributed_open_p0 = unattributed_open_p0

    async def fetch(self, query: str, *args):
        if "FROM agent_registrations" in query:
            return []
        if "FROM agent_identity_aliases" in query:
            return []
        if "trace_pref AS (" in query:
            return []
        if "percentile_cont(0.5)" in query:
            # Per-agent metrics: no registered/discovered agents in
            # this repro, so the by-agent breakdown is empty.
            return []
        if "agent_id IS NULL" in query and "FROM telemetry_events" in query:
            return [
                {
                    "runs": self._unattributed_runs,
                    "cost_usd": self._unattributed_cost,
                }
            ]
        if "agent_id IS NULL" in query and "FROM agent_issues" in query:
            return [
                {
                    "open_issues": self._unattributed_open_issues,
                    "open_p0": self._unattributed_open_p0,
                }
            ]
        if "GROUP BY agent_id" in query and "FROM agent_issues" in query:
            return []
        raise AssertionError(f"unexpected query in fake client: {query[:120]}")

    async def execute(self, query: str, *args):
        return "OK"


@pytest.mark.asyncio
async def test_unattributed_card_surfaces_excluded_traffic():
    fake = _FakeClient(
        unattributed_runs=7,
        unattributed_cost=3.5,
        unattributed_open_issues=2,
        unattributed_open_p0=1,
    )
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=fake),
    ):
        cards = await portal_mod.list_portal_agents(
            org_id="org_1", window="24h", _user={"sub": "u1"}
        )

    ids = [c.id for c in cards]
    assert portal_mod.UNATTRIBUTED_AGENT_ID in ids, (
        "excluded runs/issues must render as an explicit card, not vanish"
    )
    card = next(c for c in cards if c.id == portal_mod.UNATTRIBUTED_AGENT_ID)
    assert card.runs24h == 7
    assert card.costUsd24h == 3.5
    assert card.openIssues == 2
    # A p0 among the unattributed issues should read as "needs attention".
    assert card.status == "error"
    assert card.name == "Unattributed"


@pytest.mark.asyncio
async def test_unattributed_card_omitted_when_nothing_excluded():
    """No fabricated clutter: a healthy tenant with fully-attributed
    traffic must not render an all-zero Unattributed card."""
    fake = _FakeClient()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=fake),
    ):
        cards = await portal_mod.list_portal_agents(
            org_id="org_1", window="24h", _user={"sub": "u1"}
        )

    ids = [c.id for c in cards]
    assert portal_mod.UNATTRIBUTED_AGENT_ID not in ids


@pytest.mark.asyncio
async def test_unattributed_metrics_query_scopes_by_tenant_not_org():
    """telemetry_events keys on tenant_id, not org_id — verified against
    ``_load_metrics``'s own CTE, which uses ``WHERE tenant_id = $1``."""
    import inspect

    src = inspect.getsource(portal_mod.list_portal_agents)
    unattributed_region = src.split("_load_unattributed_metrics")[1].split(
        "_load_unattributed_issues"
    )[0]
    assert "WHERE tenant_id = $1" in unattributed_region
    assert "agent_id IS NULL" in unattributed_region
