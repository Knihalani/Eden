"""Behavioural regression tests for the workers performance remediation.

Four fixes, four tests. Each asserts an observable property — call
counts, peak concurrency, boto3 constructions, drain wakeups — never
the presence of a string in the source, so none of them can pass
against a commented-out fix.

1. ``cron_tick._run_auto_curator`` fans out over orgs under a
   concurrency cap instead of awaiting them one at a time.
2. ``ArchiveService`` builds one boto3 S3 client per process, not one
   per archived trace.
3. ``McpTraceService.rollup_registry`` upserts the registry with a
   single ``executemany`` instead of N ``execute`` round-trips.
4. ``trace_quality.hooks._drain_loop`` is event-driven: zero wakeups
   while the action queue is empty.
"""
from __future__ import annotations

import asyncio
import contextlib
import io
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.async_tasks import reset_bounded_task_semaphores


@pytest.fixture(autouse=True)
def _clean_semaphores():
    reset_bounded_task_semaphores()
    yield
    reset_bounded_task_semaphores()


# ── 1. cron_tick auto-curator fan-out ────────────────────────────────


async def test_auto_curator_fans_out_under_a_concurrency_cap():
    """50 orgs must overlap, capped, not run strictly one-at-a-time.

    ``run_for_org`` records how many calls are in flight at once. The
    old sequential ``for`` loop pins that at 1; the bounded fan-out
    pins it at the configured cap. Ordering of the returned runs is
    asserted too — the result dict is positional against ``org_rows``.
    """
    from eden.workers import cron_tick

    n_orgs = 50
    cap = cron_tick._AUTO_CURATOR_CONCURRENCY
    assert cap > 1, "a cap of 1 is the sequential loop this test guards"

    pg = MagicMock()
    pg.fetch = AsyncMock(
        return_value=[{"org_id": f"org-{i}"} for i in range(n_orgs)]
    )
    pg.execute = AsyncMock(return_value="INSERT 0 1")

    inflight = 0
    peak = 0

    async def _run(oid: str):
        nonlocal inflight, peak
        inflight += 1
        peak = max(peak, inflight)
        try:
            # Bare yields, not a timed sleep: they hand control back to
            # the loop so every sibling the semaphore admits gets to
            # increment `inflight` before any of them finishes. A
            # sequential ``for`` loop can never get `peak` above 1 here.
            for _ in range(3):
                await asyncio.sleep(0)
            return {"org_id": oid, "ok": True}
        finally:
            inflight -= 1

    curator = MagicMock()
    curator.run_for_org = AsyncMock(side_effect=_run)

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=pg),
        ),
        patch("eden.evaluation.auto_curator.AutoCurator", return_value=curator),
    ):
        out = await asyncio.wait_for(cron_tick._run_auto_curator(), timeout=10)

    assert out["orgs"] == n_orgs
    assert out["error_count"] == 0
    # Overlap actually happened, and never exceeded the cap.
    assert peak == cap, f"expected peak concurrency {cap}, got {peak}"
    assert curator.run_for_org.await_count == n_orgs
    # Order preserved: `runs` is positional against the org rows.
    assert [r["org_id"] for r in out["runs"]] == [
        f"org-{i}" for i in range(len(out["runs"]))
    ]


# ── 2. archive: one boto3 client per process ─────────────────────────


async def test_archive_builds_one_s3_client_for_many_traces():
    """Archiving N traces must not construct N boto3 clients.

    ``boto3.client("s3")`` measures ~2.7 ms steady state (154 ms for
    the first in a process), and both S3 helpers are per-trace paths.
    """
    from eden.services.data_platform import archive as arch

    arch._reset_s3_clients()

    builds = 0
    fake = MagicMock()
    fake.put_object = MagicMock(return_value={})
    fake.get_object = MagicMock(return_value={"Body": io.BytesIO(b"{}")})

    def _client(*a, **kw):
        nonlocal builds
        builds += 1
        return fake

    svc = arch.ArchiveService()
    settings = MagicMock()
    settings.bronze_s3_bucket = "b"

    n = 25
    with (
        patch("boto3.client", _client),
        patch.object(arch, "get_settings", return_value=settings),
    ):
        for i in range(n):
            await svc._write_impossible_cloud(f"k/{i}", "{}")
        for i in range(n):
            await svc._read_impossible_cloud(f"k/{i}")

    assert fake.put_object.call_count == n
    assert fake.get_object.call_count == n
    assert builds == 1, (
        f"expected 1 boto3 client for {2 * n} S3 operations, built {builds}"
    )

    arch._reset_s3_clients()


