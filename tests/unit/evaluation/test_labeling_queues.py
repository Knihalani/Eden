"""Unit tests for F50 labeling queues."""

from __future__ import annotations

import pytest

from eden.evaluation.labeling_queues import LabelingQueueService


@pytest.mark.asyncio
async def test_create_and_list_queue_memory() -> None:
    svc = LabelingQueueService(memory_only=True)
    q = await svc.create_queue("org-1", name="SME review")
    queues = await svc.list_queues("org-1")
    assert any(x.id == q.id for x in queues)
