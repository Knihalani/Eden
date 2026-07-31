"""The gateway's telemetry emit must not be in the response path.

All fourteen call sites used to ``await _emit_gateway_telemetry(...)`` before
returning, so every request paid for the whole emit inline: a PII scrub of the
request body (~157us/KiB — tens of milliseconds on a large prompt) plus a
Postgres write. Nothing in the response depends on either; the emit function's
own docstring says it never raises and that the response "has already been (or
is about to be) returned".

The behavioural test here is the one that matters: make the collector block, and
assert the route still returns. If the emit is awaited, the request cannot
complete until the collector does, and the test times out on its own terms
rather than by wall-clock guessing.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any
from unittest.mock import AsyncMock

import pytest


class TestTheEmitDoesNotBlockTheResponse:
    def test_a_slow_collector_does_not_delay_the_response(self) -> None:
        """A blocked collector must not hold the request open.

        Calls the emit path directly rather than through the full route stack,
        so the assertion is about the fan-out and not about gateway auth,
        upstream stubs, or serialisation.
        """
        from eden.api.routes import gateway as gw

        released = asyncio.Event()
        started = asyncio.Event()

        async def _blocking_ingest(*a: Any, **k: Any) -> Any:
            started.set()
            await released.wait()
            return {"accepted": 1}

        collector = AsyncMock()
        collector.ingest_batch = _blocking_ingest

        async def _run() -> float:
            async def _get_collector() -> Any:
                return collector

            orig = gw.get_telemetry_collector
            gw.get_telemetry_collector = _get_collector  # type: ignore[assignment]
            try:
                t0 = time.perf_counter()
                gw._emit_gateway_telemetry_bg(
                    org_id="org-1",
                    auth_ctx={},
                    model="gpt-4o-mini",
                    endpoint="chat.completions",
                    request_body={"messages": [{"role": "user", "content": "hi"}]},
                )
                # Scheduling must return immediately; it is not awaited.
                elapsed = time.perf_counter() - t0
                # Let the task actually start, so we know it is running and
                # blocked rather than never scheduled.
                await asyncio.wait_for(started.wait(), timeout=5.0)
                released.set()
                from eden.async_tasks import drain_background_tasks

                await drain_background_tasks(timeout=5.0)
                return elapsed
            finally:
                gw.get_telemetry_collector = orig  # type: ignore[assignment]

        elapsed = asyncio.run(_run())
        assert elapsed < 0.05, (
            f"scheduling the telemetry emit took {elapsed * 1000:.0f}ms — it is "
            "being awaited rather than backgrounded, so a slow collector is "
            "inside every gateway response's latency"
        )

    def test_the_emit_still_happens(self) -> None:
        """Off the response path, not dropped."""
        from eden.api.routes import gateway as gw

        collector = AsyncMock()
        collector.ingest_batch = AsyncMock(return_value={"accepted": 1})

        async def _run() -> int:
            async def _get_collector() -> Any:
                return collector

            orig = gw.get_telemetry_collector
            gw.get_telemetry_collector = _get_collector  # type: ignore[assignment]
            try:
                gw._emit_gateway_telemetry_bg(
                    org_id="org-1",
                    auth_ctx={},
                    model="gpt-4o-mini",
                    endpoint="chat.completions",
                    request_body={"messages": [{"role": "user", "content": "hi"}]},
                )
                from eden.async_tasks import drain_background_tasks

                await drain_background_tasks(timeout=5.0)
                return int(collector.ingest_batch.await_count)
            finally:
                gw.get_telemetry_collector = orig  # type: ignore[assignment]

        assert asyncio.run(_run()) == 1, (
            "the backgrounded emit never reached the collector — moving it off "
            "the response path must not turn it into a dropped write"
        )

    def test_no_call_site_awaits_the_emit(self) -> None:
        """Source guard: one reverted site puts the cost back for that path.

        Fourteen sites is enough that converting them individually and missing
        one is the likely failure, and it would be invisible — that path simply
        gets slower.
        """
        from pathlib import Path

        src = (
            Path(__file__).resolve().parents[2]
            / "src/eden/api/routes/gateway.py"
        ).read_text()
        assert "await _emit_gateway_telemetry(" not in src, (
            "a call site still awaits the telemetry emit inline, putting the "
            "PII scrub and the Postgres write back into that response's latency"
        )
        # And the background wrapper must actually be used.
        assert src.count("_emit_gateway_telemetry_bg(") >= 14, (
            "expected at least 14 background emit call sites; found "
            f"{src.count('_emit_gateway_telemetry_bg(')} — this guard has gone "
            "stale, or sites were removed"
        )

    def test_the_background_task_is_tracked_and_drainable(self) -> None:
        """It must go through bounded_create_task, not raw create_task.

        That is what gives it a strong reference (so it is not collected
        mid-await), a concurrency cap, a detached Postgres context, and
        inclusion in the shutdown drain.
        """
        import inspect

        from eden.api.routes import gateway as gw

        body = inspect.getsource(gw._emit_gateway_telemetry_bg)
        assert "bounded_create_task" in body, (
            "the emit is scheduled with a raw create_task, so it is neither "
            "drained on shutdown nor detached from the request's pinned "
            "Postgres connection"
        )
        assert "asyncio.create_task" not in body
