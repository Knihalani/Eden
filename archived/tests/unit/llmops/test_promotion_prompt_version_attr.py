"""Pinning test for Wave 2.2 — canary stats read ``prompt_version``.

The SDK maps span attributes to wire names; ``prompt_version`` must
reach ``telemetry_events.attributes`` under that exact key so
PromotionLoop's per-version stats query can see candidate traffic. The
query must tolerate both the new key and the legacy ``eden.span.``
spelling so already-shipped SDK events still count.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.llmops.promotion import PromotionLoop


class _FakeRow(dict):
    pass


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
async def test_stats_query_tolerates_both_key_spellings(loop, monkeypatch):
    """The stats query must COALESCE prompt_version + eden.span.* keys."""
    from eden.config import get_settings

    s = get_settings()
    monkeypatch.setattr(s, "promotion_min_calls", 1)
    monkeypatch.setattr(s, "promotion_min_success_rate_lift", 0.05)
    monkeypatch.setattr(s, "promotion_max_latency_ratio", 1.10)
    monkeypatch.setattr(
        loop, "_evidence_gate_promote", AsyncMock(return_value=True)
    )

    # Mirror the passing stats from test_promotion_loop.py (candidate
    # 90% vs control 75%, equal latency) — the decision math is already
    # pinned there; this test pins the SQL shape.
    fake_client = MagicMock()
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

    # The SQL sent for the candidate stats query must read the bare
    # attribute key, with the legacy spelling as a COALESCE fallback.
    stats_sql = fake_client.fetchrow.call_args_list[0].args[0]
    assert "attributes->>'prompt_version'" in stats_sql
    assert "eden.span.prompt_version" in stats_sql
    assert "COALESCE" in stats_sql
    # And it must never reference a legacy column.
    assert "agent.run" in stats_sql
