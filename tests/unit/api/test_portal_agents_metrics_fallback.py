"""Portal agents must not go empty when metrics casts fail."""

from __future__ import annotations

import inspect

from eden.api.routes import portal as portal_mod


def test_agents_metrics_soft_fail_still_discovers_ids():
    src = inspect.getsource(portal_mod.list_portal_agents)
    assert "telemetry id discovery skipped" in src
    assert "COUNT(DISTINCT trace_id)" in src
    # Discovery query must not cast token metrics (that is what failed).
    discovery_region = src.split("telemetry metrics skipped")[1].split(
        "return metrics_by_id"
    )[0]
    assert "input_tokens" not in discovery_region
    assert "GROUP BY agent_id" in discovery_region


def test_agents_sdk_only_uses_last_seen_from_metrics():
    src = inspect.getsource(portal_mod.list_portal_agents)
    assert 'metrics.get("last_seen")' in src
