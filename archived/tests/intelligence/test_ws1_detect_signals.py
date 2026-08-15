"""WS1 — detect & signals workstream tests."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.issues.auto_scanner import AutoIssueScanner
from eden.learning.tool_call_labels import ToolCallLabelCreate, ToolCallLabelService
from eden.search.deep_to_signal import save_search_as_signal
from eden.signals.classifier_pipeline import ClassifierTrainingPipeline, TrainResult
from eden.signals.investigator import _heuristic_match, compress_trace, investigate_trace


class _CapturingWriter:
    def __init__(self) -> None:
        self.created: list[Any] = []

    async def create(self, sc: Any) -> dict[str, Any]:
        self.created.append(sc)
        return {"stumble_id": "sid", "fingerprint": "fp", "inserted": True, "issue": None}


@pytest.mark.asyncio
async def test_detects_hallucination_from_judge_score() -> None:
    writer = _CapturingWriter()
    scanner = AutoIssueScanner(writer=writer)  # type: ignore[arg-type]
    with patch(
        "eden.insights.rca._common._fetch_judge_scores",
        new=AsyncMock(
            return_value=[{"judge_name": "hallucination", "score": 0.1}]
        ),
    ):
        await scanner.scan(
            "org",
            "trace-h",
            events=[{"event_type": "llm.completion", "duration_ms": 10, "attributes": {}}],
        )
    assert any(sc.kind == "hallucination" for sc in writer.created)


@pytest.mark.asyncio
async def test_detects_user_frustration_keywords() -> None:
    writer = _CapturingWriter()
    scanner = AutoIssueScanner(writer=writer)  # type: ignore[arg-type]
    events = [
        {
            "event_type": "message",
            "attributes": {"role": "user", "text": "This is wrong, try again"},
            "duration_ms": 5,
        }
    ]
    await scanner.scan("org", "trace-f", events=events)
    assert any(sc.kind == "user_frustration" for sc in writer.created)


@pytest.mark.asyncio
async def test_detects_confusion_loop() -> None:
    writer = _CapturingWriter()
    scanner = AutoIssueScanner(writer=writer)  # type: ignore[arg-type]
    q = "Could you clarify which table you mean?"
    events = [
        {
            "event_type": "message",
            "attributes": {"role": "assistant", "text": q},
            "duration_ms": 5,
        },
        {
            "event_type": "message",
            "attributes": {"role": "assistant", "text": q},
            "duration_ms": 5,
        },
    ]
    await scanner.scan("org", "trace-c", events=events)
    assert any(
        sc.kind == "loop" and sc.detail.get("detector") == "confusion_loop"
        for sc in writer.created
    )


@pytest.mark.asyncio
async def test_detects_high_cost() -> None:
    writer = _CapturingWriter()
    scanner = AutoIssueScanner(writer=writer)  # type: ignore[arg-type]
    events = [
        {"event_type": "llm.completion", "cost_usd": 0.8, "duration_ms": 5, "attributes": {}},
        {"event_type": "llm.completion", "cost_usd": 0.5, "duration_ms": 5, "attributes": {}},
    ]
    await scanner.scan("org", "trace-cost", events=events)
    assert any(
        sc.kind == "custom" and sc.detail.get("detector") == "high_cost"
        for sc in writer.created
    )


def test_compress_trace_truncates() -> None:
    events = [
        {"event_type": "tool.call", "name": "search", "output_text": "x" * 500}
        for _ in range(20)
    ]
    text = compress_trace(events, max_chars=400)
    assert len(text) <= 400


def test_heuristic_match_frustration() -> None:
    events = [
        {"event_type": "message", "attributes": {"text": "user is frustrated try again"}}
    ]
    summary = compress_trace(events).lower()
    matched, payload, conf = _heuristic_match(
        "user frustration signal", events, summary=summary
    )
    assert matched is True
    assert payload.get("frustrated") is True
    assert conf >= 0.5


def test_heuristic_match_uses_precomputed_summary() -> None:
    """OPT-33: matcher must honor caller-supplied compressed summary."""
    events = [{"event_type": "message", "output_text": "ignored"}]
    matched, payload, _ = _heuristic_match(
        "user frustration signal",
        events,
        summary="user is frustrated try again",
    )
    assert matched is True
    assert payload.get("frustrated") is True


@pytest.mark.asyncio
async def test_investigate_trace_skips_short_traces() -> None:
    out = await investigate_trace("org", "t1", events=[{"event_type": "x"}])
    assert out == []


@pytest.mark.asyncio
async def test_classifier_pipeline_fit_fallback() -> None:
    pipe = ClassifierTrainingPipeline()
    with patch.dict("sys.modules", {"sklearn": None, "sklearn.linear_model": None}):
        model, metrics = pipe._fit_logistic(
            [[0.1] * 16, [-0.1] * 16, [0.2] * 16],
            [0, 1, 1],
        )
    preds = model.predict([[0.1] * 16])
    assert len(preds) == 1
    assert "f1" in metrics


@pytest.mark.asyncio
async def test_tool_call_label_service_create() -> None:
    svc = ToolCallLabelService()
    mock_pg = MagicMock()
    mock_pg.execute = AsyncMock()
    mock_pg.fetchrow = AsyncMock(return_value=None)
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=mock_pg),
    ):
        result = await svc.create_label(
            ToolCallLabelCreate(
                org_id="org1",
                span_id="span1",
                trace_id="trace1",
                tool_name="search_kb",
                label="bad",
                reason="wrong table",
            )
        )
    assert result["label"] == "bad"
    mock_pg.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_save_search_as_signal_requires_traces() -> None:
    with pytest.raises(ValueError, match="trace_ids"):
        await save_search_as_signal("org", search_query="loops", trace_ids=[])


@pytest.mark.asyncio
async def test_trace_finalized_runs_investigator() -> None:
    import eden.workers.trace_finalized_consumer as mod

    with patch(
        "eden.signals.investigator.investigate_trace",
        new=AsyncMock(return_value=[]),
    ) as inv:
        with patch(
            "eden.config.get_settings",
            return_value=MagicMock(per_trace_signals_v1=True),
        ):
            await mod._run_signal_investigator("org_x", "trace_y")
    # Investigator call carries the keyword-only events param (default None).
    inv.assert_awaited_once_with("org_x", "trace_y", events=None)


@pytest.mark.asyncio
async def test_classifier_retrain_due_orgs_no_db() -> None:
    pipe = ClassifierTrainingPipeline()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        out = await pipe.retrain_due_orgs()
    assert out["retrained"] == 0


class _FakeRetrainPg:
    """Stands in for asyncpg, implementing the real
    ``fetch_stale_candidates``/``advance_watermark`` composite-key
    left-join / ORDER BY ... NULLS FIRST / LIMIT semantics for
    ``(org_id, signal_id)`` pairs, the same way
    ``tests/unit/storage/test_watermark.py``'s ``_FakePg`` does for the
    single-key case. ``.fetch``/``.execute`` ignore the query text on
    purpose — this proves the *selection algorithm* the real SQL
    encodes, not that some string got sent to asyncpg.
    """

    def __init__(self, pairs: list[tuple[str, str]]) -> None:
        self.pairs = pairs
        self.watermark: dict[tuple[str, str], float] = {}
        self._clock = 0.0

    async def fetch(self, _query: str, limit: int):
        def sort_key(pair: tuple[str, str]) -> tuple[int, float]:
            ts = self.watermark.get(pair)
            return (0, 0.0) if ts is None else (1, ts)

        ordered = sorted(self.pairs, key=sort_key)
        return [
            {"org_id": org_id, "signal_id": signal_id} for org_id, signal_id in ordered[:limit]
        ]

    async def execute(self, _query: str, *entity_ids: str):
        self._clock += 1.0
        self.watermark[tuple(entity_ids)] = self._clock
        return "INSERT 0 1"


@pytest.mark.asyncio
async def test_classifier_retrain_cycles_through_all_pairs_via_watermark() -> None:
    """The bug OPT-7 fixes: the old ``SELECT DISTINCT ... LIMIT 50`` with no
    ``ORDER BY`` could return the *same* 50 (org, signal) pairs on every
    15-minute tick forever. With the watermark wired in, each processed
    batch sorts to the back so a later tick surfaces pairs a naive
    ``LIMIT 50`` would have starved permanently.
    """
    pairs = [(f"org-{i}", f"sig-{i}") for i in range(120)]
    pg = _FakeRetrainPg(pairs)
    pipe = ClassifierTrainingPipeline()

    processed: list[tuple[str, str]] = []

    async def _fake_train(org_id: str, signal_id: str) -> TrainResult:
        processed.append((org_id, signal_id))
        return TrainResult(
            classifier_id="c1",
            signal_id=signal_id,
            sample_count=1,
            metrics={},
            trained=True,
        )

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=pg),
    ):
        with patch.object(
            ClassifierTrainingPipeline, "train", new=AsyncMock(side_effect=_fake_train)
        ):
            batches: list[list[tuple[str, str]]] = []
            for _ in range(3):  # 120 pairs / batch of 50 -> 3 ticks
                before = len(processed)
                out = await pipe.retrain_due_orgs()
                assert out["candidates"] == 50
                batches.append(processed[before:])

    # First two ticks are disjoint: all 100 pairs from the first two
    # batches get covered before any repeat. A bare `LIMIT 50` would
    # instead return batch[0] unchanged on every single tick.
    first_two = batches[0] + batches[1]
    assert len(set(first_two)) == 100
    assert sorted(first_two) == sorted(pairs[:100])

    # Pairs a naive `LIMIT 50` would have excluded forever (everything
    # past org-49) do show up in the second tick.
    naive_limit_50 = set(batches[0])
    assert set(batches[1]) - naive_limit_50, (
        "pairs excluded by a plain LIMIT 50 never surfaced in a later tick"
    )

    # The third tick is due to wrap: the never-yet-processed pairs
    # (org-100..org-119) lead it — NULLS FIRST beats every
    # already-processed pair regardless of how long ago it ran.
    still_unprocessed = set(pairs[100:120])
    assert set(batches[2][:20]) == still_unprocessed
