"""Unit tests for F53 dataset hub."""

from __future__ import annotations

import pytest

from eden.datasets.hub import DatasetHub


@pytest.mark.asyncio
async def test_create_and_list_in_memory() -> None:
    hub = DatasetHub(memory_only=True)
    created = await hub.create_dataset("org-1", name="regressions", description="test")
    listed = await hub.list_datasets("org-1")
    assert any(d.id == created.id for d in listed)
    assert created.name == "regressions"


@pytest.mark.asyncio
async def test_promote_trace_memory() -> None:
    hub = DatasetHub(memory_only=True)
    result = await hub.promote_trace("org-1", "trace-abc", dataset_name="from-trace")
    assert result["trace_id"] == "trace-abc"
    assert "dataset_id" in result
