"""Tests for JudgeRunner."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.llmops.judges.base import Judge, JudgeContext, JudgeScore
from eden.llmops.judges.runner import JudgeRunner, run_judges_for_event


class _FakeJudge(Judge):
    def __init__(self, name: str = "fake_judge", score: float = 0.5, raise_exc: bool = False):
        self.name = name
        self.version = "test"
        self._score = score
        self._raise = raise_exc

    async def score(self, event, ctx) -> JudgeScore:
        if self._raise:
            raise RuntimeError("boom")
        return JudgeScore(
            judge_name=self.name,
            judge_version="test",
            trace_id=ctx.trace_id or event.trace_id,
            span_id=event.span_id,
            score=self._score,
            rationale=f"from {self.name}",
            model="test",
        )


class _FakeEvent:
    def __init__(self, trace_id="tr1", span_id="sp1"):
        self.event_id = "e1"
        self.trace_id = trace_id
        self.span_id = span_id
        self.event_type = "otel.chat"
        self.payload = {}
        self.attributes = {}
        self.tags = []


@pytest.mark.asyncio
async def test_runner_runs_all_judges():
    runner = JudgeRunner(llm_client=MagicMock())
    judges = [_FakeJudge("a", 0.5), _FakeJudge("b", 0.8)]
    scores = await runner.run_for_event(_FakeEvent(), judges)
    assert len(scores) == 2
    assert {s.judge_name for s in scores} == {"a", "b"}


@pytest.mark.asyncio
async def test_runner_no_judges_returns_empty():
    runner = JudgeRunner(llm_client=MagicMock())
    assert await runner.run_for_event(_FakeEvent(), []) == []


@pytest.mark.asyncio
async def test_runner_skips_failing_judge_continues_with_others():
    runner = JudgeRunner(llm_client=MagicMock())
    judges = [_FakeJudge("a"), _FakeJudge("b", raise_exc=True), _FakeJudge("c")]
    scores = await runner.run_for_event(_FakeEvent(), judges)
    assert {s.judge_name for s in scores} == {"a", "c"}


@pytest.mark.asyncio
async def test_runner_persists_scores(monkeypatch):
    """When a score is produced, ``_persist`` writes to Postgres."""
    fake_pg = MagicMock()
    fake_pg.execute = AsyncMock(return_value=MagicMock(rowcount=1))

    async def _get_pg():
        return fake_pg

    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client", _get_pg
    )

    runner = JudgeRunner(llm_client=MagicMock())
    judges = [_FakeJudge("a", 0.6)]
    await runner.run_for_event(_FakeEvent(), judges)
    assert fake_pg.execute.await_count >= 1
    insert_calls = [
        call
        for call in fake_pg.execute.await_args_list
        if "INSERT INTO judge_scores" in call.args[0]
    ]
    assert len(insert_calls) == 1


@pytest.mark.asyncio
async def test_runner_persist_swallows_errors(monkeypatch):
    """A failed persist does not break the runner."""
    async def _get_pg_raises():
        raise RuntimeError("DB down")

    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client", _get_pg_raises
    )
    runner = JudgeRunner(llm_client=MagicMock())
    judges = [_FakeJudge("a", 0.6)]
    # Should not raise.
    scores = await runner.run_for_event(_FakeEvent(), judges)
    assert len(scores) == 1


@pytest.mark.asyncio
async def test_runner_passes_trace_id_override():
    runner = JudgeRunner(llm_client=MagicMock())
    judges = [_FakeJudge("a", 0.5)]
    ev = _FakeEvent(trace_id="default-trace")
    scores = await runner.run_for_event(ev, judges, trace_id="overridden")
    assert scores[0].trace_id == "overridden"


@pytest.mark.asyncio
async def test_run_judges_for_event_helper():
    """The module-level convenience wrapper works without instantiating."""
    judges = [_FakeJudge("a", 0.5)]
    scores = await run_judges_for_event(_FakeEvent(), judges, llm_client=MagicMock())
    assert scores[0].judge_name == "a"


@pytest.mark.asyncio
async def test_runner_stamps_step_judges_after_scoring(monkeypatch):
    """FEAT-146: JudgeRunner invokes the automatic step_judges loop."""
    stamp_mock = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "eden.apm_depth.step_judges.stamp_event_judge_scores",
        stamp_mock,
    )

    class _StepEvent(_FakeEvent):
        def __init__(self):
            super().__init__()
            self.tenant_id = "org_t"
            self.attributes = {"apm.step_index": 3}

    runner = JudgeRunner(llm_client=MagicMock())
    judges = [_FakeJudge("hallucination", 0.88)]
    event = _StepEvent()
    scores = await runner.run_for_event(event, judges)

    assert len(scores) == 1
    stamp_mock.assert_awaited_once()
    stamped_event, stamped_scores = stamp_mock.await_args.args
    assert stamped_event is event
    assert stamped_scores[0].judge_name == "hallucination"
    assert stamped_scores[0].score == 0.88


@pytest.mark.asyncio
async def test_runner_skips_step_judge_stamp_when_no_scores(monkeypatch):
    stamp_mock = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "eden.apm_depth.step_judges.stamp_event_judge_scores",
        stamp_mock,
    )
    runner = JudgeRunner(llm_client=MagicMock())
    assert await runner.run_for_event(_FakeEvent(), []) == []
    stamp_mock.assert_not_awaited()
