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


@pytest.mark.asyncio
async def test_update_and_delete_in_memory() -> None:
    hub = DatasetHub(memory_only=True)
    created = await hub.create_dataset("org-1", name="draft", description="old")
    updated = await hub.update_dataset(
        "org-1", created.id, name="renamed", description="new"
    )
    assert updated is not None
    assert updated.name == "renamed"
    assert updated.description == "new"
    assert updated.version == 2
    assert await hub.delete_dataset("org-1", created.id) is True
    assert await hub.get_dataset("org-1", created.id) is None
    assert await hub.delete_dataset("org-1", created.id) is False
