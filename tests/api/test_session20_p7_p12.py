"""Session 20 tests — Gather + executemany + per-key locks (P-7..P-12).

Six audit items:

* **P-7** — ``autonomous._common._load_top_signals`` issued 4
  sequential ``client.fetch`` calls. Pre-fix: 4 × ~10ms = 40ms.
  Post-fix: max(single_query) ≈ 10ms via ``asyncio.gather``.

* **P-8** — ``cost_intel.efficiency.CostEfficiencyScorer.score``
  issued 2 sequential fetches (cost_by_group +
  outcomes_by_type). ``ROIAnalyzer.roi`` issued 2 sequential
  fetches (spend + value). Post-fix: both via ``asyncio.gather``.

* **P-9** — ``agent_intel._common._fetch_telemetry_rollup_for_agent``
  issued 3 sequential fetches (telemetry + cost + judge).
  Post-fix: gathered.

* **P-10** — ``sdk.streaming.StreamingTokenCapture.write_batch``
  awaited each ``client.execute`` in a for-loop. Post-fix: pre-
  allocate indices in serial, then ``asyncio.gather`` the N
  inserts. Ponytail: gather over executemany because the index
  dict MUST be allocated serially + the best-effort "one failure
  doesn't kill batch" semantics are easier with gather.

* **P-11** — exploration sweep: no additional gather candidates
  beyond P-7/8/9. Transaction bodies must stay serial.

* **P-12** — ``StreamingTokenCapture._last_index`` was mutated
  without a lock. Concurrent writers to the SAME span_id could
  race on the index counter. Fix: per-span_id asyncio.Lock dict
  (``_span_locks``). Different spans don't contend.
  Also: deleted dead ``_typesense_lock`` in typesense_client.py,
  replaced ``LatencyHistogram._lock`` (single global) with per-
  bucket ``threading.Lock`` keyed by ``(method, route_template)``.
"""

from __future__ import annotations

import asyncio
import inspect
import threading
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ─── P-7: autonomous._load_top_signals uses gather ──────────────────


class TestP7LoadTopSignalsParallel:
    """The 4 fetches in ``_load_top_signals`` fire via
    ``asyncio.gather`` rather than sequentially."""

    def test_load_top_signals_uses_gather(self) -> None:
        """Static check: the function uses ``asyncio.gather``
        for its 4 subqueries."""
        from eden.autonomous import _common

        source = inspect.getsource(_common._load_top_signals)
        assert "asyncio.gather" in source, (
            "P-7 regression: _load_top_signals doesn't use asyncio.gather"
        )

    def test_load_top_signals_runs_concurrently(self) -> None:
        """Performance check: 4 subqueries at 50ms each → total
        wall-clock ~50ms (gather), not 200ms (sequential)."""
        delay = 0.05

        async def _slow_fetch(*args: Any, **kwargs: Any) -> list:
            await asyncio.sleep(delay)
            return []

        client = MagicMock()
        client.fetch = _slow_fetch

        from eden.autonomous import _common

        async def _run() -> dict:
            # P-7 imports ``get_postgres_client`` inside the
            # function, so patch the import target — same
            # effect, but works with the lazy import.
            with patch(
                "eden.storage.postgres.get_postgres_client",
                new=AsyncMock(return_value=client),
            ):
                return await _common._load_top_signals("org-1")

        t0 = time.monotonic()
        asyncio.run(_run())
        elapsed = time.monotonic() - t0

        # Sequential would be 200ms (4 × 50ms); gather should
        # be ~50ms.
        assert elapsed < 0.15, (
            f"P-7 regression: 4 × 50ms subqueries took {elapsed:.3f}s "
            f"(gather should be ~0.05s; sequential ~0.2s)"
        )


# ─── P-8: cost_intel efficiency + ROI use gather ─────────────────────


