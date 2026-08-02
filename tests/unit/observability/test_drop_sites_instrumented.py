"""Every place that discards an event must say so.

A read-only audit of the ingest path found **26** sites that dropped an event or
a whole batch with no counter and nothing above DEBUG. The pattern is always the
same shape: a buffer is detached from its owner, the write fails or is skipped,
and the caller is told nothing — so the loss is indistinguishable from "there was
no traffic".

The worst four, all fixed here:

* ``_insert_ch_batch`` with no ClickHouse sink. ``batch`` was already swapped out
  of ``_ch_telemetry_buffer``, so it existed nowhere else; the only trace was a
  ``logger.debug`` inside a *different* function. A misconfigured ClickHouse
  shredded 100+ rows on every flush, indefinitely.
* ``OTelDualExporter.flush`` — same detached-buffer shape, three exits (no
  endpoint, non-2xx, exception), all ``return 0`` at DEBUG.
* The Typesense circuit breaker: ``if not self._is_reachable(): return 0, None``
  discarded every span doc for the whole backoff window with neither a log nor a
  counter.
* OTel/gRPC: an entire export request swallowed at DEBUG while the handler still
  returned ``ExportTraceServiceResponse()``, i.e. success, so the client never
  retried.

These tests assert the counters fire with the right magnitude — a per-event
counter on a 150-row batch would be as misleading as no counter at all.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest

from eden.observability.drop_metrics import get_drop_metrics, reset_for_tests
from eden.observability.telemetry_collector import TelemetryCollector, TelemetryEvent

_TS = datetime.now(UTC).isoformat()


def _event(idx: int = 0) -> TelemetryEvent:
    return TelemetryEvent(
        event_id=f"evt-{idx}",
        tenant_id="tenant-1",
        project_id="proj-1",
        trace_id=f"trace-{idx}",
        realm="production",
        event_type="llm.completion",
        timestamp=_TS,
    )


@pytest.fixture(autouse=True)
def _clean() -> None:
    reset_for_tests()
    yield
    reset_for_tests()


def _report(*, rows_inserted: int = 0, rows_failed: int = 0, errors=None):
    """A stand-in for IngestionReport with the fields the collector reads."""

    class _R:
        def __init__(self):
            self.rows_inserted = rows_inserted
            self.rows_failed = rows_failed
            self.errors = list(errors or [])

    return _R()


class TestClickHouseBatchLoss:
    @pytest.mark.asyncio
    async def test_absent_sink_counts_every_row_not_one(self) -> None:
        """Magnitude matters: this is the largest silent loss on the path."""
        collector = TelemetryCollector()
        with patch.object(
            collector, "_get_clickhouse", new=AsyncMock(return_value=None)
        ), patch.object(
            collector, "_park_ch_batch_fallback", new=AsyncMock()
        ) as park:
            await collector._insert_ch_batch([{"x": 1}] * 150)

        assert get_drop_metrics().get(("sink_ch", "write_error"), 0.0) == 150.0
        park.assert_awaited_once()
        assert park.await_args.args[0] == [{"x": 1}] * 150

    @pytest.mark.asyncio
    async def test_failed_insert_counts_every_row(self) -> None:
        collector = TelemetryCollector()
        sink = AsyncMock()
        sink.insert = AsyncMock(side_effect=RuntimeError("ch down"))
        sink._fallback_to_postgres = AsyncMock()
        with patch.object(
            collector, "_get_clickhouse", new=AsyncMock(return_value=sink)
        ):
            await collector._insert_ch_batch([{"x": 1}] * 120)

        assert get_drop_metrics().get(("sink_ch", "write_error"), 0.0) == 120.0
        sink._fallback_to_postgres.assert_awaited_once()
        assert sink._fallback_to_postgres.await_args.args[0] == "telemetry_events_ch"
        assert len(sink._fallback_to_postgres.await_args.args[1]) == 120

    @pytest.mark.asyncio
    async def test_a_successful_insert_counts_nothing(self) -> None:
        collector = TelemetryCollector()
        sink = AsyncMock()
        # Must return a REPORT, not a bare AsyncMock. sink.insert does not
        # raise on a failed write — it returns an IngestionReport with
        # rows_failed set — and the collector now reads that field. A bare
        # AsyncMock returns a MagicMock whose __int__ is 1, so this test
        # would report a phantom failure. Modelling the real return type
        # is the whole point.
        sink.insert = AsyncMock(return_value=_report(rows_inserted=10))
        with patch.object(
            collector, "_get_clickhouse", new=AsyncMock(return_value=sink)
        ):
            await collector._insert_ch_batch([{"x": 1}] * 10)

        assert get_drop_metrics().get(("sink_ch", "write_error"), 0.0) == 0.0

    @pytest.mark.asyncio
    async def test_a_silently_failed_insert_is_counted(self) -> None:
        """sink.insert returns rows_failed instead of raising.

        Discarding that return value made a 100%-failing columnar mirror
        indistinguishable from a healthy one — nothing logged, nothing
        counted, the only evidence being rows piling up in
        clickhouse_fallback (82 of them, Jul 6 to Jul 24).
        """
        collector = TelemetryCollector()
        sink = AsyncMock()
        sink.insert = AsyncMock(
            return_value=_report(rows_failed=40, errors=["ch timeout"])
        )
        with patch.object(
            collector, "_get_clickhouse", new=AsyncMock(return_value=sink)
        ):
            await collector._insert_ch_batch([{"x": 1}] * 40)

        assert get_drop_metrics().get(("sink_ch", "write_error"), 0.0) == 40.0


class TestSamplingIsCounted:
    @pytest.mark.asyncio
    async def test_sampled_out_event_is_counted_and_not_reported_accepted(self) -> None:
        """The sinks never see it, so the SDK is not told it was stored."""
        collector = TelemetryCollector()
        with (
            patch(
                "eden.observability.sampling.apply.should_route_event",
                new=AsyncMock(return_value=False),
            ),
            patch.object(collector, "_route", new=AsyncMock()) as route,
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
            patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
        ):
            result = await collector.ingest_one(_event(0))
            route.assert_not_awaited()

        assert result["sampled_out"] == 1
        assert result["accepted"] == 0
        assert get_drop_metrics().get(("sample", "sampled_out"), 0.0) == 1.0

    @pytest.mark.asyncio
    async def test_batch_sampling_is_counted_per_event(self) -> None:
        collector = TelemetryCollector()
        with (
            patch(
                "eden.observability.sampling.apply.should_route_event",
                new=AsyncMock(return_value=False),
            ),
            patch.object(collector, "_route", new=AsyncMock()),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
            patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
        ):
            await collector.ingest_batch([_event(i) for i in range(4)])

        assert get_drop_metrics().get(("sample", "sampled_out"), 0.0) == 4.0


class TestOtelExporter:
    @pytest.mark.asyncio
    async def test_missing_endpoint_counts_the_detached_batch(self) -> None:
        from eden.observability.otel_exporter import OTelDualExporter

        exporter = OTelDualExporter()
        exporter._buffer = [_event(i) for i in range(7)]

        class _Settings:
            otel_exporter_otlp_endpoint = ""

        with patch.object(exporter, "_cached_settings", return_value=_Settings()):
            assert await exporter.flush() == 0

        assert get_drop_metrics().get(("sink_ch", "write_error"), 0.0) == 7.0
        assert exporter._buffer == [], "the buffer was detached, as expected"


class TestTypesenseBreaker:
    """The breaker's early return is asserted at source level.

    A behavioural test here would need a constructed ``TypesenseClient`` with a
    tripped breaker and a stubbed session; the first draft of it asserted
    ``>= 0.0``, which is true of every possible value, and its ``hasattr``
    ternary meant it never called the code under test at all. Rather than ship a
    test that cannot fail, the guard checks that the early return is not bare —
    which is the property that regressed.
    """

    def test_the_breaker_guard_records_a_drop(self) -> None:
        """Source-level: the early return must not be bare."""
        import inspect

        from eden.observability import typesense_client as mod

        src = inspect.getsource(mod)
        idx = src.index("if not self._is_reachable():")
        window = src[idx : idx + 400]
        assert "record_drop" in window, (
            "the circuit-breaker early return still discards docs silently"
        )


class TestVocabularyIsRespected:
    """A closed vocabulary is only closed if everyone uses it."""

    def test_all_recorded_pairs_are_in_the_vocabulary(self) -> None:
        import ast
        from pathlib import Path

        from eden.observability.drop_metrics import REASONS, STAGES

        src_root = Path(__file__).resolve().parents[3] / "src" / "eden"
        bad: list[str] = []
        for path in sorted(src_root.rglob("*.py")):
            if path.name == "drop_metrics.py":
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (OSError, SyntaxError):  # pragma: no cover
                continue
            for node in ast.walk(tree):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name)
                    and node.func.id == "record_drop"
                    and len(node.args) >= 2
                ):
                    stage, reason = node.args[0], node.args[1]
                    if isinstance(stage, ast.Constant) and stage.value not in STAGES:
                        bad.append(f"{path.name}:{node.lineno} stage={stage.value!r}")
                    if isinstance(reason, ast.Constant) and reason.value not in REASONS:
                        bad.append(f"{path.name}:{node.lineno} reason={reason.value!r}")
        assert not bad, (
            "record_drop called with values outside the closed vocabulary — "
            f"these would be silently bucketed as unknown: {bad}"
        )

    def test_the_scan_finds_call_sites(self) -> None:
        """Guards the guard: an empty scan makes the check above vacuous."""
        import ast
        from pathlib import Path

        src_root = Path(__file__).resolve().parents[3] / "src" / "eden"
        count = 0
        for path in sorted(src_root.rglob("*.py")):
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (OSError, SyntaxError):  # pragma: no cover
                continue
            count += sum(
                1
                for n in ast.walk(tree)
                if isinstance(n, ast.Call)
                and isinstance(n.func, ast.Name)
                and n.func.id == "record_drop"
            )
        assert count >= 10, f"only found {count} record_drop call sites"
