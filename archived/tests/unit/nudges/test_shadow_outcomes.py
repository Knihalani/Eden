"""OPT-53 — shadow outcome join ordering."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.nudges.shadow_outcomes import ShadowOutcomeJoiner


@pytest.mark.asyncio
async def test_shadow_outcome_join_orders_by_recorded_at_before_limit() -> None:
    captured: list[str] = []

    class _Pg:
        async def fetch(self, sql: str, limit: int) -> list[dict]:
            captured.append(sql)
            return []

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_Pg()),
    ):
        await ShadowOutcomeJoiner().run_once(limit=5)

    assert captured
    sql = captured[0]
    assert "ORDER BY no.recorded_at ASC" in sql
    order_idx = sql.index("ORDER BY no.recorded_at ASC")
    limit_idx = sql.index("LIMIT $1")
    assert order_idx < limit_idx
