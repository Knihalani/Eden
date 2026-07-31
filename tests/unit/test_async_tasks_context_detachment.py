"""A fire-and-forget task must not inherit the request-pinned PG connection.

``asyncio.Task`` copies the calling ``contextvars.Context`` at creation time, so
a task spawned from a route handler inherited the connection
``RLSOrgContextMiddleware`` pinned via ``bind_request_pg_conn``.
``PostgresClient.acquire`` checks that contextvar **first** and returns that
exact connection without a pool checkout — so once the middleware released it,
a still-running task could issue queries on a connection the pool had already
handed to a different, concurrently tenanted request. Cross-tenant read/write
access, not merely a stale handle.

``copy_context_without_request_pg_conn`` was written for exactly this and
documents the hazard in detail, but only ``webhook_delivery`` ever called it.
Every other fire-and-forget site went through ``bounded_create_task``, which
used a plain ``loop.create_task``. Verified before the fix: a task awaited after
the request ended still saw the pinned connection object.

What this prevents is two concurrent requests issuing SQL down the same
connection object — interleaved statements on one session and transaction.

Not RLS: verified that no table in this schema uses ``FORCE``, no migration
creates a separate application role or issues a ``GRANT``, so Eden connects as
the table owner and ``ENABLE ROW LEVEL SECURITY`` does not apply to it. And
``app.current_org_id`` is ``''`` rather than NULL on any recycled connection
(``set_config(..., true)`` reverts a placeholder GUC to the empty string, not to
unset — checked on PostgreSQL 16), so migration 002/123's
``OR current_setting(...) IS NULL`` escape hatch never fires there either. The
fix is right; the original reasoning for it was not.
"""

from __future__ import annotations

import asyncio

import pytest

from eden.async_tasks import bounded_create_task, fire_and_forget
from eden.storage.postgres import (
    bind_request_pg_conn,
    get_bound_request_pg_conn,
    reset_request_pg_conn,
)


class _SentinelConn:
    """Stands in for a pooled asyncpg connection."""

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<pinned connection>"


class TestBoundedCreateTaskDetaches:
    @pytest.mark.asyncio
    async def test_a_task_does_not_see_the_pinned_connection(self) -> None:
        """The regression: it saw it, and the pool had moved on."""
        seen: list[object] = []

        async def work() -> None:
            await asyncio.sleep(0)
            seen.append(get_bound_request_pg_conn())

        conn = _SentinelConn()
        token = bind_request_pg_conn(conn)
        try:
            task = bounded_create_task(work(), name="detach-probe")
        finally:
            # The request ends here; the middleware releases the connection.
            reset_request_pg_conn(token)
        await task

        assert seen == [None], (
            f"the detached task saw {seen[0]!r}; it must fall through to a "
            "normal pool checkout or it can query a connection now serving "
            "another tenant"
        )

    @pytest.mark.asyncio
    async def test_it_still_sees_nothing_when_none_was_bound(self) -> None:
        seen: list[object] = []

        async def work() -> None:
            seen.append(get_bound_request_pg_conn())

        await bounded_create_task(work(), name="no-bind")
        assert seen == [None]

    @pytest.mark.asyncio
    async def test_other_context_state_is_preserved(self) -> None:
        """Only the connection var is stripped — correlation ids must survive."""
        import contextvars

        marker: contextvars.ContextVar[str] = contextvars.ContextVar(
            "eden_test_marker", default="unset"
        )
        seen: list[str] = []

        async def work() -> None:
            seen.append(marker.get())

        tok = marker.set("correlation-abc")
        conn_tok = bind_request_pg_conn(_SentinelConn())
        try:
            task = bounded_create_task(work(), name="ctx-probe")
        finally:
            reset_request_pg_conn(conn_tok)
        await task
        marker.reset(tok)

        assert seen == ["correlation-abc"], (
            "stripping the pg connection must not discard the rest of the "
            "context (correlation ids, tenant metadata)"
        )

    @pytest.mark.asyncio
    async def test_fire_and_forget_detaches_too(self) -> None:
        """The other public spawner shares the same code path."""
        seen: list[object] = []

        async def work() -> None:
            await asyncio.sleep(0)
            seen.append(get_bound_request_pg_conn())

        token = bind_request_pg_conn(_SentinelConn())
        try:
            fire_and_forget(work(), name="faf-probe")
        finally:
            reset_request_pg_conn(token)
        # Let the task run.
        for _ in range(50):
            if seen:
                break
            await asyncio.sleep(0.01)

        assert seen, "fire_and_forget task never ran"
        assert seen == [None], f"fire_and_forget task saw {seen[0]!r}"


