"""Request-scoped PG connection binding for FORCE RLS."""

from __future__ import annotations

import contextvars
from unittest.mock import MagicMock

from eden.storage.postgres import (
    bind_request_pg_conn,
    copy_context_without_request_pg_conn,
    get_bound_request_pg_conn,
    reset_request_pg_conn,
)


def test_bind_request_pg_conn_round_trip():
    assert get_bound_request_pg_conn() is None
    fake = MagicMock(name="pg_conn")
    token = bind_request_pg_conn(fake)
    try:
        assert get_bound_request_pg_conn() is fake
    finally:
        reset_request_pg_conn(token)
    assert get_bound_request_pg_conn() is None


# ─── copy_context_without_request_pg_conn (cross-tenant leak fix) ──────────
class TestCopyContextWithoutRequestPgConn:
    """Regression coverage for the detached-task connection leak.

    ``asyncio.Task``/``loop.create_task`` copy the calling
    ``contextvars.Context`` at creation time. A background task
    spawned from inside an HTTP request handler (e.g. a
    fire-and-forget webhook delivery) would otherwise inherit
    whatever connection ``RLSOrgContextMiddleware`` pinned via
    ``bind_request_pg_conn`` for that request -- and
    ``PostgresClient.acquire`` checks that contextvar FIRST, so the
    detached task could silently reuse a connection the pool has,
    by then, handed to a different, concurrently-tenanted request.
    """

    def test_returned_context_has_var_reset_to_default(self) -> None:
        fake_conn = MagicMock(name="pinned_pg_conn")
        token = bind_request_pg_conn(fake_conn)
        try:
            # Sanity: the ambient context really is bound.
            assert get_bound_request_pg_conn() is fake_conn

            stripped_ctx = copy_context_without_request_pg_conn()

            # Inside the stripped context, the var reads back to
            # its default (None) -- exactly as if no middleware had
            # ever bound a connection for this task.
            assert stripped_ctx.run(get_bound_request_pg_conn) is None
        finally:
            reset_request_pg_conn(token)

    def test_does_not_mutate_the_caller_context(self) -> None:
        """Stripping must be scoped to the copy, not the ambient
        context the caller keeps using (e.g. the HTTP request that
        is still in flight and about to await more RLS-scoped
        queries on its own pinned connection)."""
        fake_conn = MagicMock(name="pinned_pg_conn")
        token = bind_request_pg_conn(fake_conn)
        try:
            copy_context_without_request_pg_conn()
            # The CALLER's own (ambient) context is untouched.
            assert get_bound_request_pg_conn() is fake_conn
        finally:
            reset_request_pg_conn(token)

    def test_noop_when_nothing_bound(self) -> None:
        assert get_bound_request_pg_conn() is None
        stripped_ctx = copy_context_without_request_pg_conn()
        assert stripped_ctx.run(get_bound_request_pg_conn) is None

    def test_a_task_created_via_the_stripped_context_does_not_see_binding(
        self,
    ) -> None:
        """End-to-end contextvars behavior: schedule a plain callable
        through ``Context.run`` (stand-in for how ``loop.create_task``
        would use the ``context=`` kwarg) and confirm it reads the
        var as unset, proving the mechanism ``_schedule_delivery``
        relies on actually works."""
        fake_conn = MagicMock(name="pinned_pg_conn")
        token = bind_request_pg_conn(fake_conn)
        try:
            stripped_ctx = copy_context_without_request_pg_conn()
            observed: list[object] = []
            stripped_ctx.run(
                lambda: observed.append(get_bound_request_pg_conn())
            )
            assert observed == [None]
        finally:
            reset_request_pg_conn(token)
