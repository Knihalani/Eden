"""Wave 8 BUG-27 — list_datasets / list_offline_experiments honor limit."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG = "00000000-0000-0000-0000-000000000001"
USER = {"user_id": "00000000-0000-0000-0000-000000000002"}


@pytest.mark.asyncio
async def test_list_datasets_passes_limit_to_hub() -> None:
    from eden.api.routes import datasets_hub as mod

    hub = MagicMock()
    hub.list_datasets = AsyncMock(return_value=[])

    with patch.object(mod, "DatasetHub", return_value=hub):
        out = await mod.list_datasets(org_id=ORG, user=USER, limit=25)

    hub.list_datasets.assert_awaited_once_with(ORG, limit=25)
    assert out.datasets == []
    assert out.total == 0


@pytest.mark.asyncio
async def test_list_offline_experiments_passes_limit_to_runner() -> None:
    from eden.api.routes import experiments_offline as mod

    runner = MagicMock()
    runner.list_experiments = AsyncMock(return_value=[{"id": "exp-1"}])

    with patch.object(mod, "OfflineExperimentRunner", return_value=runner):
        out = await mod.list_offline_experiments(org_id=ORG, user=USER, limit=10)

    runner.list_experiments.assert_awaited_once_with(ORG, limit=10)
    assert out["experiments"] == [{"id": "exp-1"}]
    assert out["total"] == 1
