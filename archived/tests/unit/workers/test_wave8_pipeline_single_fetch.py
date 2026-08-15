"""Wave 8 — trace.finalized pipeline single-fetch + F34 event threading.

Three behaviors pinned:

1. **Single-fetch pipeline** — ``_process_trace`` fetches the trace's
   events exactly once and threads the same list through Layer A, the
   scanner, the F34 classifiers and the F06 investigator (pre-fix each
   stage issued its own full-window ``_fetch_trace_events``).
2. **F34 sees real events** — ``run_classifiers_before_investigator``
   receives the pipeline events so feature vectors reflect the trace,
   not a hash of an empty list.
3. **Batched persistence** — the per-trace prediction set is written with
   one ``executemany``, not one INSERT per classifier.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _fields(**kwargs: str) -> dict[bytes, bytes]:
    base = {
        b"org_id": b"org_test",
        b"trace_id": b"trace-1",
        b"agent_id": b"agent-a",
        b"session_id": b"",
        b"user_id": b"",
    }
    for k, v in kwargs.items():
        base[k.encode()] = v.encode()
    return base


def _events(n: int = 10) -> list[dict[str, Any]]:
    return [
        {
            "event_id": f"e{i}",
            "trace_id": "trace-1",
            "event_type": "tool.call" if i % 2 else "llm.completion",
            "name": f"tool_{i % 3}",
            "outcome": "failure" if i == 3 else "success",
            "timestamp": f"2026-08-10T00:00:0{i}Z",
            "attributes": {"tool_name": f"tool_{i % 3}", "role": "assistant"},
            "payload": {},
            "metrics": {},
            "tags": [],
        }
        for i in range(n)
    ]


@pytest.fixture(autouse=True)
def _reset_stats() -> None:
    import eden.workers.trace_finalized_consumer as mod

    mod.reset_consumer_stats()
    yield
    mod.reset_consumer_stats()


@pytest.mark.asyncio
async def test_process_trace_fetches_events_exactly_once() -> None:
    """The pipeline fetches the trace once and shares it across stages."""
    import eden.workers.trace_finalized_consumer as mod

    fetch_calls: list[tuple[str, str]] = []
    scanned_events: list[list[dict[str, Any]]] = []
    classifier_events: list[list[dict[str, Any]]] = []
    investigator_events: list[list[dict[str, Any]]] = []
    annotator_events: list[list[dict[str, Any]]] = []
    prod_eval_events: list[list[dict[str, Any]]] = []

    events = _events()

    async def _counting_fetch(org_id: str, trace_id: str, **kw: Any) -> Any:
        fetch_calls.append((org_id, trace_id))
        return events

    async def _fake_scan(
        org_id: str, trace_id: str, *, events: list[dict[str, Any]] | None = None, **kw: Any
    ) -> list[Any]:
        scanned_events.append(events or [])
        return []

    async def _fake_annotator(
        org_id: str,
        trace_id: str,
        layer_a_report: Any | None,
        *,
        events: list[dict[str, Any]] | None = None,
        attempt: int = 1,
    ) -> None:
        annotator_events.append(events or [])

    async def _fake_prod_eval(
        org_id: str,
        trace_id: str,
        *,
        events: list[dict[str, Any]] | None = None,
        agent_id: str | None = None,
    ) -> None:
        prod_eval_events.append(events or [])

    consumer = mod.TraceFinalizedConsumer()
    consumer._scanner = MagicMock()
    consumer._scanner.scan = AsyncMock(side_effect=_fake_scan)

    async def _fake_classifiers(
        org_id: str, trace_id: str, *, events: list[dict[str, Any]] | None = None
    ) -> bool:
        classifier_events.append(events or [])
        return False

    async def _fake_investigator(
        org_id: str, trace_id: str, *, events: list[dict[str, Any]] | None = None
    ) -> list[Any]:
        investigator_events.append(events or [])
        return []

    with patch.object(
        consumer, "_run_annotator", new=_fake_annotator
    ), patch.object(
        consumer, "_maybe_prod_eval", new=_fake_prod_eval
    ), patch.object(
        consumer, "_run_session_rollup", AsyncMock()
    ), patch.object(
        consumer, "_run_trace_summary", AsyncMock()
    ), patch(
        "eden.insights.rca._common._fetch_trace_events", new=_counting_fetch
    ), patch(
        "eden.workers.trace_finalized_consumer._run_signal_classifiers",
        new=_fake_classifiers,
    ), patch(
        "eden.workers.trace_finalized_consumer._run_signal_investigator",
        new=_fake_investigator,
    ), patch(
        "eden.issues.detection_settings.resolve_profile",
        AsyncMock(return_value="standard"),
    ), patch(
        "eden.workers.trace_finalized_consumer._layer_a_primary_hit",
        return_value=False,
    ):
        await consumer._process_trace("1-0", {}, "org_test", "trace-1")

    assert len(fetch_calls) == 1, f"expected 1 fetch, got {len(fetch_calls)}"
    assert fetch_calls[0] == ("org_test", "trace-1")
    # Scanner received the SAME list (not None → no internal re-fetch).
    assert scanned_events and scanned_events[0] == events
    assert classifier_events and classifier_events[0] == events
    assert investigator_events and investigator_events[0] == events
    # Wave 8.1 — annotator + prod-eval sampler also reuse the same list,
    # even though they run after Layer A (which may return None).
    assert annotator_events and annotator_events[0] == events
    assert prod_eval_events and prod_eval_events[0] == events


@pytest.mark.asyncio
async def test_f34_classifier_receives_real_events() -> None:
    """F34 features must reflect the trace, not a hash of an empty list."""
    from eden.signals.classifier_worker import (
        _extract_features,
        run_classifiers_before_investigator,
    )

    events = _events(40)
    empty_feats = _extract_features([], "trace-1")
    real_feats = _extract_features(events, "trace-1")
    assert empty_feats != real_feats, "feature vector must change with real events"

    # The gate actually feeds the events into feature extraction.
    captured: dict[str, Any] = {}

    async def _fake_infer(
        self: Any, model_blob: Any, features: list[float]
    ) -> tuple[bool, float]:
        captured["features"] = features
        captured["n_dims"] = len(features)
        return False, 0.0

    async def _fake_load(org_id: str) -> list[dict[str, Any]]:
        return [
            {
                "id": "clf-1",
                "signal_id": "sig-1",
                "model_blob": b"blob",
                "shadow_mode": True,
                "investigator_disabled": True,
            }
        ]

    async def _fake_persist(org_id: str, trace_id: str, recs: list[dict[str, Any]]) -> None:
        captured["persisted"] = len(recs)

    with patch(
        "eden.signals.classifier_worker._load_active_classifiers", new=_fake_load
    ), patch(
        "eden.signals.classifier_pipeline.ClassifierTrainingPipeline.infer_with_blob",
        new=_fake_infer,
    ), patch(
        "eden.signals.classifier_worker._persist_predictions", new=_fake_persist
    ), patch(
        "eden.config.get_settings",
        return_value=MagicMock(signal_classifiers_v1=True),
    ):
        out = await run_classifiers_before_investigator(
            "org", "trace-1", events=events
        )

    assert out["status"] == "ok"
    assert captured["n_dims"] == 16
    # Feature vector derived from the REAL trace events.
    assert captured["features"] == real_feats
    assert captured["persisted"] == 1


@pytest.mark.asyncio
async def test_persist_predictions_uses_one_executemany() -> None:
    """Per-trace predictions are written in one executemany, not N INSERTs."""
    from eden.signals.classifier_worker import _persist_predictions

    executed: list[bool] = []
    many_rows: list[Any] = []

    class _PG:
        async def execute(self, sql: str, *args: Any) -> str:
            executed.append(True)
            return "OK"

        async def executemany(self, sql: str, rows: list[Any]) -> str:
            many_rows.extend(rows)
            return "OK"

    recs = [
        {
            "id": f"r{i}",
            "classifier_id": f"c{i}",
            "signal_id": f"s{i}",
            "score": 0.4 + i / 10,
            "fired": i % 2 == 0,
            "investigator_skipped": i % 3 == 0,
            "estimated_savings_usd": 0.03 if i % 3 == 0 else 0.0,
        }
        for i in range(12)
    ]

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_PG()),
    ):
        await _persist_predictions("org", "trace-1", recs)

    assert executed == [], "must NOT fall back to per-row execute"
    assert len(many_rows) == 12
    # Row layout: (id, org_id, trace_id, classifier_id, signal_id, ...).
    assert many_rows[0][0] == "r0"
    assert many_rows[-1][3] == "c11"
    assert many_rows[-1][4] == "s11"


@pytest.mark.asyncio
async def test_persist_predictions_empty_is_noop() -> None:
    from eden.signals.classifier_worker import _persist_predictions

    class _PG:
        async def executemany(self, sql: str, rows: list[Any]) -> str:
            raise AssertionError("should not run executemany for an empty set")

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_PG()),
    ):
        await _persist_predictions("org", "trace-1", [])


@pytest.mark.asyncio
async def test_annotator_does_not_refetch_when_events_are_empty() -> None:
    """A threaded-but-empty list is authoritative — no second DB scan."""
    from eden.workers.trace_finalized_consumer import TraceFinalizedConsumer

    with patch("eden.issues.auto_scanner.AutoIssueScanner"):
        consumer = TraceFinalizedConsumer()

    fetched = False

    async def _boom(org_id: str, trace_id: str, **kw: Any) -> list[dict[str, Any]]:
        nonlocal fetched
        fetched = True
        raise AssertionError("annotator must not re-fetch when events were threaded")

    persist = AsyncMock()
    with (
        patch("eden.evaluation.annotator.annotate_and_persist", new=persist),
        patch("eden.insights.rca._common._fetch_trace_events", new=_boom),
    ):
        await consumer._run_annotator(
            "org", "trace-1", None, events=[], attempt=1
        )

    assert not fetched
    persist.assert_awaited_once_with("org", "trace-1", [], layer_a_ids=set())


@pytest.mark.asyncio
async def test_annotator_uses_threaded_events_when_layer_a_returns_none() -> None:
    """Layer A None (exception path) no longer triggers a re-fetch."""
    from eden.workers.trace_finalized_consumer import TraceFinalizedConsumer

    with patch("eden.issues.auto_scanner.AutoIssueScanner"):
        consumer = TraceFinalizedConsumer()

    events = _events(5)
    captured: dict[str, Any] = {}
    fetched = False

    async def _boom(org_id: str, trace_id: str, **kw: Any) -> list[dict[str, Any]]:
        nonlocal fetched
        fetched = True
        raise AssertionError("annotator must reuse the threaded events")

    async def _persist(
        org_id: str, trace_id: str, evs: list[dict[str, Any]], **kw: Any
    ) -> Any:
        captured["events"] = evs
        return type("R", (), {"tags": [], "model": "", "cost_usd": 0.0})()

    with (
        patch("eden.evaluation.annotator.annotate_and_persist", new=_persist),
        patch("eden.insights.rca._common._fetch_trace_events", new=_boom),
    ):
        await consumer._run_annotator(
            "org", "trace-1", None, events=events, attempt=1
        )

    assert not fetched
    assert captured["events"] == events


@pytest.mark.asyncio
async def test_rules_engine_derives_content_from_events_not_db() -> None:
    """apply_rules_for_trace skips the span-content DB read when events
    are threaded with plaintext blobs."""
    from eden.evaluation.online.rules_engine import OnlineScoringRulesEngine
    from eden.evaluation.online.span_scores import SpanScoreStore

    span_fetches: list[str] = []

    class _PG:
        async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
            # list_rules only.
            return [
                {
                    "id": "r1", "org_id": "org", "name": "n",
                    "description": "", "scope": "trace",
                    "filter_query": "*", "scorer_type": "slm",
                    "scorer_ref": None, "sample_rate": 1.0,
                    "enabled": True, "version": 1, "config": {},
                }
            ]

        async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
            span_fetches.append(sql)
            return None

    events = [
        {
            "event_type": "llm.call", "name": "run", "agent_id": "a1",
            "outcome": "success",
            "request_body": {"prompt": "hi"},
            "response_body": {"text": "hello"},
        }
    ]
    engine = OnlineScoringRulesEngine(pg=_PG())
    engine._cascade.score = AsyncMock(  # type: ignore[attr-defined]
        return_value={
            "score": 0.9, "passed": True, "cost_usd": 0.0, "confidence": 1.0
        }
    )
    with patch.object(
        SpanScoreStore, "persist", new=AsyncMock(return_value="sid")
    ), patch.object(
        engine, "_maybe_fire_automations", new=AsyncMock()
    ):
        results = await engine.apply_rules_for_trace(
            "org", "t1", agent_id="a1", events=events
        )

    assert len(results) == 1
    assert results[0]["score"] == 0.9
    assert span_fetches == [], "judge content must come from the threaded events"


@pytest.mark.asyncio
async def test_rules_engine_falls_back_to_db_when_events_have_no_blobs() -> None:
    """zstd-only storage: NULL plaintext blobs → the DB read still runs.

    Judge payloads must not silently lose input/output content just
    because events were threaded — only the DB read can decode the
    compressed blobs.
    """
    from eden.evaluation.online.rules_engine import OnlineScoringRulesEngine
    from eden.evaluation.online.span_scores import SpanScoreStore

    span_fetches: list[str] = []

    class _PG:
        async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
            return [
                {
                    "id": "r1", "org_id": "org", "name": "n",
                    "description": "", "scope": "trace",
                    "filter_query": "*", "scorer_type": "slm",
                    "scorer_ref": None, "sample_rate": 1.0,
                    "enabled": True, "version": 1, "config": {},
                }
            ]

        async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
            span_fetches.append(sql)
            return {
                "agent_id": "a1", "outcome": "success", "name": "run",
                "request_body": {"prompt": "hi"},
                "response_body": {"text": "hello"},
            }

    # Events carry no request/response blobs (zstd-only storage keeps the
    # plaintext columns NULL) — the engine must read them from the DB.
    events = [{"event_type": "llm.call", "agent_id": "a1"}]
    engine = OnlineScoringRulesEngine(pg=_PG())
    engine._cascade.score = AsyncMock(  # type: ignore[attr-defined]
        return_value={
            "score": 0.9, "passed": True, "cost_usd": 0.0, "confidence": 1.0
        }
    )
    with patch.object(
        SpanScoreStore, "persist", new=AsyncMock(return_value="sid")
    ), patch.object(
        engine, "_maybe_fire_automations", new=AsyncMock()
    ):
        results = await engine.apply_rules_for_trace(
            "org", "t1", agent_id="a1", events=events
        )

    assert len(results) == 1
    assert len(span_fetches) == 1, "zstd fallback must read the compressed blobs"


@pytest.mark.asyncio
async def test_rules_engine_truncation_guard_uses_db_for_capped_events() -> None:
    """A list at the 2000-row fetch cap may be truncated — the DB read
    (true newest event) must win over ``events[-1]``."""
    from eden.evaluation.online.rules_engine import OnlineScoringRulesEngine
    from eden.evaluation.online.span_scores import SpanScoreStore

    span_fetches: list[str] = []

    class _PG:
        async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
            return [
                {
                    "id": "r1", "org_id": "org", "name": "n",
                    "description": "", "scope": "trace",
                    "filter_query": "*", "scorer_type": "slm",
                    "scorer_ref": None, "sample_rate": 1.0,
                    "enabled": True, "version": 1, "config": {},
                }
            ]

        async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
            span_fetches.append(sql)
            return {
                "agent_id": "a1", "outcome": "success", "name": "run",
                "request_body": {"prompt": "newest"},
                "response_body": {"text": "newest response"},
            }

    # 2000 events = the fetch cap. The last one HAS blobs, so the zstd
    # fallback alone would not fire — only the truncation guard must.
    events = [
        {
            "event_type": "llm.call", "name": f"e{i}",
            "request_body": {"prompt": str(i)},
            "response_body": {"text": str(i)},
        }
        for i in range(2000)
    ]
    engine = OnlineScoringRulesEngine(pg=_PG())
    engine._cascade.score = AsyncMock(  # type: ignore[attr-defined]
        return_value={
            "score": 0.9, "passed": True, "cost_usd": 0.0, "confidence": 1.0
        }
    )
    with patch.object(
        SpanScoreStore, "persist", new=AsyncMock(return_value="sid")
    ), patch.object(
        engine, "_maybe_fire_automations", new=AsyncMock()
    ):
        results = await engine.apply_rules_for_trace(
            "org", "t1", agent_id="a1", events=events
        )

    assert len(results) == 1
    assert len(span_fetches) == 1, "capped list must fall back to the DB newest row"


@pytest.mark.asyncio
async def test_maybe_score_trace_threads_events_to_rules_engine() -> None:
    """The sampler forwards the pipeline events instead of re-reading the DB."""
    from eden.evaluation.production.sampler import ProductionEvalSampler

    events = [{"event_type": "llm.call", "request_body": {"prompt": "hi"}}]

    fake_apply = AsyncMock(return_value=[])
    sampler = ProductionEvalSampler()
    sampler._client = AsyncMock(return_value=None)  # type: ignore[method-assign]
    with (
        patch.object(sampler, "_enabled", return_value=True),
        patch.object(
            sampler,
            "_resolve_policy",
            AsyncMock(return_value={"enabled": True, "sample_rate": 1.0}),
        ),
        patch.object(sampler, "_budget_allows", AsyncMock(return_value=True)),
        patch(
            "eden.evaluation.online.rules_engine.OnlineScoringRulesEngine.apply_rules_for_trace",
            new=fake_apply,
        ),
    ):
        await sampler.maybe_score_trace(
            "org", "trace-1", agent_id="a1", is_stumble=True, events=events
        )

    fake_apply.assert_awaited_once()
    _args, kwargs = fake_apply.await_args
    assert kwargs.get("events") == events