# ── 3. mcp rollup: one executemany, not N executes ───────────────────


async def test_mcp_rollup_registry_upserts_in_one_round_trip():
    """N servers must cost one statement, not N sequential executes."""
    from eden.services.observability.mcp_traces import McpTraceService

    n = 40
    servers = [
        {
            "org_id": f"org{i % 3}",
            "server_name": f"srv-{i}",
            "first_seen": None,
            "last_seen": None,
            "tool_names": ["a", "b"],
            "transport": "stdio",
            "call_count_7d": i,
        }
        for i in range(n)
    ]

    client = MagicMock()
    client.fetch = AsyncMock(return_value=servers)
    client.execute = AsyncMock(return_value="INSERT 0 1")
    client.executemany = AsyncMock(return_value="INSERT 0 1")

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=client),
    ):
        out = await McpTraceService().rollup_registry()

    assert out == {"servers": n, "tools": 2 * n}
    assert client.execute.await_count == 0, (
        "per-server execute() is the N+1 this test guards"
    )
    assert client.executemany.await_count == 1

    _sql, params = client.executemany.await_args.args
    assert len(params) == n
    # Every server made it into the batch, with its own parameters.
    assert [p[1] for p in params] == [f"srv-{i}" for i in range(n)]
    assert [p[6] for p in params] == list(range(n))


# ── 4. trace_quality drain loop is event-driven ──────────────────────


async def test_drain_loop_does_not_wake_while_the_queue_is_empty():
    """Idle drain wakeups must be 0, and a queued row must still flush.

    The old loop opened each iteration with an unconditional
    ``asyncio.sleep(0.25)``: measured 3.67 wakeups/sec on an idle
    process. The idle path touches the queue exactly once per wakeup,
    so counting ``__len__`` counts wakeups without instrumenting the
    module under test.
    """
    from eden.observability.trace_quality import hooks

    class CountingQueue(hooks._ActionQueue):
        __slots__ = ("len_calls",)

        def __init__(self) -> None:
            super().__init__()
            self.len_calls = 0

        def __len__(self) -> int:
            self.len_calls += 1
            return super().__len__()

    orig_queue = hooks._ACTION_QUEUE
    orig_flush = hooks._flush_once
    orig_wakeup = hooks._ACTION_WAKEUP
    q = CountingQueue()
    hooks._ACTION_QUEUE = q
    hooks._ACTION_WAKEUP = asyncio.Event()

    flushed: list[tuple] = []
    flush_done = asyncio.Event()

    async def _fake_flush() -> int:
        rows = q.drain(hooks._ACTION_QUEUE_BATCH)
        flushed.extend(rows)
        flush_done.set()
        return len(rows)

    hooks._flush_once = _fake_flush
    task = asyncio.create_task(hooks._drain_loop())
    try:
        # Idle window >> the old 0.25 s poll interval: the old loop
        # would have woken ~4x here.
        idle_window = 1.5
        t0 = time.perf_counter()
        await asyncio.sleep(idle_window)
        elapsed = time.perf_counter() - t0
        idle_wakeups = q.len_calls
        assert idle_wakeups == 0, (
            f"{idle_wakeups} wakeups in {elapsed:.2f}s "
            f"({idle_wakeups / elapsed:.2f}/sec) — the drain loop is polling"
        )

        # ...but a queued row still gets drained, promptly.
        q.push(("row",))
        await asyncio.wait_for(flush_done.wait(), timeout=5)
        assert len(flushed) == 1
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        hooks._ACTION_QUEUE = orig_queue
        hooks._flush_once = orig_flush
        hooks._ACTION_WAKEUP = orig_wakeup