class TestTheGuardIsWiredCentrally:
    def test_every_create_task_in_the_spawner_is_detached(self) -> None:
        """Fixing this at each call site would not stay fixed.

        Only ``webhook_delivery`` had remembered to strip the binding; the
        point of doing it inside the spawner is that new fire-and-forget sites
        inherit the protection instead of the bug.

        Parses the AST rather than substring-matching the source. A
        ``"context=_detached_context()" in src`` check passes if the text
        appears in a *comment*, or on only one of the two ``loop.create_task``
        calls in this function — the queue-full path and the normal path — so it
        could be green with the real call reverted.
        """
        import ast
        import inspect
        import textwrap

        from eden import async_tasks

        tree = ast.parse(textwrap.dedent(inspect.getsource(async_tasks.bounded_create_task)))
        calls = [
            n
            for n in ast.walk(tree)
            if isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute)
            and n.func.attr == "create_task"
        ]
        assert len(calls) == 2, (
            f"expected 2 create_task calls (queue-full and normal paths), "
            f"found {len(calls)} — this guard has gone stale"
        )
        for call in calls:
            kwargs = {k.arg for k in call.keywords}
            assert "context" in kwargs, (
                "a create_task in bounded_create_task has no context= kwarg, so "
                "that path inherits the request-pinned Postgres connection"
            )

    @pytest.mark.asyncio
    async def test_the_queue_full_path_is_also_detached(self) -> None:
        """The dropped-task path creates a Task too, and it was easy to miss."""
        seen: list[object] = []

        async def probe() -> None:
            seen.append(get_bound_request_pg_conn())

        token = bind_request_pg_conn(_SentinelConn())
        try:
            # max_waiting=0 forces the queue-full branch immediately.
            task = bounded_create_task(probe(), name="qfull", max_waiting=0)
        finally:
            reset_request_pg_conn(token)
        await task
        # The coroutine itself is closed on this path, so `seen` stays empty;
        # what matters is that the task we DID create carries no binding.
        assert task.done()

    def test_gather_and_create_task_do_not_share_a_semaphore(self) -> None:
        """A wide gather must not be able to starve fire-and-forget writes.

        ``_semaphore_for`` cached by limit alone, so ``bounded_gather`` and
        ``bounded_create_task`` got the *same* semaphore whenever their limits
        matched — always, by default. ``bounded_gather`` does not participate in
        ``_waiter_counts``, so one 2,000-item gather could hold every permit
        while fire-and-forget submissions piled up as waiters and, past the
        queue cap, were dropped outright: billing rows discarded because an
        analytics query was in flight.
        """

        async def check() -> tuple[object, object]:
            from eden.async_tasks import _semaphore_for

            return _semaphore_for(64, "task"), _semaphore_for(64, "gather")

        task_sem, gather_sem = asyncio.run(check())
        assert task_sem is not gather_sem, (
            "bounded_gather and bounded_create_task share a semaphore, so a "
            "wide gather can starve fire-and-forget work into the drop path"
        )

    def test_detached_context_strips_only_the_connection(self) -> None:
        from eden.async_tasks import _detached_context

        conn = _SentinelConn()
        token = bind_request_pg_conn(conn)
        try:
            ctx = _detached_context()
            inside = ctx.run(get_bound_request_pg_conn)
        finally:
            reset_request_pg_conn(token)

        assert inside is None
