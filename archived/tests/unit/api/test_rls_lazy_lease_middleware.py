"""``RLSOrgContextMiddleware`` under lazy acquisition.

The lifecycle assertions for a request that *does* pin a connection live in
``test_rls_streaming_and_org_resolution_jul27.py``. This file covers the two
things that only exist because acquisition became lazy:

* a request whose handler never touches Postgres must never check a connection
  out -- the entire point of the change; and
* the finalizer must **close** the lease, not merely stop looking at it. It
  runs at ``http.response.start``, so a task sharing the request's context can
  reach ``PostgresClient.acquire`` afterwards. Redeeming then would check out a
  pooled connection inside an open transaction that the already-completed
  finalizer will never give back: one leaked slot per occurrence, out of
  twenty.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

ORG = "11111111-1111-1111-1111-111111111111"


class _FakeTx:
    def __init__(self) -> None:
        self.entered = False
        self.exited = False

    async def __aenter__(self) -> _FakeTx:
        self.entered = True
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self.exited = True


class _FakeConn:
    def __init__(self) -> None:
        self.statements: list[str] = []
        self.closed = False
        self.tx = _FakeTx()

    def transaction(self) -> _FakeTx:
        return self.tx

    async def execute(self, query: str, *args: Any) -> str:
        self.statements.append(query)
        return "SET"

    async def close(self) -> None:
        self.closed = True


class _FakeConnCtx:
    def __init__(self, conn: _FakeConn) -> None:
        self.connection = conn
        self.exited = 0

    async def __aenter__(self) -> _FakeConn:
        return self.connection

    async def __aexit__(self, *exc: Any) -> None:
        self.exited += 1


class _FakePool:
    def __init__(self, conn: _FakeConn) -> None:
        self.conn = conn
        self.acquires = 0
        self.contexts: list[_FakeConnCtx] = []

    def acquire(self) -> _FakeConnCtx:
        self.acquires += 1
        ctx = _FakeConnCtx(self.conn)
        self.contexts.append(ctx)
        return ctx


class _FakeClient:
    def __init__(self, pool: _FakePool) -> None:
        self._pool = pool

    async def initialize(self) -> None:  # pragma: no cover - pool present
        raise AssertionError("initialize() called with a pool already present")


def _scope() -> dict[str, Any]:
    """A request shaped like real ingest traffic.

    Authenticates with ``X-Org-Api-Key`` + ``X-Org-Id``, which is how the SDKs
    do it and the only way ``_resolve_org_id`` will produce an org for a
    ``/orgs/{org_id}/...`` route. It deliberately does NOT put ``path_params``
    in the scope: Starlette's router populates that downstream of middleware,
    so a scope carrying it would let these tests pass through a branch that no
    real request can take (which is what they used to do).
    """
    return {
        "type": "http",
        "method": "GET",
        "path": f"/orgs/{ORG}/agents",
        "raw_path": f"/orgs/{ORG}/agents".encode(),
        "headers": [
            (b"x-org-api-key", b"sk-test-key"),
            (b"x-org-id", ORG.encode()),
        ],
        "query_string": b"",
        "state": {},
    }


async def _receive() -> dict[str, Any]:
    return {"type": "http.request", "body": b"", "more_body": False}


@pytest.fixture
def pool() -> _FakePool:
    return _FakePool(_FakeConn())


@pytest.fixture
def patched(pool: _FakePool):
    client = _FakeClient(pool)
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ),
        patch(
            "eden.api.deps.resolve_eden_org_id",
            new=AsyncMock(return_value=ORG),
        ),
        # The API key must actually verify: ``_has_verified_identity`` does a
        # real hash lookup, and without a verified identity the middleware
        # refuses to trust ``X-Org-Id`` and resolves no org at all.
        patch(
            "eden.api.deps.get_current_org_api_key",
            new=AsyncMock(return_value={"org_id": ORG}),
        ),
    ):
        yield client


@pytest.mark.asyncio
async def test_path_params_are_not_available_to_middleware() -> None:
    """Pin the platform fact that removed ``_resolve_org_id``'s first branch.

    That branch read ``request.path_params["org_id"]`` and was documented as
    "the router has already matched the URL by the time middleware sees it".
    Starlette's ``Router`` populates ``scope["path_params"]`` while matching,
    which happens *downstream* of every middleware -- so the branch never fired
    for any request. Asserted against a real FastAPI app rather than
    hand-built scopes, so a Starlette change that makes it available shows up
    here instead of silently re-enabling dead code.
    """
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    seen: dict[str, Any] = {}

    class _Probe:
        def __init__(self, app: Any) -> None:
            self.app = app

        async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
            if scope["type"] == "http":
                seen["in_scope"] = "path_params" in scope
                from fastapi import Request as _Req

                seen["in_middleware"] = dict(_Req(scope, receive).path_params)
            await self.app(scope, receive, send)

    app = FastAPI()

    @app.get("/orgs/{org_id}/probe")
    async def _probe(org_id: str) -> dict[str, str]:
        return {"org_id": org_id}

    app.add_middleware(_Probe)
    with TestClient(app) as client:
        assert client.get(f"/orgs/{ORG}/probe").json() == {"org_id": ORG}

    assert seen["in_scope"] is False, (
        "scope now carries path_params inside middleware; _resolve_org_id's "
        "removed path branch may be revivable -- but see the note there on why "
        "it should not be"
    )
    assert seen["in_middleware"] == {}


@pytest.mark.asyncio
async def test_a_handler_that_never_queries_checks_out_nothing(
    patched: _FakeClient, pool: _FakePool
) -> None:
    """The optimisation itself, asserted through the real middleware.

    Previously this request paid a pool checkout, ``BEGIN``, ``set_config``
    and ``COMMIT`` -- measured at 221.5 us over a unix socket -- and held a
    pool slot from middleware entry to response start, for nothing.
    """
    sent: list[dict] = []

    async def app(scope, receive, send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    async def send(message: dict) -> None:
        sent.append(message)

    await RLSOrgContextMiddleware(app)(_scope(), _receive, send)

    assert pool.acquires == 0, (
        f"{pool.acquires} pool checkout(s) for a request that never queried"
    )
    assert pool.conn.statements == [], "set_config issued with no query to scope"
    assert [m["type"] for m in sent] == [
        "http.response.start",
        "http.response.body",
    ]


@pytest.mark.asyncio
async def test_the_lease_is_still_bound_and_usable_during_the_request(
    patched: _FakeClient, pool: _FakePool
) -> None:
    """Lazy must not mean absent: a handler that queries still gets pinned."""
    observed: dict[str, Any] = {}

    async def app(scope, receive, send) -> None:
        from eden.storage.postgres import (
            get_bound_request_pg_conn,
            get_bound_request_pg_lease,
        )

        lease = get_bound_request_pg_lease()
        observed["lease_bound"] = lease is not None
        observed["conn_before"] = get_bound_request_pg_conn()
        if lease is not None:
            await lease.ensure()
        observed["conn_after"] = get_bound_request_pg_conn()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    await RLSOrgContextMiddleware(app)(_scope(), _receive, lambda m: _noop())

    assert observed["lease_bound"] is True
    assert observed["conn_before"] is None, "pinned before any query was issued"
    assert observed["conn_after"] is pool.conn
    assert pool.acquires == 1
    assert any("app.current_org_id" in s for s in pool.conn.statements), (
        "the GUC was never set on the redeemed connection"
    )
    # Released by the finalizer, exactly once.
    assert pool.contexts[0].exited == 1
    assert pool.conn.tx.exited is True


async def _noop() -> None:
    return None


@pytest.mark.asyncio
async def test_the_finalizer_closes_the_lease_against_a_late_redemption(
    patched: _FakeClient, pool: _FakePool
) -> None:
    """A task that outlives the response must not be able to redeem.

    This is the window lazy acquisition opens and eager acquisition did not.
    Without ``lease.close()`` in the finalizer, this late ``ensure()`` succeeds
    and checks out a connection, inside an open transaction, that nothing will
    ever release -- and it is invisible: no error, no log, just a pool one slot
    smaller for the rest of the process's life.
    """
    captured: dict[str, Any] = {}

    async def app(scope, receive, send) -> None:
        from eden.storage.postgres import get_bound_request_pg_lease

        captured["lease"] = get_bound_request_pg_lease()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    await RLSOrgContextMiddleware(app)(_scope(), _receive, lambda m: _noop())

    lease = captured["lease"]
    assert lease is not None

    # The request has finalized. A detached task holding this reference now
    # tries its first query.
    late = await lease.ensure()

    assert late is None, (
        "the lease was redeemed after the request finalized; that connection "
        "is checked out inside an open transaction with nothing left to "
        "release it"
    )
    assert pool.acquires == 0, (
        f"{pool.acquires} connection(s) leaked by a post-finalize redemption"
    )
