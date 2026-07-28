"""Regression tests — 2026-07-27 deep-audit follow-up on
``RLSOrgContextMiddleware`` (HIGH #1, MEDIUM #2, LOW-MEDIUM #3) and
cross-middleware org id resolution consistency (MEDIUM #4).

1. HIGH — the pinned pool connection + open transaction must be
   released/committed BEFORE a streaming response's body starts
   sending chunks, not held for the entire response lifetime.
2. MEDIUM — cleanup (commit/release) must survive the enclosing task
   being cancelled (client disconnect) mid-cleanup.
3. LOW-MEDIUM — if ``tx.__aenter__`` (BEGIN) itself raises, the
   middleware must not call ``tx.__aexit__`` on it, and must close
   the connection explicitly rather than trusting the ordinary
   pool-release path.
4. MEDIUM — ``QuotaEnforcementMiddleware`` and
   ``TenantRateLimitMiddleware`` must translate a resolved org id
   through ``resolve_eden_org_id`` (same as
   ``RLSOrgContextMiddleware``) so all three middlewares key their
   per-org state by the same canonical tenant id.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from starlette.requests import Request

from eden.api.utils.auth import create_access_token


# ─────────────────────────────────────────────────────────────────────────────
# Shared fakes — a minimal asyncpg-shaped pool/connection/transaction so we
# can drive RLSOrgContextMiddleware's acquisition/cleanup logic precisely,
# without needing a real Postgres pool.
# ─────────────────────────────────────────────────────────────────────────────


class _FakeTx:
    def __init__(self, fail_enter: bool = False, fail_exit: bool = False) -> None:
        self.fail_enter = fail_enter
        self.fail_exit = fail_exit
        self.enter_called = False
        self.aexit_called = False
        self.exited_with: tuple | None = None

    async def __aenter__(self):
        self.enter_called = True
        if self.fail_enter:
            raise RuntimeError("BEGIN failed (simulated connection-level failure)")
        return self

    async def __aexit__(self, *exc):
        self.aexit_called = True
        self.exited_with = exc
        if self.fail_exit:
            raise RuntimeError("COMMIT failed (simulated)")
        return False


class _FakeConn:
    def __init__(self, tx: _FakeTx) -> None:
        self._tx = tx
        self.executed: list[tuple] = []
        self.closed = False

    def transaction(self):
        return self._tx

    async def execute(self, sql, *args):
        self.executed.append((sql, args))


class _FakeConnCtx:
    def __init__(self, conn: _FakeConn) -> None:
        self.conn = conn
        self.entered = False
        self.exited = False

    async def __aenter__(self):
        self.entered = True
        return self.conn

    async def __aexit__(self, *exc):
        self.exited = True
        return False


class _FakePool:
    def __init__(self, conn_ctx: _FakeConnCtx) -> None:
        self._conn_ctx = conn_ctx

    def acquire(self):
        return self._conn_ctx


class _FakeClient:
    def __init__(self, pool: _FakePool | None) -> None:
        self._pool = pool

    async def initialize(self) -> None:  # pragma: no cover - not exercised
        pass


def _http_scope(org_id: str = "org-1", path: str = "/orgs/org-1/agents") -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "method": "GET",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [],
        "path_params": {"org_id": org_id},
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "scheme": "http",
        "http_version": "1.1",
    }


async def _receive():
    return {"type": "http.request", "body": b"", "more_body": False}


# ─────────────────────────────────────────────────────────────────────────────
# Fix #1 (HIGH) — release before a streaming body's chunks are sent.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_connection_released_before_streaming_body_chunks():
    """The pinned connection must be committed/released the moment
    ``http.response.start`` goes out — strictly BEFORE any
    ``http.response.body`` chunk, even for a long-lived SSE-style
    response that sends many chunks over time.
    """
    from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

    tx = _FakeTx()
    conn = _FakeConn(tx)
    conn_ctx = _FakeConnCtx(conn)
    pool = _FakePool(conn_ctx)
    fake_client = _FakeClient(pool)

    observed_at_first_chunk: dict[str, bool] = {}

    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        # By the time control returns here, RLSOrgContextMiddleware's
        # send-wrapper must already have finalized (committed + released)
        # the pinned connection -- i.e. BEFORE this first body chunk.
        observed_at_first_chunk["tx_committed"] = tx.aexit_called
        observed_at_first_chunk["conn_released"] = conn_ctx.exited
        # Simulate a few more SSE chunks -- a long-lived stream.
        for _ in range(3):
            await send(
                {"type": "http.response.body", "body": b"data: x\n\n", "more_body": True}
            )
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    mw = RLSOrgContextMiddleware(inner)

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ),
        patch(
            "eden.api.deps.resolve_eden_org_id",
            new=AsyncMock(return_value="org-1"),
        ),
    ):
        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        await mw(_http_scope(), _receive, send)

    assert observed_at_first_chunk == {"tx_committed": True, "conn_released": True}, (
        "REGRESSION: RLSOrgContextMiddleware held the pinned connection "
        "open past the first streamed body chunk instead of releasing "
        f"it before the stream body started sending: {observed_at_first_chunk}"
    )
    # Sanity: cleanup really happened (not a no-op / skipped path).
    assert tx.exited_with == (None, None, None)
    assert conn_ctx.exited is True


@pytest.mark.asyncio
async def test_finalize_pg_context_is_idempotent_across_wrapper_and_finally():
    """The early release (send-wrapper) and the ``finally`` fallback
    in ``__call__`` must not double-release the same connection."""
    from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

    tx = _FakeTx()
    conn = _FakeConn(tx)
    conn_ctx = _FakeConnCtx(conn)
    pool = _FakePool(conn_ctx)
    fake_client = _FakeClient(pool)

    aexit_call_count = {"n": 0}
    orig_aexit = tx.__aexit__

    async def counting_aexit(*exc):
        aexit_call_count["n"] += 1
        return await orig_aexit(*exc)

    tx.__aexit__ = counting_aexit

    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    mw = RLSOrgContextMiddleware(inner)

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ),
        patch(
            "eden.api.deps.resolve_eden_org_id",
            new=AsyncMock(return_value="org-1"),
        ),
    ):
        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        await mw(_http_scope(), _receive, send)

    assert aexit_call_count["n"] == 1, (
        "REGRESSION: tx.__aexit__ (commit) was called more than once -- "
        "the early release and the finally-fallback both fired instead "
        f"of the second being a no-op, count={aexit_call_count['n']}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Fix #2 (MEDIUM) — cleanup survives cancellation of the awaiting task.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_finalize_pg_context_completes_despite_cancellation():
    """If the task awaiting ``_finalize_pg_context`` is cancelled while
    a cleanup step is in flight, the commit/release sequence must still
    run to completion (shielded), not abort mid-transaction."""
    from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

    tx = _FakeTx()
    conn = _FakeConn(tx)
    conn_ctx = _FakeConnCtx(conn)

    # Slow down the commit so we can cancel while it's in flight.
    orig_aexit = tx.__aexit__

    async def slow_aexit(*exc):
        await asyncio.sleep(0.05)
        return await orig_aexit(*exc)

    tx.__aexit__ = slow_aexit

    request = Request(_http_scope(), _receive)
    request.state.pg_conn = conn
    request.state._pg_tx = tx
    request.state._pg_tx_entered = True
    request.state._pg_conn_ctx = conn_ctx
    request.state._pg_bind_token = None

    task = asyncio.create_task(
        RLSOrgContextMiddleware._finalize_pg_context(request)
    )
    # Let it get into the slow commit, then cancel the awaiting task.
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # Give the shielded background cleanup time to actually finish --
    # it must NOT have been aborted by the cancellation above.
    await asyncio.sleep(0.1)

    assert tx.aexit_called is True, (
        "REGRESSION: cancellation during the cleanup await aborted the "
        "commit instead of letting the shielded cleanup finish."
    )
    assert conn_ctx.exited is True, (
        "REGRESSION: the connection was never released back to the "
        "pool after a cancellation mid-cleanup."
    )


@pytest.mark.asyncio
async def test_bound_request_pg_conn_contextvar_cleared_after_finalize():
    """REGRESSION (2026-07-27): ``_finalize_pg_context`` must actually
    reset the ``_request_pg_conn`` contextvar on the request's own
    task/Context, not just log a swallowed exception and leave it
    bound.

    Uses the REAL ``bind_request_pg_conn`` / ``reset_request_pg_conn``
    / ``get_bound_request_pg_conn`` from ``eden.storage.postgres``
    (unmocked) so this exercises the actual ``contextvars.Token``
    semantics: previously, ``reset_request_pg_conn(token)`` was called
    from inside ``asyncio.shield(_do_cleanup())``, which runs the
    coroutine in a NEW ``asyncio.Task`` over a COPY of the current
    Context -- so the token (created in the request's own Context)
    was invalid there. ``_request_pg_conn.reset(token)`` raised
    ``ValueError: <Token ...> was created in a different Context``,
    caught by a bare ``except Exception`` and logged only at
    ``logger.debug`` -- so the contextvar was silently NEVER reset on
    the request's own task, and ``get_bound_request_pg_conn()`` kept
    returning the released (and potentially already
    recycled-to-a-different-tenant) connection to any code that ran
    later in the same task tree.

    The critical assertion here is on ``get_bound_request_pg_conn()``
    itself, called from the SAME task/Context as the request handling
    -- not merely "no exception was logged" and not merely that
    ``request.state.pg_conn`` (a plain attribute, unaffected by this
    bug class) was cleared.
    """
    from eden.storage.postgres import get_bound_request_pg_conn
    from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

    tx = _FakeTx()
    conn = _FakeConn(tx)
    conn_ctx = _FakeConnCtx(conn)
    pool = _FakePool(conn_ctx)
    fake_client = _FakeClient(pool)

    observed: dict[str, Any] = {}

    async def inner(scope, receive, send):
        # Sanity: the contextvar IS bound to our fake connection while
        # the request is in flight, in this same task.
        observed["bound_during_request"] = get_bound_request_pg_conn()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    mw = RLSOrgContextMiddleware(inner)

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ),
        patch(
            "eden.api.deps.resolve_eden_org_id",
            new=AsyncMock(return_value="org-1"),
        ),
    ):
        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        # No task-switch here: __call__ runs in the SAME task as this
        # test coroutine, exactly like the request's own task in
        # production (asyncio.shield only spawns a task internally
        # for the tx/conn cleanup -- it must not affect which Context
        # the token reset itself observes).
        await mw(_http_scope(), _receive, send)

    assert observed["bound_during_request"] is conn, (
        "Sanity check failed: the fake connection was never bound via "
        "bind_request_pg_conn during request handling."
    )

    after = get_bound_request_pg_conn()
    assert after is None, (
        "REGRESSION: get_bound_request_pg_conn() still returns a "
        f"connection ({after!r}) after _finalize_pg_context completed, "
        "on the request's own task/Context. reset_request_pg_conn(token) "
        "must run unshielded, in the same Context the token was created "
        "in -- not inside asyncio.shield(...), which runs in a copied "
        "Context where the token is invalid and the reset silently "
        "fails (ValueError swallowed at logger.debug)."
    )

    # Cleanup for other tests still really happened too.
    assert tx.aexit_called is True
    assert conn_ctx.exited is True


@pytest.mark.asyncio
async def test_bound_request_pg_conn_cleared_even_when_finalize_runs_via_finally_fallback():
    """Same assertion as above, but via the ``finally`` fallback path
    in ``__call__`` (downstream app raises before sending any ASGI
    message) rather than the send-wrapper early-release path."""
    from eden.storage.postgres import get_bound_request_pg_conn
    from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

    tx = _FakeTx()
    conn = _FakeConn(tx)
    conn_ctx = _FakeConnCtx(conn)
    pool = _FakePool(conn_ctx)
    fake_client = _FakeClient(pool)

    async def inner(scope, receive, send):
        raise RuntimeError("downstream blew up before any ASGI message")

    mw = RLSOrgContextMiddleware(inner)

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ),
        patch(
            "eden.api.deps.resolve_eden_org_id",
            new=AsyncMock(return_value="org-1"),
        ),
    ):
        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        with pytest.raises(RuntimeError):
            await mw(_http_scope(), _receive, send)

    after = get_bound_request_pg_conn()
    assert after is None, (
        "REGRESSION: get_bound_request_pg_conn() still returns a "
        f"connection ({after!r}) after the finally-fallback ran "
        "_finalize_pg_context, on the request's own task/Context."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Fix #3 (LOW-MEDIUM) — BEGIN failure: no phantom tx.__aexit__, explicit close.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_begin_failure_closes_connection_without_touching_tx_aexit():
    """If ``tx.__aenter__`` (BEGIN) raises, the middleware must not call
    ``tx.__aexit__`` on the never-started transaction, and must close
    the connection explicitly instead of routing it through the
    ordinary (health-check-free) pool-release path."""
    from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

    tx = _FakeTx(fail_enter=True)
    conn = _FakeConn(tx)

    async def _close():
        conn.closed = True

    conn.close = _close  # type: ignore[attr-defined]
    conn_ctx = _FakeConnCtx(conn)
    pool = _FakePool(conn_ctx)
    fake_client = _FakeClient(pool)

    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    mw = RLSOrgContextMiddleware(inner)

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ),
        patch(
            "eden.api.deps.resolve_eden_org_id",
            new=AsyncMock(return_value="org-1"),
        ),
    ):
        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        # Must not raise -- BEGIN failure is fail-soft (RLS just stays
        # unset for this request).
        await mw(_http_scope(), _receive, send)

    assert tx.enter_called is True
    assert tx.aexit_called is False, (
        "REGRESSION: tx.__aexit__ was called on a transaction whose "
        "BEGIN (__aenter__) itself raised -- should never be touched."
    )
    assert conn.closed is True, (
        "REGRESSION: a connection whose BEGIN failed must be closed "
        "explicitly rather than handed back through the ordinary "
        "pool-release path with no health check."
    )
    # The response must still complete normally (fail-soft).
    starts = [m for m in sent if m["type"] == "http.response.start"]
    assert starts and starts[0]["status"] == 200


@pytest.mark.asyncio
async def test_begin_success_then_commit_failure_still_closes_connection():
    """Symmetric case: BEGIN succeeds but the commit (tx.__aexit__)
    itself fails -- also treated as a suspect connection and closed
    explicitly rather than silently handed back to the pool."""
    from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

    tx = _FakeTx(fail_exit=True)
    conn = _FakeConn(tx)

    async def _close():
        conn.closed = True

    conn.close = _close  # type: ignore[attr-defined]
    conn_ctx = _FakeConnCtx(conn)
    pool = _FakePool(conn_ctx)
    fake_client = _FakeClient(pool)

    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    mw = RLSOrgContextMiddleware(inner)

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ),
        patch(
            "eden.api.deps.resolve_eden_org_id",
            new=AsyncMock(return_value="org-1"),
        ),
    ):
        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        await mw(_http_scope(), _receive, send)

    assert tx.aexit_called is True
    assert conn.closed is True, (
        "REGRESSION: a commit failure must be treated as a suspect "
        "connection and closed explicitly."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Fix #4 (MEDIUM) — quota / rate-limit org id resolution matches RLS's.
# ─────────────────────────────────────────────────────────────────────────────


def _clerk_bearer_scope(path: str = "/v1/traces") -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"authorization", b"Bearer clerk.jwt.token")],
        "client": ("127.0.0.1", 123),
        "server": ("test", 80),
    }


class TestQuotaEnforcementOrgIdTranslation:
    @pytest.mark.asyncio
    async def test_clerk_bearer_org_id_is_translated_to_eden_uuid(self):
        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware

        request = Request(_clerk_bearer_scope())

        with (
            patch(
                "eden.api.utils.clerk_auth.verify_clerk_token",
                new_callable=AsyncMock,
                return_value={"sub": "user_1", "o": {"id": "org_clerk_1"}},
            ),
            patch(
                "eden.api.utils.clerk_auth.extract_org_id",
                return_value="org_clerk_1",
            ),
            patch(
                "eden.api.deps.resolve_eden_org_id",
                new=AsyncMock(return_value="eden-uuid-999"),
            ),
        ):
            org_id = await QuotaEnforcementMiddleware._resolve_org_id(request)

        assert org_id == "eden-uuid-999", (
            "REGRESSION: QuotaEnforcementMiddleware must translate a "
            "Clerk org id through resolve_eden_org_id (same as "
            f"RLSOrgContextMiddleware) -- got {org_id!r}"
        )

    @pytest.mark.asyncio
    async def test_cookie_org_id_is_translated_to_eden_uuid(self):
        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware

        token = create_access_token(
            data={
                "sub": "user-1",
                "email": "u@example.com",
                "current_org_id": "org_clerk_cookie",
            },
            token_version=1,
        )
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "path": "/v1/traces",
            "raw_path": b"/v1/traces",
            "query_string": b"",
            "headers": [(b"cookie", f"authorization={token}".encode())],
            "client": ("127.0.0.1", 123),
            "server": ("test", 80),
        }
        request = Request(scope)

        with patch(
            "eden.api.deps.resolve_eden_org_id",
            new=AsyncMock(return_value="eden-uuid-cookie"),
        ):
            org_id = await QuotaEnforcementMiddleware._resolve_org_id(request)

        assert org_id == "eden-uuid-cookie"

    @pytest.mark.asyncio
    async def test_resolution_failure_falls_back_to_raw_id(self):
        """A DB blip during translation must not turn into a lost org
        id -- fall back to the raw (pre-translation) value."""
        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware

        with (
            patch(
                "eden.api.utils.clerk_auth.verify_clerk_token",
                new_callable=AsyncMock,
                return_value={"sub": "user_1", "o": {"id": "org_clerk_1"}},
            ),
            patch(
                "eden.api.utils.clerk_auth.extract_org_id",
                return_value="org_clerk_1",
            ),
            patch(
                "eden.api.deps.resolve_eden_org_id",
                new=AsyncMock(return_value=None),
            ),
        ):
            org_id = await QuotaEnforcementMiddleware._resolve_org_id(
                Request(_clerk_bearer_scope())
            )

        assert org_id == "org_clerk_1"


class TestTenantRateLimitOrgIdTranslation:
    @pytest.mark.asyncio
    async def test_clerk_bearer_org_id_is_translated_to_eden_uuid(self):
        from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

        mw = TenantRateLimitMiddleware(app=AsyncMock())
        request = Request(_clerk_bearer_scope())

        with (
            patch(
                "eden.api.utils.clerk_auth.verify_clerk_token",
                new_callable=AsyncMock,
                return_value={"sub": "user_1", "o": {"id": "org_clerk_1"}},
            ),
            patch(
                "eden.api.utils.clerk_auth.extract_org_id",
                return_value="org_clerk_1",
            ),
            patch(
                "eden.api.deps.resolve_eden_org_id",
                new=AsyncMock(return_value="eden-uuid-999"),
            ),
        ):
            org_id, key_id = await mw._resolve_org_and_api_key(request)

        assert org_id == "eden-uuid-999", (
            "REGRESSION: TenantRateLimitMiddleware must translate a "
            "Clerk org id through resolve_eden_org_id (same as "
            f"RLSOrgContextMiddleware) -- got {org_id!r}"
        )
        assert key_id is None

    @pytest.mark.asyncio
    async def test_api_key_org_id_is_translated_and_cached_translated(self):
        from eden.api.middleware.tenant_rate_limit import (
            TenantRateLimitMiddleware,
            _api_key_resolve_cache,
        )

        mw = TenantRateLimitMiddleware(app=AsyncMock())
        _api_key_resolve_cache.clear()
        try:
            fake_client = MagicMock()
            fake_client.fetchrow = AsyncMock(
                return_value={"id": "key-uuid-1", "org_id": "org_clerk_api"}
            )

            scope = {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/v1/jobs",
                "raw_path": b"/v1/jobs",
                "query_string": b"",
                "headers": [
                    (b"x-org-api-key", b"sk_test_secret"),
                    (b"x-org-id", b"org_clerk_api"),
                ],
                "client": ("127.0.0.1", 1),
                "server": ("test", 80),
            }
            request = Request(scope)

            with (
                patch(
                    "eden.api.middleware.tenant_rate_limit.get_postgres_client",
                    new=AsyncMock(return_value=fake_client),
                ),
                patch(
                    "eden.api.deps.resolve_eden_org_id",
                    new=AsyncMock(return_value="eden-uuid-api"),
                ),
            ):
                org_id, key_id = await mw._resolve_org_and_api_key(request)

            assert org_id == "eden-uuid-api"
            assert key_id == "key-uuid-1"

            # The cache stores the TRANSLATED id, so a subsequent cache
            # hit (no DB round-trip) still returns the canonical id.
            cached = _api_key_resolve_cache.get(
                f"{__import__('hashlib').sha256(b'sk_test_secret').hexdigest()}:org_clerk_api"
            )
            assert cached is not None
            assert cached[0] == "eden-uuid-api"
        finally:
            _api_key_resolve_cache.clear()
            await mw.shutdown()

    @pytest.mark.asyncio
    async def test_resolution_failure_falls_back_to_raw_id(self):
        from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

        mw = TenantRateLimitMiddleware(app=AsyncMock())

        with (
            patch(
                "eden.api.utils.clerk_auth.verify_clerk_token",
                new_callable=AsyncMock,
                return_value={"sub": "user_1", "o": {"id": "org_clerk_1"}},
            ),
            patch(
                "eden.api.utils.clerk_auth.extract_org_id",
                return_value="org_clerk_1",
            ),
            patch(
                "eden.api.deps.resolve_eden_org_id",
                new=AsyncMock(return_value=None),
            ),
        ):
            org_id, key_id = await mw._resolve_org_and_api_key(
                Request(_clerk_bearer_scope())
            )

        assert org_id == "org_clerk_1"
        assert key_id is None
