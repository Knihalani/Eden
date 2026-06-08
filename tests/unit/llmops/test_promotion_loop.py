"""Tests for the PromotionLoop decision math (Phase 7.2d).

The PromotionLoop reads per-version call stats from telemetry_events
and decides whether to promote the candidate (winner) or roll it
back (loser). The math is conservative: 30+ calls minimum, ≥5%
absolute success-rate lift, ≤10% latency regression.

These tests verify the threshold logic by simulating candidate vs
control stats and asserting the right decision.
"""

import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, "src")

from eden.llmops.promotion import PromotionLoop


class _FakeRow(dict):
    """A dict that also supports attribute access, mimicking a
    ``asyncpg.Record``. The PromotionLoop reads via ``row.get(...)``,
    so a plain dict works perfectly.
    """


def _stats(calls, successes, p95):
    return _FakeRow(
        calls=calls,
        successes=successes,
        p95_latency_ms=p95,
        avg_latency_ms=p95 * 0.5,
    )


@pytest.fixture
def loop():
    return PromotionLoop()


@pytest.mark.asyncio
async def test_keep_when_candidate_below_min_calls(loop, monkeypatch):
    """Not enough calls yet → keep waiting."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)

    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=10, successes=8, p95=500),  # candidate
        _stats(calls=100, successes=90, p95=500),  # control
    ])

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "keep"


@pytest.mark.asyncio
async def test_promote_when_candidate_wins(loop, monkeypatch):
    """candidate success rate > control by >=5% AND p95 ≤ 110% of
    control → promote."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)
    monkeypatch.setattr(s, "promotion_min_success_rate_lift", 0.05)
    monkeypatch.setattr(s, "promotion_max_latency_ratio", 1.10)

    fake_client = MagicMock()
    # candidate: 50 calls, 45 successes (90%), p95=500ms
    # control: 100 calls, 75 successes (75%), p95=500ms
    # lift = 0.15, latency_ratio = 1.0
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=50, successes=45, p95=500),
        _stats(calls=100, successes=75, p95=500),
    ])
    fake_client.execute = AsyncMock()

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "promote"


@pytest.mark.asyncio
async def test_rollback_when_candidate_loses_on_success(loop, monkeypatch):
    """Candidate success rate < control by ≥5% → rollback."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)

    fake_client = MagicMock()
    # candidate: 50 calls, 30 successes (60%), p95=500
    # control: 100 calls, 80 successes (80%), p95=500
    # lift = -0.20
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=50, successes=30, p95=500),
        _stats(calls=100, successes=80, p95=500),
    ])
    fake_client.execute = AsyncMock()

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "rollback"


@pytest.mark.asyncio
async def test_rollback_when_candidate_slow(loop, monkeypatch):
    """Candidate p95 latency > 132% of control → rollback."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)
    monkeypatch.setattr(s, "promotion_max_latency_ratio", 1.10)

    fake_client = MagicMock()
    # candidate: 50 calls, 40 successes, p95=1000ms
    # control: 100 calls, 80 successes, p95=500ms
    # lift = 0, latency_ratio = 2.0 → rollback
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=50, successes=40, p95=1000),
        _stats(calls=100, successes=80, p95=500),
    ])
    fake_client.execute = AsyncMock()

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "rollback"


@pytest.mark.asyncio
async def test_keep_within_confidence_band(loop, monkeypatch):
    """Difference is small (success lift < 5%) → keep rolling."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)
    monkeypatch.setattr(s, "promotion_min_success_rate_lift", 0.05)

    fake_client = MagicMock()
    # candidate: 50 calls, 40 successes (80%), p95=500
    # control: 100 calls, 78 successes (78%), p95=500
    # lift = 0.02 — within the 5% gate
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=50, successes=40, p95=500),
        _stats(calls=100, successes=78, p95=500),
    ])

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "keep"


@pytest.mark.asyncio
async def test_keep_when_control_also_below_min_calls(loop, monkeypatch):
    """If the control doesn't have enough calls either, keep waiting."""
    from eden.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 30)

    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(side_effect=[
        _stats(calls=50, successes=40, p95=500),  # candidate
        _stats(calls=10, successes=8, p95=500),   # control below min
    ])

    decision = await loop._evaluate_one(
        client=fake_client,
        experiment_id="exp-1",
        tenant_id="t1",
        agent="planner",
        candidate_version=2,
        traffic_pct=10,
        started_at=None,
    )
    assert decision == "keep"
