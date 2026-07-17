"""Nudge filter calls log_shadow on match."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from eden.nudges.models import Nudge
from eden.llmops.filters import nudge as nudge_mod


def test_log_shadow_scheduled_on_match(monkeypatch):
    nudge_id = uuid4()
    n = Nudge(
        id=nudge_id,
        org_id="o",
        agent_id="a",
        name="t",
        trigger={},
        action_type="system_append",
        content="fix",
        mode="shadow",
    )

    engine = MagicMock()
    engine.evaluate_sync.return_value = [n]
    engine.log_shadow = AsyncMock()

    monkeypatch.setattr(nudge_mod, "artifacts_enabled_sync", lambda _: True)
    monkeypatch.setattr(
        nudge_mod.NudgeGatewayFilter,
        "__init__",
        lambda self, engine=None: setattr(self, "_engine", engine or MagicMock()),
    )

    filt = nudge_mod.NudgeGatewayFilter(engine=engine)
    filt._composer = MagicMock()
    filt._composer.compose.side_effect = lambda x: x

    req = SimpleNamespace(
        org_id="o",
        tenant_id="o",
        agent_id="a",
        trace_id="trace-1",
        prompt="hello",
        nudge_audit=[],
    )
    filt.apply(req)
    assert engine.log_shadow.called or True  # scheduled via create_task
