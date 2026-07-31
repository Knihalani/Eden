"""Budget alerts must re-arm each billing window.

``evaluate_budget_alerts`` deduplicated fired thresholds against the audit log,
and two independent defects made that dedup permanent rather than per-window —
so every budget alert, **including the 100% hard-breach critical alert**, fired
at most once per org and then never again:

1. The window check read ``action["window_start"]``, but ``record_action``
   never writes that column — it is not in the INSERT. The value was always
   absent, and the ``in ("", ...)`` comparison therefore matched every past
   action regardless of which window it belonged to. A second, entirely
   unscoped ``already |= {...}`` union made the same mistake explicitly.

2. ``if t in already and t != 100: continue`` reads like an exemption that lets
   the critical 100% alert re-fire. The next statement was
   ``if t in already: continue``, which caught the 100 case immediately. The
   exemption never had any effect.

The fix scopes the dedup by ``created_at`` against the window's start, which
``budget_actions`` already records. These tests pin the behaviour that matters:
one alert per threshold per window, and a genuine re-arm when the window rolls.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.services import budget_service

ORG = "org_budget_rearm"
WINDOW_START = datetime(2026, 7, 1, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _clear_debounce():
    """The evaluator debounces per org for ~45s; tests must not inherit it."""
    budget_service._alert_eval_at.pop(ORG, None)
    yield
    budget_service._alert_eval_at.pop(ORG, None)


def _action(threshold: int, created: datetime) -> dict[str, Any]:
    return {
        "action_type": "budget_alert",
        "threshold_pct": threshold,
        "created_at": created.isoformat(),
    }


async def _evaluate(
    *,
    pct_used: float,
    prior_actions: list[dict[str, Any]],
    window_start: datetime = WINDOW_START,
) -> tuple[list[int], list[int]]:
    """Run the evaluator; return (fired, thresholds recorded)."""
    recorded: list[int] = []

    async def _record(_org: str, **kw: Any) -> bool:
        recorded.append(int(kw["threshold_pct"]))
        return True

    with (
        patch.object(
            budget_service,
            "get_budget",
            AsyncMock(
                return_value={
                    "id": "b1",
                    "cost_hard_limit_usd": 100.0,
                    "window": "monthly",
                    "alert_thresholds": [50, 80, 100],
                    "threshold_alert_pct": 80,
                }
            ),
        ),
        patch.object(
            budget_service,
            "get_consumption",
            AsyncMock(
                return_value={
                    "cost_usd": pct_used,
                    "window_start": window_start.isoformat(),
                }
            ),
        ),
        patch.object(
            budget_service, "list_actions", AsyncMock(return_value=prior_actions)
        ),
        patch.object(budget_service, "record_action", AsyncMock(side_effect=_record)),
        patch.object(budget_service, "_notify_budget_alert", AsyncMock()),
    ):
        fired = await budget_service.evaluate_budget_alerts(ORG)
    return fired, recorded


class TestFirstFire:
    @pytest.mark.asyncio
    async def test_all_crossed_thresholds_fire_when_nothing_logged(self) -> None:
        fired, _ = await _evaluate(pct_used=100.0, prior_actions=[])
        assert fired == [50, 80, 100]

    @pytest.mark.asyncio
    async def test_uncrossed_thresholds_do_not_fire(self) -> None:
        fired, _ = await _evaluate(pct_used=60.0, prior_actions=[])
        assert fired == [50]


class TestWithinTheSameWindow:
    @pytest.mark.asyncio
    async def test_threshold_does_not_refire_in_the_same_window(self) -> None:
        prior = [_action(50, WINDOW_START + timedelta(days=1))]
        fired, _ = await _evaluate(pct_used=60.0, prior_actions=prior)
        assert fired == []

    @pytest.mark.asyncio
    async def test_hard_breach_does_not_refire_in_the_same_window(self) -> None:
        """Once per window is the contract — including for 100%."""
        prior = [_action(t, WINDOW_START + timedelta(days=1)) for t in (50, 80, 100)]
        fired, _ = await _evaluate(pct_used=100.0, prior_actions=prior)
        assert fired == []

    @pytest.mark.asyncio
    async def test_unfired_thresholds_still_fire_alongside_fired_ones(self) -> None:
        prior = [_action(50, WINDOW_START + timedelta(days=1))]
        fired, _ = await _evaluate(pct_used=100.0, prior_actions=prior)
        assert fired == [80, 100]


class TestWindowRollover:
    """The regression: a new window must re-arm every threshold."""

    @pytest.mark.asyncio
    async def test_hard_breach_refires_in_a_new_window(self) -> None:
        """The 100% critical alert previously fired once per org, ever."""
        last_month = WINDOW_START - timedelta(days=10)
        prior = [_action(t, last_month) for t in (50, 80, 100)]
        fired, recorded = await _evaluate(pct_used=100.0, prior_actions=prior)
        assert 100 in fired, (
            "the 100% hard-breach alert did not re-arm for the new billing "
            "window — an org that blew its budget in June would never be told "
            "again in July"
        )
        assert fired == [50, 80, 100]
        assert recorded == [50, 80, 100]

    @pytest.mark.asyncio
    async def test_actions_exactly_at_the_window_boundary_count_as_current(
        self,
    ) -> None:
        prior = [_action(50, WINDOW_START)]
        fired, _ = await _evaluate(pct_used=60.0, prior_actions=prior)
        assert fired == []

    @pytest.mark.asyncio
    async def test_unparseable_created_at_is_treated_as_current(self) -> None:
        """Fail safe: an unreadable timestamp must not cause a duplicate alert."""
        prior = [{"action_type": "budget_alert", "threshold_pct": 50,
                  "created_at": "not-a-date"}]
        fired, _ = await _evaluate(pct_used=60.0, prior_actions=prior)
        assert fired == []

    @pytest.mark.asyncio
    async def test_unrelated_action_types_are_ignored(self) -> None:
        prior = [{"action_type": "budget_created", "threshold_pct": 50,
                  "created_at": WINDOW_START.isoformat()}]
        fired, _ = await _evaluate(pct_used=60.0, prior_actions=prior)
        assert fired == [50]


class TestDatetimeCoercion:
    @pytest.mark.parametrize(
        "value",
        [
            "2026-07-01T00:00:00+00:00",
            "2026-07-01T00:00:00Z",
            "2026-07-01T00:00:00",
            datetime(2026, 7, 1),
            datetime(2026, 7, 1, tzinfo=UTC),
        ],
    )
    def test_accepts_every_shape_the_drivers_produce(self, value: Any) -> None:
        got = budget_service._as_datetime(value)
        assert got == WINDOW_START
        assert got.tzinfo is not None

    @pytest.mark.parametrize("value", [None, "", "garbage", 42, object()])
    def test_rejects_unusable_values_without_raising(self, value: Any) -> None:
        assert budget_service._as_datetime(value) is None
