"""M14 (§8.3) — per-org sampling_profile_override opt-in."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from eden.config import get_settings
from eden.observability.sampling.apply import decide_for_event
from eden.observability.sampling.policy import reset_sampling_policy
from eden.preview import gates


@pytest.fixture(autouse=True)
def _reset_sampling() -> None:
    reset_sampling_policy()
    gates._ORG_SAMPLING_CACHE.clear()
    yield
    reset_sampling_policy()
    gates._ORG_SAMPLING_CACHE.clear()


def test_global_sampling_profile_stays_full() -> None:
    """§8.3: do NOT flip global default from full → balanced."""
    assert get_settings().sampling_profile == "full"


@pytest.mark.asyncio
async def test_org_override_balanced_opt_in() -> None:
    with patch.object(
        gates,
        "_load_org_features",
        AsyncMock(return_value={"sampling_profile_override": "balanced"}),
    ):
        profile = await gates.sampling_profile_for_org("org-opt-in")
    assert profile == "balanced"
    assert gates.sampling_profile_override_sync("org-opt-in") == "balanced"


@pytest.mark.asyncio
async def test_org_without_override_keeps_global_full() -> None:
    with patch.object(gates, "_load_org_features", AsyncMock(return_value={})):
        profile = await gates.sampling_profile_for_org("org-default")
    assert profile == "full"
    assert gates.sampling_profile_override_sync("org-default") is None


@pytest.mark.asyncio
async def test_unknown_override_ignored() -> None:
    with patch.object(
        gates,
        "_load_org_features",
        AsyncMock(return_value={"sampling_profile_override": "drop_everything"}),
    ):
        profile = await gates.sampling_profile_for_org("org-bad")
    assert profile == "full"


def test_decide_for_event_uses_org_override_for_non_error() -> None:
    """Opted-in org can sample out non-error traffic under balanced."""
    gates._ORG_SAMPLING_CACHE["org-bal"] = "balanced"
    event = SimpleNamespace(
        tenant_id="org-bal",
        outcome="success",
        attributes={},
        duration_ms=10.0,
        metrics={"cost_usd": 0.01},
        trace_id="t1",
        agent_id=None,
    )
    # Probabilistic — run enough to see at least one drop under balanced 15%.
    drops = 0
    for _ in range(80):
        # Clear process policy so decide rebuilds; override path constructs
        # a one-shot policy each call.
        d = decide_for_event(event)
        if not d.keep:
            drops += 1
            assert d.profile == "balanced"
    assert drops > 0


def test_decide_for_event_keeps_errors_even_with_override() -> None:
    gates._ORG_SAMPLING_CACHE["org-bal"] = "balanced"
    event = SimpleNamespace(
        tenant_id="org-bal",
        outcome="error",
        attributes={},
        duration_ms=10.0,
        metrics={},
        trace_id="t2",
        agent_id=None,
    )
    for _ in range(20):
        assert decide_for_event(event).keep is True
