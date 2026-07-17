"""Tests for ArtifactComposer."""

from uuid import uuid4

from eden.nudges.composer import ArtifactComposer
from eden.nudges.models import Nudge


def _nudge(mode: str, trigger: dict, content: str = "x", evidence: dict | None = None):
    return Nudge(
        id=uuid4(),
        org_id="org",
        agent_id="agent",
        name="t",
        trigger=trigger,
        action_type="system_append",
        content=content,
        mode=mode,
        evidence=evidence or {},
    )


def test_compose_caps_promoted():
    composer = ArtifactComposer()
    nudges = [
        _nudge("promoted", {"a": i}, evidence={"value_score": float(i)})
        for i in range(12)
    ]
    out = composer.compose(nudges, max_promoted=8)
    promoted = [n for n in out if n.mode == "promoted"]
    assert len(promoted) == 8