class TestP8CostIntelParallel:
    """``CostEfficiencyScorer.score`` and ``ROIAnalyzer.roi``
    fire their source-table reads via ``asyncio.gather``."""

    def test_score_uses_gather(self) -> None:
        """Static check: ``CostEfficiencyScorer.score`` body uses
        ``asyncio.gather`` for the 2 fetches."""
        from eden.services.cost_intel import efficiency

        source = inspect.getsource(efficiency.CostEfficiencyScorer.score)
        assert "asyncio.gather" in source, (
            "P-8 regression: CostEfficiencyScorer.score doesn't use gather"
        )

    def test_roi_uses_gather(self) -> None:
        """Static check: ``ROIAnalyzer.roi`` body uses
        ``asyncio.gather`` for spend + value fetches."""
        from eden.services.cost_intel import efficiency

        source = inspect.getsource(efficiency.ROIAnalyzer.roi)
        assert "asyncio.gather" in source, (
            "P-8 regression: ROIAnalyzer.roi doesn't use gather"
        )


# ─── P-9: agent_intel _fetch_telemetry_rollup_for_agent uses gather ─


class TestP9AgentIntelParallel:
    """The 3 source-table fetches fire via ``asyncio.gather``."""

    def test_rollup_uses_gather(self) -> None:
        """Static check: ``_fetch_telemetry_rollup_for_agent``
        uses ``asyncio.gather`` for telemetry + cost + judge."""
        from eden.agents.agent_intel import _common

        source = inspect.getsource(_common._fetch_telemetry_rollup_for_agent)
        assert "asyncio.gather" in source, (
            "P-9 regression: _fetch_telemetry_rollup_for_agent "
            "doesn't use asyncio.gather"
        )


# ─── P-10: sdk.streaming write_batch uses gather ─────────────────────


class TestP10StreamingBatchParallel:
    """``StreamingTokenCapture.write_batch`` pre-allocates per-span
    indices serially, then fires the N inserts via
    ``asyncio.gather``."""

    def test_write_batch_uses_gather(self) -> None:
        """Static check: ``write_batch`` body uses ``asyncio.gather``
        for the parallel insert fan-out."""
        from eden.sdk.streaming import StreamingTokenCapture

        source = inspect.getsource(StreamingTokenCapture.write_batch)
        assert "asyncio.gather" in source, (
            "P-10 regression: StreamingTokenCapture.write_batch "
            "doesn't use asyncio.gather"
        )

    def test_write_batch_indexes_allocated_before_gather(self) -> None:
        """Static check: the index pre-allocation
        (``self._last_index[span_id] = idx``) happens BEFORE
        the gather call (so each token's index is stable
        regardless of gather completion order). Use AST to
        find the actual code positions, skipping docstrings
        and comments."""
        import ast
        import textwrap

        from eden.sdk.streaming import StreamingTokenCapture

        # Walk the function body and find the first statement
        # matching each pattern.

        tree = ast.parse(
            textwrap.dedent(
                inspect.getsource(StreamingTokenCapture.write_batch)
            )
        )
        func = tree.body[0]
        assert isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef))

        def _find_index_pre_allocation(body: list[ast.stmt]) -> int | None:
            for node in ast.walk(ast.Module(body=body, type_ignores=[])):
                if isinstance(node, ast.Assign):
                    for tgt in node.targets:
                        if (
                            isinstance(tgt, ast.Subscript)
                            and isinstance(tgt.value, ast.Attribute)
                            and tgt.value.attr == "_last_index"
                        ):
                            return node.lineno
            return None

        def _find_gather_call(body: list[ast.stmt]) -> int | None:
            for node in ast.walk(ast.Module(body=body, type_ignores=[])):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "gather"
                ):
                    return node.lineno
            return None

        idx_line = _find_index_pre_allocation(func.body)
        gather_line = _find_gather_call(func.body)
        assert idx_line is not None, (
            "P-10 regression: no _last_index assignment in write_batch"
        )
        assert gather_line is not None, (
            "P-10 regression: no asyncio.gather call in write_batch"
        )
        assert idx_line < gather_line, (
            f"P-10 regression: index alloc at line {idx_line} must "
            f"precede gather at line {gather_line}"
        )


# ─── P-12: per-span_id asyncio.Lock + LatencyHistogram per-bucket ────


