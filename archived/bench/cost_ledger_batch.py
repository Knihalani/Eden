"""Wave 9 — $0-cost ledger writes: N single INSERTs vs ONE executemany.

``customer_cost_events`` rows with cost_usd = 0 (classifier savings
markers on the always-on ``trace.finalized`` path) used to cost one
``execute()`` round-trip each. The Wave 9 batched path buffers them and
flushes in one ``executemany``. This bench measures the write-path
improvement with a fake client that counts round-trips, and also
compares wall-clock on a mocked client where each round-trip carries a
small latency (the thing the batch removes).

Usage::

    uv run python -m bench.cost_ledger_batch
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock

# Direct-run bootstrap: ``python bench/cost_ledger_batch.py`` — add the
# repo root so the ``bench`` package resolves.
_REPO_ROOT = str(Path(__file__).resolve().parents[1])
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import bench.common  # noqa: F401, E402  (side-effect: sys.path fixup)
from eden.llmops.cost_ledger import (  # noqa: E402
    CostEvent,
    flush_zero_cost_events,
    record_cost_event,
    reset_zero_cost_buffer_for_tests,
)

N_EVENTS = 200
ORG = "org-bench"


class _FakeClient:
    """Counts round-trips; executemany is ONE round-trip for N rows."""

    def __init__(self) -> None:
        self.execute_calls = 0
        self.executemany_calls = 0
        self.last_batch_size = 0

    async def execute(self, *args: object, **kwargs: object) -> None:
        self.execute_calls += 1

    async def executemany(self, sql: str, rows: list[tuple[object, ...]]) -> None:
        self.executemany_calls += 1
        self.last_batch_size = len(rows)


class _LatencyClient(_FakeClient):
    """Per-round-trip latency, so wall-clock shows the batch's win."""

    async def execute(self, *args: object, **kwargs: object) -> None:
        await asyncio.sleep(0.001)  # ~1ms per round-trip
        self.execute_calls += 1

    async def executemany(self, sql: str, rows: list[tuple[object, ...]]) -> None:
        await asyncio.sleep(0.001)  # ONE round-trip regardless of N
        self.executemany_calls += 1
        self.last_batch_size = len(rows)


def _events() -> list[CostEvent]:
    return [
        CostEvent(
            org_id=ORG,
            feature="signal_classifier",
            model="f34_logistic",
            cost_usd=0.0,
        )
        for _ in range(N_EVENTS)
    ]


async def _run_write_through(client: _FakeClient) -> None:
    import eden.storage.postgres as pg_mod

    pg_mod.get_postgres_client = AsyncMock(return_value=client)  # type: ignore[assignment]
    from eden.llmops import cost_ledger as cl

    saved = cl._zero_cost_batching_enabled
    cl._zero_cost_batching_enabled = lambda: False  # type: ignore[method-assign]
    try:
        for ev in _events():
            await record_cost_event(ev)
    finally:
        cl._zero_cost_batching_enabled = saved  # type: ignore[method-assign]


async def _run_batched(client: _FakeClient) -> None:
    import eden.storage.postgres as pg_mod

    pg_mod.get_postgres_client = AsyncMock(return_value=client)  # type: ignore[assignment]
    for ev in _events():
        await record_cost_event(ev)
    await flush_zero_cost_events()


async def main() -> None:
    reset_zero_cost_buffer_for_tests()

    # Round-trip accounting (no latency).
    fast = _FakeClient()
    await _run_write_through(fast)
    print(f"write-through: {fast.execute_calls} execute() round-trips")

    reset_zero_cost_buffer_for_tests()
    fast2 = _FakeClient()
    await _run_batched(fast2)
    print(f"batched:       {fast2.executemany_calls} executemany() x {fast2.last_batch_size} rows")

    # Wall-clock with ~1ms per round-trip (the realistic shape).
    reset_zero_cost_buffer_for_tests()
    lat = _LatencyClient()
    t0 = time.monotonic()
    await _run_write_through(lat)
    t_write_through = time.monotonic() - t0

    reset_zero_cost_buffer_for_tests()
    lat2 = _LatencyClient()
    t0 = time.monotonic()
    await _run_batched(lat2)
    t_batched = time.monotonic() - t0

    speedup = t_write_through / t_batched if t_batched else float("inf")
    print(f"wall-clock ({N_EVENTS} events, ~1ms/round-trip):")
    print(f"  write-through: {t_write_through * 1000:.1f}ms")
    print(f"  batched:       {t_batched * 1000:.1f}ms  ->  {speedup:.0f}x faster")

    reset_zero_cost_buffer_for_tests()
    assert lat2.executemany_calls == 1, "batched path must be exactly one executemany"
    assert lat2.last_batch_size == N_EVENTS


if __name__ == "__main__":
    asyncio.run(main())
