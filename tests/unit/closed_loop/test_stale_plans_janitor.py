"""M13 (§6.6) — stale draft plans janitor closes at 30d."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop import verify


ORG = "org-stale"
PLAN = "dddddddd-dddd-dddd-dddd-dddddddddddd"


@pytest.fixture(autouse=True)
def _clean_registry():
    verify._reset_state_for_tests()
    yield
    verify._reset_state_for_tests()


@pytest.mark.asyncio
async def test_stale_plans_janitor_closes_with_closed_reason_stale() -> None:
    client = MagicMock()
    client.fetch = AsyncMock(return_value=[{"id": PLAN, "org_id": ORG}])
    client.execute = AsyncMock()

    closed_plan = {"id": PLAN, "status": "closed", "rejection_reason": "stale"}

    with (
        patch.object(verify, "_pg", AsyncMock(return_value=client)),
        patch.object(verify, "_cfg", lambda name, default: 14 if name == "plan_stale_after_days" else default),
        patch(
            "eden.improvement.plans_repo.mark_closed",
            AsyncMock(return_value=closed_plan),
        ) as mark,
    ):
        n = await verify.stale_plans_janitor()

    assert n == 1
    mark.assert_awaited_once()
    assert mark.await_args.kwargs.get("reason") == "stale"
    assert mark.await_args.kwargs.get("write_rejection") is False
    # evidence stamp
    evid_sql = client.execute.await_args.args[0]
    assert "closed_reason" in evid_sql


@pytest.mark.asyncio
async def test_stale_plans_janitor_uses_2x_window() -> None:
    client = MagicMock()
    client.fetch = AsyncMock(return_value=[])
    client.execute = AsyncMock()

    def _cfg(name: str, default: Any) -> Any:
        return 10 if name == "plan_stale_after_days" else default

    with (
        patch.object(verify, "_pg", AsyncMock(return_value=client)),
        patch.object(verify, "_cfg", _cfg),
    ):
        await verify.stale_plans_janitor()

    # close_after = 2 * 10 = 20 days
    assert client.fetch.await_args.args[1] == "20"


def test_stale_janitor_registered_as_idle_chore() -> None:
    verify._register_default_chores()
    names = {c.name for c in verify._IDLE_CHORES}
    assert "stale_plans_janitor" in names
