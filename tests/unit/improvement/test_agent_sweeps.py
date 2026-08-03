"""Unit tests for N23 ImprovementAgent sweep stubs (metrics, repo, cost)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement.agent import ImprovementAgent, _z_exceeds


def test_z_exceeds_sigma_threshold() -> None:
    assert _z_exceeds(15.0, 10.0, 2.0) is True
    assert _z_exceeds(13.0, 10.0, 2.0) is False
    assert _z_exceeds(5.0, 10.0, 2.0) is False


@pytest.mark.asyncio
async def test_from_metrics_cost_spike() -> None:
    agent = ImprovementAgent()
    trace_24h = [
        {
            "agent_id": "agent-a",
            "cost_24h": 50.0,
            "p95_latency_24h": 95.0,
            "trace_count": 10,
        }
    ]
    trace_baseline = [
        {
            "agent_id": "agent-a",
            "mean_cost": 10.0,
            "std_cost": 2.0,
            "mean_p95": 90.0,
            "std_p95": 5.0,
        }
    ]

    with (
        patch("eden.improvement.agent._pg_fetch", AsyncMock()) as mock_fetch,
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
    ):
        mock_fetch.side_effect = [trace_24h, trace_baseline, [], []]
        out = await agent._from_metrics("org-1", None)

    assert len(out) == 1
    # M6 (D10): cost/latency anomalies are advisory — no config-apply path.
    assert out[0].plan_kind == "advisory"
    assert out[0].agent_id == "agent-a"
    assert out[0].evidence["metric"] == "cost"


@pytest.mark.asyncio
async def test_from_metrics_routing_mismatch() -> None:
    agent = ImprovementAgent()
    trace_24h = [
        {
            "agent_id": "agent-b",
            "cost_24h": 50.0,
            "p95_latency_24h": 500.0,
            "trace_count": 10,
        }
    ]
    trace_baseline = [
        {
            "agent_id": "agent-b",
            "mean_cost": 10.0,
            "std_cost": 2.0,
            "mean_p95": 100.0,
            "std_p95": 10.0,
        }
    ]

    with (
        patch("eden.improvement.agent._pg_fetch", AsyncMock()) as mock_fetch,
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
    ):
        mock_fetch.side_effect = [trace_24h, trace_baseline, [], []]
        out = await agent._from_metrics("org-1", None)

    assert len(out) == 1
    assert out[0].plan_kind == "guardrail_tune"
    assert out[0].evidence["metric"] == "routing_mismatch"


@pytest.mark.asyncio
async def test_from_repo_health_stale_lockfile_advisory() -> None:
    """M6: CVE hints dict deleted (spec §11); the lane still flags a
    manifest-without-lockfile as an org-scoped advisory plan."""
    agent = ImprovementAgent()
    mock_provider = MagicMock()
    # Manifest exists (comment-only → no parseable deps), no lockfile.
    mock_provider.read_file = AsyncMock(
        side_effect=lambda path: "# deps pinned by hand\n"
        if path == "requirements.txt"
        else ""
    )
    provider_for_org = AsyncMock(return_value=mock_provider)

    with (
        patch("eden.improvement.agent._github_linked", AsyncMock(return_value=True)),
        patch(
            "eden.improvement.agent._pg_fetch",
            AsyncMock(return_value=[{"agent_id": "repo-a"}]),
        ),
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.providers.factory.get_repo_provider_for_org",
            provider_for_org,
        ),
    ):
        out = await agent._from_repo_health("org-1", None)

    assert len(out) == 1
    assert out[0].plan_kind == "advisory"
    assert any(f["kind"] == "stale_lockfile" for f in out[0].evidence["findings"])
    # Drift #10: provider must be resolved for the org (+agent), never default.
    provider_for_org.assert_awaited_once_with("org-1", agent_id="repo-a")


@pytest.mark.asyncio
async def test_from_cost_anomalies_budget_breach() -> None:
    agent = ImprovementAgent()
    mock_budget = {
        "window": "monthly",
        "cost_hard_limit_usd": 100.0,
        "threshold_alert_pct": 80,
    }
    mock_consumption = {"cost_usd": 90.0}

    with (
        patch(
            "eden.services.budget_service.get_budget",
            AsyncMock(return_value=mock_budget),
        ),
        patch(
            "eden.services.budget_service.get_consumption",
            AsyncMock(return_value=mock_consumption),
        ),
        patch("eden.improvement.agent._pg_fetch", AsyncMock(return_value=[])),
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
    ):
        out = await agent._from_cost_anomalies("org-1", None)

    assert len(out) == 1
    assert out[0].plan_kind == "advisory"
    assert out[0].evidence["metric"] == "budget_breach"


@pytest.mark.asyncio
async def test_from_cost_anomalies_agent_spend_spike() -> None:
    agent = ImprovementAgent()
    spend_24h = [{"agent_id": "agent-x", "spend_24h": 25.0}]
    spend_baseline = [
        {"agent_id": "agent-x", "mean_spend": 5.0, "std_spend": 1.0}
    ]

    with (
        patch(
            "eden.services.budget_service.get_budget",
            AsyncMock(return_value={"window": "monthly", "cost_hard_limit_usd": 1000}),
        ),
        patch(
            "eden.services.budget_service.get_consumption",
            AsyncMock(return_value={"cost_usd": 10.0}),
        ),
        patch("eden.improvement.agent._pg_fetch", AsyncMock()) as mock_fetch,
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
    ):
        mock_fetch.side_effect = [spend_24h, spend_baseline]
        out = await agent._from_cost_anomalies("org-1", None)

    assert len(out) == 1
    assert out[0].plan_kind == "advisory"
    assert out[0].agent_id == "agent-x"
    assert out[0].evidence["metric"] == "agent_spend_spike"
