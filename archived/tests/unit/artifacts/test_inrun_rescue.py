"""Tests for in-run rescue budget."""

from types import SimpleNamespace
from uuid import uuid4

import pytest

from eden.nudges.inrun_rescue import _TRACE_RESCUE_COUNT, InRunRescue
from eden.nudges.models import Nudge


class _Engine:
    def evaluate_sync(self, ctx):
        return [
            Nudge(
                id=uuid4(),
                org_id="o",
                agent_id="a",
                name="r",
                trigger={},
                action_type="inrun_rescue",
                content="hint",
                mode="shadow",
            )
        ]

    async def log_shadow(self, *a, **k):
        return None


@pytest.mark.asyncio
async def test_max_one_rescue_per_trace(monkeypatch):
    async def _enabled(_):
        return True

    monkeypatch.setattr("eden.nudges.inrun_rescue.artifacts_inrun_enabled", _enabled)
    rescue = InRunRescue(engine=_Engine())
    req = SimpleNamespace(prompt="p", nudge_audit=[])
    trace = "t-rescue-1"
    _TRACE_RESCUE_COUNT.pop(trace, None)
    await rescue.try_rescue("o", {"trace_id": trace, "org_id": "o", "agent_id": "a"}, req)
    _, findings2 = await rescue.try_rescue(
        "o", {"trace_id": trace, "org_id": "o", "agent_id": "a"}, req
    )
    assert _TRACE_RESCUE_COUNT.get(trace) == 1
    assert findings2 == []
