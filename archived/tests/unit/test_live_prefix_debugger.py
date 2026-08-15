"""Unit tests for F01 live prefix debugger."""

from __future__ import annotations

import pytest

from eden.debugger.checkpoints import (
    Checkpoint,
    CheckpointStore,
    LivePrefixEngine,
)
from tests.unit.test_debugger import FakePg, _checkpoint


@pytest.mark.asyncio
async def test_live_prefix_splits_tail() -> None:
    pg = FakePg()
    store = CheckpointStore(pg)
    for i in range(4):
        await store.save(_checkpoint(i))
    engine = LivePrefixEngine(store)
    result = await engine.rerun_live_prefix("trace-1", live_from_step=2)
    assert len(result.prefix_checkpoints) == 2
    assert result.live_tail_steps == 2
    assert result.mode == "cached_prefix"
