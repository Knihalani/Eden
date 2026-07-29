"""The finalized-trace retry ladder must not re-bill the annotator.

``_MAX_HANDLE_ATTEMPTS = 3`` re-runs ``_process_trace`` on transient
failures. The annotator is one paid LLM call per trace, so re-running it
tripled annotator spend every time an unrelated step blipped.
"""

from __future__ import annotations

import contextlib
import inspect
from unittest.mock import AsyncMock, patch

from eden.workers.trace_finalized_consumer import TraceFinalizedConsumer


def _consumer() -> TraceFinalizedConsumer:
    with patch("eden.issues.auto_scanner.AutoIssueScanner"):
        return TraceFinalizedConsumer()


async def test_annotator_runs_on_the_first_attempt() -> None:
    persist = AsyncMock(return_value=type("R", (), {"tags": [], "model": "", "cost_usd": 0.0})())
    with (
        patch("eden.evaluation.annotator.annotate_and_persist", new=persist),
        patch("eden.insights.rca._common._fetch_trace_events",
              new=AsyncMock(return_value=[{"event_type": "llm.call"}])),
    ):
        await _consumer()._run_annotator("org", "trace-1", None, attempt=1)
    persist.assert_awaited_once()


async def test_annotator_is_skipped_on_retry_attempts() -> None:
    persist = AsyncMock()
    with (
        patch("eden.evaluation.annotator.annotate_and_persist", new=persist),
        patch("eden.insights.rca._common._fetch_trace_events",
              new=AsyncMock(return_value=[{"event_type": "llm.call"}])),
    ):
        for attempt in (2, 3):
            await _consumer()._run_annotator("org", "trace-1", None, attempt=attempt)
    persist.assert_not_awaited()


async def test_a_full_retry_ladder_bills_the_annotator_once() -> None:
    """Three attempts of the pipeline => exactly one annotator call."""
    consumer = _consumer()
    persist = AsyncMock(return_value=type("R", (), {"tags": [], "model": "", "cost_usd": 0.0})())
    with (
        patch("eden.evaluation.annotator.annotate_and_persist", new=persist),
        patch("eden.insights.rca._common._fetch_trace_events",
              new=AsyncMock(return_value=[{"event_type": "llm.call"}])),
    ):
        for attempt in (1, 2, 3):
            await consumer._run_annotator("org", "trace-1", None, attempt=attempt)
    assert persist.await_count == 1


async def test_transient_annotator_failure_is_not_reraised() -> None:
    """A transient LLM error must not drive a retry of the whole pipeline."""
    boom = AsyncMock(side_effect=TimeoutError("connection timeout"))
    with (
        patch("eden.evaluation.annotator.annotate_and_persist", new=boom),
        patch("eden.insights.rca._common._fetch_trace_events",
              new=AsyncMock(return_value=[{"event_type": "llm.call"}])),
    ):
        # Must not raise.
        await _consumer()._run_annotator("org", "trace-1", None, attempt=1)


def test_attempt_is_threaded_from_process_trace_to_the_annotator() -> None:
    for fn in (TraceFinalizedConsumer._process_trace, TraceFinalizedConsumer._run_annotator):
        params = inspect.signature(fn).parameters
        assert "attempt" in params, f"{fn.__name__} lost its attempt parameter"
        assert params["attempt"].default == 1


async def test_process_trace_passes_its_attempt_number_down() -> None:
    consumer = _consumer()
    seen: list[int] = []

    async def _capture(org_id, trace_id, report, *, attempt=1):
        seen.append(attempt)

    consumer._scanner.scan = AsyncMock(return_value=[])
    with (
        patch.object(consumer, "_run_annotator", new=_capture),
        patch.object(consumer, "_run_layer_a", new=AsyncMock(return_value=None)),
        patch.object(consumer, "_maybe_prod_eval", new=AsyncMock(return_value=None)),
        patch("eden.workers.trace_finalized_consumer._record_queue_lag"),
    ):
        for attempt in (1, 2, 3):
            # Downstream steps beyond the annotator are not the subject of
            # this test; by the time they fail the annotator call happened.
            with contextlib.suppress(Exception):
                await consumer._process_trace("mid", {}, "org", "trace-1", attempt=attempt)
    assert seen == [1, 2, 3]
