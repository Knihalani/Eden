"""Tests for UnifiedJudge (single multi-axis LLM judge)."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from eden.llmops.judges.base import JudgeContext
from eden.llmops.judges.unified import UnifiedJudge, _parse_multi_axis


def _fake_event(**kwargs):
    defaults = {
        "event_id": "evt_1",
        "trace_id": "tr_1",
        "span_id": "sp_1",
        "event_type": "openai.chat",
        "payload": {"openai": {"first_message_content": "Hello world."}},
        "tenant_id": "t1",
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def _fake_response(content: str):
    return SimpleNamespace(content=content, model="test-model", usage=SimpleNamespace(cost=0.0))


@pytest.mark.asyncio
async def test_unified_judge_one_call_many_axes():
    axes = {
        axis: {"score": 0.8, "rationale": f"ok {axis}"}
        for axis in UnifiedJudge.AXES
    }
    client = MagicMock()
    with patch(
        "eden.llmops.judges._router.route_judge_call",
        return_value=_fake_response(json.dumps(axes)),
    ):
        j = UnifiedJudge()
        ev = _fake_event()
        with patch(
            "eden.llmops.judges.unified.production_sample_matches",
            return_value=True,
        ):
            assert j.matches(ev)
        scores = await j.score(ev, JudgeContext(event=ev, llm_client=client))
    assert isinstance(scores, list)
    assert len(scores) == len(UnifiedJudge.AXES)
    names = {s.judge_name for s in scores}
    assert names == set(UnifiedJudge.AXES)
    assert all(s.score == 0.8 for s in scores)


@pytest.mark.asyncio
async def test_unified_judge_no_client():
    j = UnifiedJudge()
    ev = _fake_event()
    scores = await j.score(ev, JudgeContext(event=ev, llm_client=None))
    assert all(s.score == 0.5 for s in scores)
    assert "no llm_client" in (scores[0].rationale or "")


def test_parse_multi_axis_from_prose():
    raw = 'Here you go:\n{"hallucination": {"score": 0.9, "rationale": "fine"}}\n'
    parsed = _parse_multi_axis(raw)
    assert parsed["hallucination"]["score"] == 0.9
