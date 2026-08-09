"""FEAT-149 — labeling lease Redis fallback visibility."""

from __future__ import annotations

import logging
from unittest.mock import AsyncMock, patch

import pytest

from eden.evaluation.labeling_leases import claim_lease


@pytest.mark.asyncio
async def test_claim_lease_logs_warning_when_redis_unconfigured(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING)
    with patch(
        "eden.storage.redis.get_redis_client",
        new_callable=AsyncMock,
        return_value=None,
    ):
        ok = await claim_lease("org-2", "item-2", "ann-2")
    assert ok is True
    assert any(
        "labeling lease exclusivity degraded" in rec.message
        for rec in caplog.records
    )


@pytest.mark.asyncio
async def test_claim_lease_logs_warning_on_redis_exception(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING)
    with patch(
        "eden.storage.redis.get_redis_client",
        new_callable=AsyncMock,
        side_effect=RuntimeError("redis down"),
    ):
        ok = await claim_lease("org-1", "item-1", "ann-1")
    assert ok is True
    assert any(
        "labeling lease exclusivity degraded" in rec.message
        for rec in caplog.records
    )