class TestP12StreamingLockPerSpan:
    """``StreamingTokenCapture`` has per-span asyncio.Lock dict
    to protect ``_last_index`` mutation across concurrent
    writers. Different spans must NOT contend (lock-per-key)."""

    def test_capture_has_per_span_locks(self) -> None:
        """Static check: ``StreamingTokenCapture`` has a
        ``_span_locks`` dict attribute."""
        from eden.sdk.streaming import StreamingTokenCapture

        c = StreamingTokenCapture()
        assert hasattr(c, "_span_locks")
        assert isinstance(c._span_locks, dict)

    def test_lock_for_creates_per_span_lock(self) -> None:
        """The ``_lock_for`` helper creates a fresh
        ``asyncio.Lock`` per span_id."""
        from eden.sdk.streaming import StreamingTokenCapture

        c = StreamingTokenCapture()
        lk_a = c._lock_for("span-a")
        lk_b = c._lock_for("span-b")
        assert isinstance(lk_a, asyncio.Lock)
        assert isinstance(lk_b, asyncio.Lock)
        # Different spans → different lock objects.
        assert lk_a is not lk_b
        # Same span → same lock (cached).
        assert c._lock_for("span-a") is lk_a


class TestP12LatencyHistogramPerBucket:
    """``LatencyHistogram`` uses per-(method, route_template)
    ``threading.Lock`` instead of one global lock."""

    def test_histogram_has_lock_dict(self) -> None:
        """Static check: ``LatencyHistogram`` exposes a single
        re-entrant lock that serialises observe vs snapshot.

        Audit 2026-07-06 — v1.9 dropped the per-(method, route)
        ``_locks`` dict and replaced it with a single ``RLock``
        (per-bucket allocation was a measurable cost on the hot
        path; contention at observed request rate was negligible).
        The functional invariant — observe/snapshot can never
        interleave a torn row — is preserved (single RLock acquire
        gives the same atomicity guarantee).
        """
        from eden.api.middleware.latency import LatencyHistogram

        h = LatencyHistogram()
        assert hasattr(h, "_lock")
        # threading.RLock is re-entrant so snapshot() never blocks
        # on itself if a future caller composes both operations.
        # ``RLock`` is a factory function, not a class.
        # ``type(h._lock)`` is ``_thread.RLock`` which is the
        # CPython internal that ``threading.RLock`` returns.
        assert type(h._lock).__name__ in {"RLock", "_RLock"}

    def test_histogram_creates_per_bucket_lock(self) -> None:
        """First observation is observable in the next snapshot().

        Audit 2026-07-06 — v1.9 dropped the per-(method, route)
        ``_locks`` dict and replaced it with a single ``RLock``.
        The invariant this test was guarding ("a fresh histogram
        correctly buckets distinct (method, route) keys") is
        preserved by the single-lock impl + the v1.9 ``_data``
        ``defaultdict``. Re-asserted at the (method, route)
        granularity instead of the lock granularity.
        """
        from eden.api.middleware.latency import LatencyHistogram

        h = LatencyHistogram()
        h.observe("GET", "/a", 200, 12.0)
        h.observe("POST", "/b", 200, 12.0)
        snap = h.snapshot()
        routes = {r["route"] for r in snap["rows"]}
        assert "/a" in routes
        assert "/b" in routes
        # Same key obs doesn't create a duplicate bucket row.
        h.observe("GET", "/a", 200, 12.0)
        snap_after = h.snapshot()
        routes_after = {r["route"] for r in snap_after["rows"]}
        assert routes_after == routes

    def test_histogram_snapshot_includes_both_routes(self) -> None:
        """``snapshot()`` works after per-bucket observations."""
        from eden.api.middleware.latency import LatencyHistogram

        h = LatencyHistogram()
        h.observe("GET", "/a", 200, 12.0)
        h.observe("POST", "/b", 200, 99.0)
        snap = h.snapshot()
        assert "buckets_ms" in snap
        assert "rows" in snap
        routes = {r["route"] for r in snap["rows"]}
        assert "/a" in routes and "/b" in routes


class TestP12DeadTypesenseLockRemoved:
    """``typesense_client._typesense_lock`` was dead code."""

    def test_no_typesense_lock_attribute(self) -> None:
        """The dead ``_typesense_lock`` module attribute is gone."""
        from eden.observability import typesense_client

        assert not hasattr(typesense_client, "_typesense_lock"), (
            "P-12 regression: dead _typesense_lock should be removed"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
