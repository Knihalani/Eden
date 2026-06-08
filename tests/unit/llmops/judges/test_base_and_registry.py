"""Tests for the Judge abstraction and JudgeRegistry."""

import pytest

from eden.llmops.judges.base import Judge, JudgeContext, JudgeScore
from eden.llmops.judges.registry import (
    JudgeRegistry,
    get_judge_registry,
    reset_judge_registry,
)


class _FakeJudge(Judge):
    """Minimal concrete Judge for tests."""

    def __init__(
        self,
        name: str = "fake_a",
        matches: bool = True,
        score: float = 0.7,
    ) -> None:
        self.name = name
        self.version = "test-1"
        self._matches = matches
        self._score = score

    def matches(self, event) -> bool:
        return self._matches

    async def score(self, event, ctx) -> JudgeScore:
        return JudgeScore(
            judge_name=self.name,
            judge_version=self.version,
            trace_id=event.trace_id,
            span_id=event.span_id,
            score=self._score,
            rationale="test",
            model="test-model",
        )


def test_judge_registry_register_and_get():
    r = JudgeRegistry()
    j = _FakeJudge(name="my_judge")
    r.register(j)
    assert r.get("my_judge") is j
    assert "my_judge" in r.list()


def test_judge_registry_register_requires_name():
    r = JudgeRegistry()

    class _NoName(Judge):
        name = ""
        async def score(self, event, ctx):
            return None  # type: ignore

    with pytest.raises(ValueError, match="name"):
        r.register(_NoName())


def test_judge_registry_register_overwrites():
    r = JudgeRegistry()
    r.register(_FakeJudge(name="dup", score=0.5))
    r.register(_FakeJudge(name="dup", score=0.9))
    assert r.get("dup")._score == 0.9


def test_judge_registry_unregister():
    r = JudgeRegistry()
    r.register(_FakeJudge(name="bye"))
    r.unregister("bye")
    assert r.get("bye") is None
    # Unregistering again is silent.
    r.unregister("bye")


def test_judge_registry_for_event_filters():
    r = JudgeRegistry()
    r.register(_FakeJudge(name="m", matches=True, score=0.5))
    r.register(_FakeJudge(name="nm", matches=False, score=0.9))

    class _Event:
        event_type = "otel.chat"
        trace_id = "tr1"
        span_id = "sp1"
        payload = {}
        attributes = {}
        tags = []

    matches = r.for_event(_Event())
    assert len(matches) == 1
    assert matches[0]._score == 0.5
    assert matches[0].name == "m"


def test_judge_default_matches_llm_events():
    """The base ``matches`` accepts the common LLM event_type prefixes."""
    from eden.llmops.judges.base import Judge

    class _Event:
        def __init__(self, et):
            self.event_type = et

    class _NullJudge(Judge):
        async def score(self, event, ctx):
            return None  # type: ignore

    j = _NullJudge()
    assert j.matches(_Event("otel.chat")) is True
    assert j.matches(_Event("openai.chat_completion")) is True
    assert j.matches(_Event("anthropic.message")) is True
    assert j.matches(_Event("langfuse.generation")) is True
    assert j.matches(_Event("helicone.llm_call")) is True
    assert j.matches(_Event("llm_completion_stream")) is True
    # Non-LLM events
    assert j.matches(_Event("env.step")) is False
    assert j.matches(_Event("tool.call")) is False
    # Empty / None event types
    assert j.matches(_Event("")) is False
    assert j.matches(None) is False


def test_judge_score_to_dict_round_trip():
    from datetime import datetime, timezone

    s = JudgeScore(
        judge_name="hallucination",
        judge_version="2026-06-03",
        trace_id="tr1",
        span_id="sp1",
        score=0.85,
        rationale="looks good",
        model="claude-haiku",
        scored_at=datetime(2026, 6, 3, 12, 0, 0, tzinfo=timezone.utc),
        latency_ms=120.5,
        metadata={"event_id": "e1"},
    )
    d = s.to_dict()
    assert d["judge_name"] == "hallucination"
    assert d["score"] == 0.85
    assert d["metadata"] == {"event_id": "e1"}


def test_singleton_registry_seeded_with_defaults():
    """``get_judge_registry()`` lazily seeds the built-in judge set."""
    reset_judge_registry()
    r = get_judge_registry()
    names = r.list()
    assert "hallucination" in names
    assert "correctness" in names
    assert "tone" in names


def test_reset_judge_registry_clears_state():
    reset_judge_registry()
    r1 = get_judge_registry()
    r1.register(_FakeJudge(name="temp"))
    assert "temp" in r1.list()
    reset_judge_registry()
    r2 = get_judge_registry()
    assert "temp" not in r2.list()
    # And r2 is a fresh instance.
    assert r2 is not r1
