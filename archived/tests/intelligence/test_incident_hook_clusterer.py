"""G4 — clusterer must fire ``IncidentHook.on_clustered`` (awaited).

The old ``_fire_drift_alerts`` called ``PromotionHook.on_drift_alert``
(action_kind ``rollback_canary``) synchronously and never awaited the
coroutine. The fix routes qualifying clusters through
``IncidentHook.on_clustered`` (action_kind ``investigate``) instead,
reserving ``on_drift_alert`` for a stricter critical+large threshold.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_qualifying_cluster_calls_on_clustered() -> None:
    from eden.insights.incidents.clusterer import IncidentClusterer

    clusters = [
        {"id": "clu_1", "severity": "high", "member_count": 12},
        {"id": "clu_low", "severity": "low", "member_count": 50},
        {"id": "clu_small", "severity": "critical", "member_count": 3},
    ]
    members = [
        {"cluster_id": "clu_1", "trace_id": f"t{i}"} for i in range(7)
    ]

    incident_hook = MagicMock()
    incident_hook.on_clustered = AsyncMock(return_value="action-1")

    with patch(
        "eden.llmops.promotion_hooks.get_incident_hook",
        return_value=incident_hook,
    ):
        await IncidentClusterer._fire_incident_hooks(
            "org_test", clusters, members
        )

    incident_hook.on_clustered.assert_awaited_once()
    _args, kwargs = incident_hook.on_clustered.call_args
    assert kwargs["cluster_id"] == "clu_1"
    assert kwargs["trace_count"] == 12
    # Sample trace ids capped at 5.
    assert len(kwargs["sample_trace_ids"]) == 5
    assert set(kwargs["sample_trace_ids"]).issubset({f"t{i}" for i in range(7)})


@pytest.mark.asyncio
async def test_critical_large_cluster_also_fires_drift_alert() -> None:
    from eden.insights.incidents.clusterer import IncidentClusterer

    clusters = [{"id": "clu_c", "severity": "critical", "member_count": 40}]
    members = [
        {"cluster_id": "clu_c", "trace_id": f"t{i}"} for i in range(3)
    ]

    incident_hook = MagicMock()
    incident_hook.on_clustered = AsyncMock(return_value="a")
    promo_hook = MagicMock()
    promo_hook.on_drift_alert = AsyncMock(return_value="b")

    with patch(
        "eden.llmops.promotion_hooks.get_incident_hook",
        return_value=incident_hook,
    ), patch(
        "eden.llmops.promotion_hooks.get_promotion_hook",
        return_value=promo_hook,
    ):
        await IncidentClusterer._fire_incident_hooks(
            "org_test", clusters, members
        )

    incident_hook.on_clustered.assert_awaited_once()
    # critical + 40 members trips the stricter rollback threshold.
    promo_hook.on_drift_alert.assert_awaited_once()
    _a, kwargs = promo_hook.on_drift_alert.call_args
    assert kwargs["severity"] == "critical"


@pytest.mark.asyncio
async def test_high_cluster_does_not_fire_drift_alert() -> None:
    from eden.insights.incidents.clusterer import IncidentClusterer

    clusters = [{"id": "clu_h", "severity": "high", "member_count": 15}]
    members: list[dict[str, Any]] = []

    incident_hook = MagicMock()
    incident_hook.on_clustered = AsyncMock(return_value="a")
    promo_hook = MagicMock()
    promo_hook.on_drift_alert = AsyncMock(return_value="b")

    with patch(
        "eden.llmops.promotion_hooks.get_incident_hook",
        return_value=incident_hook,
    ), patch(
        "eden.llmops.promotion_hooks.get_promotion_hook",
        return_value=promo_hook,
    ):
        await IncidentClusterer._fire_incident_hooks(
            "org_test", clusters, members
        )

    incident_hook.on_clustered.assert_awaited_once()
    promo_hook.on_drift_alert.assert_not_awaited()
