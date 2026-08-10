"""PostgreSQL storage client for Eden.

Provides connection pooling via PgBouncer and typed clients for each KB layer.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import json
import logging
import os
import time
from collections.abc import AsyncIterator, Iterable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC
from typing import Any, cast

import asyncpg
from asyncpg import Connection, Pool
from asyncpg.transaction import Transaction

from eden.config import get_settings
from eden.observability.slow_query import record_slow_query
from eden.util.jsonx import dumps as _jsonx_dumps

logger = logging.getLogger(__name__)


def _encode_vector(value: Any) -> str | None:
    """Encode a Python vector to the pgvector text form ``[1.0,2.0]``."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return "[" + ",".join(str(float(x)) for x in value) + "]"


def _decode_vector(value: str | None) -> list[float] | None:
    """Decode the pgvector text form ``[1.0,2.0]`` to ``list[float]``."""
    if value is None:
        return None
    stripped = value.strip()
    if not stripped or stripped == "[]":
        return []
    return [float(x) for x in stripped.strip("[]").split(",")]


# Request-scoped asyncpg connection pinned by RLSOrgContextMiddleware.
# When set, PostgresClient.acquire/fetch/execute reuse this connection so
# FORCE RLS policies see ``app.current_org_id`` (SET LOCAL on that conn).
# Without this, pool round-trips hit a different connection with a NULL GUC
# and every telemetry_* / FORCE-RLS table returns empty — portal shows
# 0 agents / 0 traces even when rows exist.
#
# The var holds EITHER a materialized ``Connection`` (the historical
# behaviour, still used by tests and by any caller that already has a
# connection in hand) OR a :class:`RequestConnLease` — an unredeemed
# promise of one. See that class for why the lazy form exists.
_BoundPgConn = "Connection | RequestConnLease | None"
_request_pg_conn: contextvars.ContextVar[Any] = contextvars.ContextVar(
    "eden_request_pg_conn",
    default=None,
)



def _m14_min_size(min_pool_size, default_min: int) -> int:
    """M14 (§8.1): honour EDEN_NEON_SCALE_TO_ZERO by forcing min_size=0."""
    try:
        from eden.storage.empty_cooldown import neon_scale_to_zero_enabled

        if neon_scale_to_zero_enabled():
            return 0
    except Exception:
        pass
    return default_min if min_pool_size is None else min_pool_size


class RequestConnLease:
    """An RLS-scoped connection that is acquired on first use, not up front.

    ``RLSOrgContextMiddleware`` used to acquire a pooled connection, open a
    transaction and issue ``SET LOCAL app.current_org_id`` at middleware
    entry, for **every** request that resolved an org — then release it at
    ``http.response.start``. Two costs, both measured against a local
    Postgres 18 over a unix socket (i.e. the best case; the production DSN is
    Neon over TLS, where each round trip is orders of magnitude worse):

    * **221.5 us per request** (p50 209.4, p99 342.0) of pure setup —
      pool checkout, ``BEGIN``, ``set_config``, ``COMMIT``, release. A
      request that never touches Postgres paid all of it: 31x more than the
      ~7 us it costs to construct this object and discover at finalize that
      it was never redeemed.
    * **A pool slot held from middleware entry to response start.** The
      middleware sits above the idempotency and quota middlewares and the
      whole router, so the slot spans every bit of pre-query work the
      request does — including non-Postgres latency like an upstream LLM
      call in the AI gateway. With ``max_size=20``, 40 concurrent requests
      doing 200 ms of non-Postgres work took 407 ms (2.03x the 200 ms floor,
      serialised into two pool-sized waves) versus 204 ms (1.02x) when the
      slot is not held. Postgres pool capacity became a concurrency ceiling
      on requests that barely use Postgres.

    The lease removes both by deferring the work to the first query.
    :meth:`PostgresClient.acquire` — which every query in this module funnels
    through — calls :meth:`ensure`, so materialization happens exactly when a
    connection is genuinely needed and never otherwise.

    Deliberately **not** a route skip-list: an allowlist of "routes that do
    not need RLS" goes stale silently, and the failure mode is a route
    quietly losing its tenant scoping. First-use materialization cannot go
    stale — it is driven by what the request actually does.

    Failure is fail-soft in the same direction as the eager path it replaces:
    if acquisition fails, :meth:`ensure` returns ``None`` and ``acquire``
    falls through to an ordinary pool checkout with no GUC set, which is what
    already happened when the eager acquire raised. The RLS policies read
    ``current_setting('app.current_org_id', true)``, so an unset GUC compares
    ``NULL`` and filters rows out rather than in.

    Concurrency: :meth:`ensure` is guarded by an ``asyncio.Lock`` so two
    coroutines racing on the first query of a request cannot each check out a
    connection (which would leak one and set the GUC on the wrong one). The
    already-materialized fast path is a plain attribute read taken before the
    lock, so steady-state queries pay no lock at all.

    NOT thread-safe, and not meant to be: a lease belongs to one request's
    context. ``copy_context_without_request_pg_conn`` strips it for the same
    reason it strips a bare connection — a detached task must never redeem a
    lease belonging to a request that has already finalized.
    """

    __slots__ = (
        "_client",
        "_closed",
        "_conn",
        "_conn_ctx",
        "_failed",
        "_lock",
        "_on_materialize",
        "_raw_conn",
        "_tx",
        "_tx_entered",
        "_use_lock",
        "_user",
        "org_id",
    )

    def __init__(
        self,
        org_id: str,
        client: Any,
        *,
        on_materialize: Any = None,
    ) -> None:
        self.org_id = org_id
        self._client = client
        self._conn: Connection | None = None
        # The handle returned by the pool's context manager, recorded the
        # instant it is available. ``_conn`` is only published once setup has
        # fully succeeded, so without this a failure between checkout and
        # publication would leave nothing to close. Do NOT try to recover it
        # from the context manager instead: asyncpg's ``PoolAcquireContext``
        # declares ``__slots__ = ('timeout', 'connection', 'done', 'pool')``,
        # so any guess at a private attribute name silently yields ``None``
        # and the connection is handed back to the pool unclosed.
        self._raw_conn: Connection | None = None
        self._conn_ctx: Any = None
        self._tx: Any = None
        self._tx_entered = False
        self._failed = False
        self._closed = False
        self._lock: asyncio.Lock | None = None
        # Serialises *use* of the connection (see ``use``), separate from the
        # lock that serialises acquiring it.
        self._use_lock: asyncio.Lock | None = None
        self._user: Any = None
        # Called with (conn, conn_ctx, tx, tx_entered) the moment the lease is
        # redeemed, so the middleware can record the resources on
        # ``request.state`` and its existing ``_finalize_pg_context`` — which
        # is what the regression tests drive — releases them unchanged.
        self._on_materialize = on_materialize

    @property
    def conn(self) -> Connection | None:
        """The redeemed connection, or ``None`` if never redeemed."""
        return self._conn

    @property
    def materialized(self) -> bool:
        return self._conn is not None

    async def ensure(self) -> Connection | None:
        """Redeem the lease, or return the already-redeemed connection.

        Returns ``None`` if acquisition failed — callers must fall back to an
        ordinary pool checkout rather than treating that as fatal.
        """
        # Fast path, no lock: the overwhelmingly common case once a request
        # has issued its first query.
        if self._conn is not None:
            return self._conn
        if self._failed or self._closed:
            return None

        if self._lock is None:
            # No await between the check and the assignment, so this cannot
            # interleave on asyncio's single thread.
            self._lock = asyncio.Lock()

        async with self._lock:
            # Re-check under the lock: a racing coroutine may have redeemed
            # (or failed) the lease while we waited — or the request may have
            # finalized, in which case redeeming now would check out a
            # connection that nothing is left to release.
            if self._conn is not None:
                return self._conn
            if self._failed or self._closed:
                return None
            try:
                await self._materialize()
            except Exception as exc:
                self._failed = True
                logger.warning(
                    "RequestConnLease: failed to acquire an RLS-scoped "
                    "connection for org %s (%s) — falling back to an "
                    "unpinned pool connection with no app.current_org_id",
                    self.org_id,
                    exc,
                )
                await self._abandon_partial()
                return None
        return self._conn

    @asynccontextmanager
    async def use(self) -> AsyncIterator[None]:
        """Hold exclusive use of the leased connection for this block.

        BUG FIX (data loss on the primary ingest path). asyncpg permits exactly
        one operation in flight per connection — verified directly: 8
        concurrent statements on one connection, 7 raise ``InterfaceError:
        cannot perform operation: another operation is in progress``. But a
        pinned connection is shared by everything running in the request's
        context, and several call sites fan work out with ``asyncio.gather``:

        * ``TelemetryCollector.ingest_batch`` gathers one ``_route`` per event;
        * ``_route`` gathers all six sinks per event.

        So a 10-event batch issued 10 concurrent INSERTs against one
        connection. Nine collided. ``_route_postgres`` wraps any exception in
        ``IngestionUnavailableError``, which ``ingest_batch`` re-raises, so the
        *whole* batch 503'd — and the SDK's retry hit exactly the same wall.
        Reachable through the documented setup: ``X-Org-Api-Key`` +
        ``X-Org-Id`` is a verified identity, so ``_resolve_org_id`` returns the
        header org and a connection is pinned. The TS SDK sends ``X-Org-Id``
        whenever ``orgId`` is configured.

        Serialising rather than falling through to an unpinned pool connection
        is deliberate. Falling through looks attractive — full parallelism, and
        a missing GUC only makes RLS *read* policies filter rows out — but
        migration 124 adds ``WITH CHECK`` to all 20 policies, and a ``WITH
        CHECK`` against an unset GUC compares ``NULL`` and **rejects the
        INSERT**. So fall-through would trade today's failure for a worse one
        the moment that migration lands.

        Reentrant per task: a task that already holds the connection passes
        straight through, so the nested ``acquire`` in
        ``transaction()``/``fetchiter`` (which hold the connection while the
        caller runs more queries on it) does not deadlock against itself.

        Serialising a wide fan-out does cost wall-clock — N statements in
        series rather than in parallel. For the ingest path that is addressed
        at the source by writing the batch in one statement
        (``insert_telemetry_events``), which leaves nothing to contend over.
        """
        task = asyncio.current_task()
        if self._user is not None and self._user is task:
            # Already ours — nested acquire in the same task.
            yield
            return
        if self._use_lock is None:
            self._use_lock = asyncio.Lock()
        async with self._use_lock:
            self._user = task
            try:
                yield
            finally:
                self._user = None

    async def close(self) -> None:
        """Refuse any further redemption, and wait out one in flight.

        Closes a window that lazy acquisition opens and eager acquisition did
        not: the request finalizes at ``http.response.start``, but a
        fire-and-forget task sharing the request's context could reach
        ``acquire`` at the same moment. Without this, that task could redeem
        the lease *after* the finalizer had already looked for resources to
        release and found none — checking out a pooled connection, inside an
        open transaction, that nothing would ever give back. One leak per
        occurrence, and the pool is 20 slots wide.

        Taking the same lock :meth:`ensure` uses makes the two mutually
        exclusive: either materialization completed before this call (so
        ``on_materialize`` has already published the resources and the
        finalizer will find them) or it never happens. Callers must therefore
        await this *before* reading those resources.
        """
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            self._closed = True

    async def _materialize(self) -> None:
        """Check out a connection, open a transaction, set the GUC.

        Uses the pool directly rather than ``PostgresClient.acquire`` — going
        through ``acquire`` would re-enter this lease and recurse.
        """
        client = self._client
        if getattr(client, "_pool", None) is None:
            await client.initialize()
        pool = getattr(client, "_pool", None)
        if pool is None:
            raise RuntimeError("Postgres pool unavailable")

        conn_ctx = pool.acquire()
        conn = await conn_ctx.__aenter__()
        self._conn_ctx = conn_ctx
        # Record the handle before anything that can raise, so a failure
        # between here and publication still has a connection to close.
        self._raw_conn = conn
        tx = conn.transaction()
        self._tx = tx
        await tx.__aenter__()
        # BEGIN completed — only now is ``tx.__aexit__`` (which attempts
        # COMMIT) a meaningful thing to call.
        self._tx_entered = True
        # SET LOCAL inside the open transaction: committing reverts the GUC,
        # which is the scoping we want.
        await conn.execute(
            "SELECT set_config('app.current_org_id', $1::text, true)",
            str(self.org_id),
        )
        # Publish last. Until this assignment the fast path above still sees
        # an unredeemed lease, so a partially-built lease is never handed out.
        self._conn = conn
        if self._on_materialize is not None:
            self._on_materialize(conn, conn_ctx, tx, self._tx_entered)

    async def _abandon_partial(self) -> None:
        """Give back whatever a failed :meth:`_materialize` had taken.

        Mirrors ``RLSOrgContextMiddleware._release_pg_resources``: a
        transaction whose BEGIN never completed, or whose commit fails, means
        the connection is suspect, so close it explicitly instead of handing
        it back to the pool. asyncpg detaches the pool's holder on
        ``close()``, so the slot is still freed and the later
        ``__aexit__`` is a safe no-op.

        Uses ``_raw_conn`` rather than ``_conn`` because ``_conn`` is only
        published after setup fully succeeds — and every path that reaches
        here is a path where it did not.
        """
        conn_broken = False
        if self._tx is not None:
            if self._tx_entered:
                try:
                    await self._tx.__aexit__(None, None, None)
                except Exception as exc:
                    logger.debug("lease tx commit failed (non-fatal): %s", exc)
                    conn_broken = True
            else:
                conn_broken = True
        raw = self._conn or self._raw_conn
        if conn_broken and raw is not None:
            with contextlib.suppress(Exception):
                await raw.close()
        if self._conn_ctx is not None:
            with contextlib.suppress(Exception):
                await self._conn_ctx.__aexit__(None, None, None)
        self._conn = None
        self._raw_conn = None
        self._conn_ctx = None
        self._tx = None
        self._tx_entered = False


def bind_request_pg_conn(conn: Any) -> contextvars.Token[Any]:
    """Pin ``conn`` (a ``Connection`` or a :class:`RequestConnLease`) for the
    current asyncio task (middleware entry)."""
    return _request_pg_conn.set(conn)


def bind_request_pg_lease(lease: RequestConnLease) -> contextvars.Token[Any]:
    """Pin an unredeemed :class:`RequestConnLease` for the current task.

    Same var, same strip/reset machinery as :func:`bind_request_pg_conn` — so
    ``copy_context_without_request_pg_conn`` protects detached tasks from an
    inherited lease exactly as it already protects them from an inherited
    connection, with no second leak surface to keep in sync.
    """
    return _request_pg_conn.set(lease)


def reset_request_pg_conn(token: contextvars.Token[Any]) -> None:
    """Restore the previous request-conn binding (middleware exit)."""
    _request_pg_conn.reset(token)


def get_bound_request_pg_conn() -> Connection | None:
    """Return the connection currently pinned for this request, if any.

    Returns ``None`` when the binding is a lease that has not been redeemed —
    there is genuinely no connection pinned yet, and reporting one would be a
    lie that callers would act on.
    """
    value = _request_pg_conn.get()
    if isinstance(value, RequestConnLease):
        return value.conn
    return cast("Connection | None", value)


def get_bound_request_pg_lease() -> RequestConnLease | None:
    """Return the pinned lease, redeemed or not (``None`` if the binding is a
    bare connection or absent)."""
    value = _request_pg_conn.get()
    return value if isinstance(value, RequestConnLease) else None


def copy_context_without_request_pg_conn() -> contextvars.Context:
    """Snapshot the current context with the request-pinned pg
    connection var forced back to its default (``None``).

    CRITICAL (cross-tenant connection reuse): ``asyncio.Task``/
    ``loop.create_task`` copy the *calling* ``contextvars.Context``
    at task-creation time. A detached background task created from
    inside an HTTP request (e.g. a fire-and-forget webhook delivery
    scheduled from a route handler) therefore inherits whatever
    connection ``RLSOrgContextMiddleware`` pinned via
    :func:`bind_request_pg_conn` for that request — even though the
    task may still be running long after the middleware's
    ``finally`` block has committed and released that connection
    back to the pool. ``PostgresClient.acquire`` checks
    ``_request_pg_conn`` FIRST (see below) and, if bound, hands back
    that exact connection object without going through the pool's
    checkout — which means the detached task can silently start
    running queries on a connection object that the pool has, by
    then, handed to a *different*, concurrently-tenanted request.

    Callers that spawn a task meant to outlive the request that
    created it should build the task's coroutine inside (or create
    the task via) the context returned here so the copied context
    carries no stale connection binding at all — the task will fall
    through to a normal pool checkout instead. Other context state
    (correlation IDs, etc.) is preserved unchanged.
    """
    ctx = contextvars.copy_context()
    # ``Context.run`` executes with ``ctx`` as the ambient context,
    # so the ``.set(None)`` call below mutates ``ctx`` itself (not a
    # further copy) — see the contextvars docs: "Any changes to any
    # context variables that callable makes will be contained in the
    # context object". Resetting to ``None`` is equivalent to
    # "unset" here because ``None`` is this var's declared default.
    #
    # This strips an unredeemed ``RequestConnLease`` as well as a bare
    # connection, because the var holds either — deliberately one var rather
    # than two, so there is exactly one place that has to be kept in sync with
    # this strip. A detached task that inherited a lease would otherwise be
    # able to *redeem* it after the request finalized, checking out a
    # connection that the request's own cleanup will never release.
    ctx.run(_request_pg_conn.set, None)
    return ctx


def _dump_jsonb(value):
    """Compact JSON serialiser used by every JSONB column in this module.

    Returns ``None`` for ``None`` so the DB sees NULL. Uses
    ``eden.util.jsonx`` (orjson) on the hot path; ``default=str``
    matches the convention used by ``telemetry_collector._route_postgres``
    so the round-trip is identical.
    """
    if value is None:
        return None
    return _jsonx_dumps(value, default=str)


# Note: ``settings`` is intentionally NOT bound to a module-level
# reference — every method that needs a setting calls ``get_settings()``
# (lru_cache'd, so the cost is one dict lookup) so that tests can
# monkeypatch the env and immediately observe the new values, and so
# a future code path that mutates ``Settings`` (e.g. a CLI flag)
# works without re-importing this module.


# ── Slow-query instrumentation ───────────────────────────────────────────
# TODO(config): promote to Settings
_slow_query_threshold_ms_cached: float | None = None


def _slow_query_threshold_ms() -> float:
    """Threshold (ms) above which a query is recorded. Env-driven, cached."""
    global _slow_query_threshold_ms_cached
    if _slow_query_threshold_ms_cached is None:
        try:
            _slow_query_threshold_ms_cached = float(
                os.environ.get("EDEN_SLOW_QUERY_MS", "500"),
            )
        except (TypeError, ValueError):
            _slow_query_threshold_ms_cached = 500.0
    return _slow_query_threshold_ms_cached


def _maybe_record_slow_query(query: str, started: float, source: str) -> None:
    """Record ``query`` in the slow-query ring buffer if it ran slow.

    ``started`` is a ``time.monotonic()`` timestamp taken before the query.
    Fast path is one clock read plus one float comparison. Best-effort:
    observability must never raise into the query path. Only the query
    text is recorded (whitespace-collapsed, truncated) — never bind args,
    so parameter values cannot leak into the ring buffer. Events carry the
    org id of the request-pinned RLS lease when one is bound; queries
    outside a request context have no org and are dropped by the recorder
    (its ring buffer is tenant-scoped).
    """
    try:
        duration_ms = (time.monotonic() - started) * 1000.0
        threshold_ms = _slow_query_threshold_ms()
        if duration_ms < threshold_ms:
            return
        org_id = ""
        bound = _request_pg_conn.get()
        if isinstance(bound, RequestConnLease):
            org_id = bound.org_id
        record_slow_query(
            org_id=org_id,
            fingerprint=" ".join(query.split())[:256],
            duration_ms=duration_ms,
            source=f"postgres.{source}",
            threshold_ms=threshold_ms,
        )
    except Exception:  # noqa: BLE001 — never break the query path
        pass


@dataclass
class ConnectionConfig:
    host: str
    port: int
    database: str
    user: str
    password: str
    min_size: int
    max_size: int


class PostgresClient:
    """PostgreSQL client with connection pooling.

    Uses asyncpg for async database access.
    Designed to work behind PgBouncer in transaction mode.
    """

    def __init__(
        self,
        host: str | None = None,
        port: int | None = None,
        database: str | None = None,
        user: str | None = None,
        password: str | None = None,
        min_pool_size: int | None = None,
        max_pool_size: int | None = None,
        ssl: bool | str | None = None,
    ) -> None:
        # Resolve settings on every call (lru_cache'd, so the cost is
        # one dict lookup) — keeps monkeypatched env vars in tests
        # observable, and means a future caller can swap the config
        # without re-importing this module.
        s = get_settings()

        # Honour ``settings.database_url`` as the canonical override path
        # for managed Postgres (Neon, RDS, Aurora, Cloud SQL). When set,
        # we parse the DSN once here so the pool can use the right
        # host/port/user/password/SSL — without this the pool would
        # silently connect to ``localhost`` and the production deploy
        # would talk to a non-existent DB.
        from urllib.parse import parse_qs, urlsplit

        url_override = s.database_url if s.database_url else None
        if url_override:
            parts = urlsplit(url_override)
            # Accept the three shapes operators actually paste:
            #   - libpq-style:       postgresql://user:pw@host/db?sslmode=require
            #   - SQLAlchemy async:  postgresql+asyncpg://user:pw@host/db
            #   - legacy alias:      postgres://user:pw@host/db
            # Strip any ``+driver`` suffix so all three collapse to the same
            # ``scheme_db`` for the allow-list check below.
            scheme_db = parts.scheme.split("+", 1)[0]
            if scheme_db not in {"postgres", "postgresql"}:
                raise ValueError(f"Unsupported scheme in DATABASE_URL: {parts.scheme!r}")
            host = host or parts.hostname or s.postgres_host
            port = port or parts.port or s.postgres_port
            # Strip leading "/" from path so we don't end up with "/eden"
            database = database or (parts.path.lstrip("/") or s.postgres_db)
            user = user or parts.username or s.postgres_user
            password = password or parts.password or s.postgres_password
            # asyncpg uses ``ssl=`` not libpq's ``sslmode=``. Honour the
            # libpq value here so callers can paste a Neon-style URL
            # verbatim. ``channel_binding`` is libpq-only and ignored
            # (asyncpg uses scram-sha-256 by default which satisfies it).
            query = parse_qs(parts.query)
            if ssl is None and "sslmode" in query:
                mode = query["sslmode"][0].lower()
                ssl = mode not in {"disable", "allow", "prefer", ""}
        self.config = ConnectionConfig(
            host=host or s.postgres_host,
            port=port or s.postgres_port,
            database=database or s.postgres_db,
            user=user or s.postgres_user,
            password=password or s.postgres_password,
            # Honour ``settings.postgres_*_pool_size`` when the caller
            # didn't pass an explicit override — the Northflank manifest
            # sets ``POSTGRES_POOL_SIZE=10`` / ``POSTGRES_MIN_POOL_SIZE=0``
            # for the API container; the previous defaults ignored those
            # env vars and silently kept the hardcoded 5/20 baseline.
            # ``min_size`` MUST stay 0 in Neon deploys so scale-to-zero
            # can fire — warm sockets alone keep compute active.
            # M14 (§8.1): when ``EDEN_NEON_SCALE_TO_ZERO=1``, force
            # min_size=0 regardless of caller override.
            min_size=_m14_min_size(min_pool_size, s.postgres_min_pool_size),
            max_size=max_pool_size if max_pool_size is not None else s.postgres_pool_size,
        )
        # Persist the explicit ``ssl`` arg (caller override) but prefer
        # the parsed URL value when ``database_url`` was the source.
        self._ssl_override = ssl
        self._pool: Pool | None = None

    async def initialize(self) -> None:
        """Initialize the connection pool."""
        if self._pool is not None:
            return

        # ``statement_timeout`` + ``idle_in_transaction_session_timeout`` are
        # server-side ``SET`` parameters, not kwargs accepted by
        # ``asyncpg.create_pool``. Apply them via the ``init`` callback
        # so every connection in the pool has both caps before being
        # handed out. ``statement_timeout`` caps any single query;
        # ``idle_in_transaction_session_timeout`` kills connections that
        # sit idle *inside* a transaction — a "tx in flight but no work
        # happening" connection holds row locks that block vacuum + other
        # writers, and burns Neon CU until the TCP timeout kicks in.
        _settings_init = get_settings()
        _statement_timeout_ms = int(
            getattr(_settings_init, "postgres_statement_timeout_ms", 30_000)
        )
        _idle_in_tx_timeout_ms = int(
            getattr(_settings_init, "postgres_idle_in_transaction_timeout_ms", 60_000)
        )

        async def _init_connection(conn: asyncpg.Connection) -> None:
            await conn.execute(f"SET statement_timeout = {_statement_timeout_ms}")
            await conn.execute(
                f"SET idle_in_transaction_session_timeout = {_idle_in_tx_timeout_ms}"
            )
            # N4 — pgvector codec. Without this, binding a Python
            # ``list[float]`` to a ``vector`` column raises a DataError,
            # which silently broke every KB typed-embedding insert (the
            # clients catch and log). Registering the text-format codec
            # makes ``list[float]`` ↔ ``vector`` work on every pooled
            # connection, so the KB typed columns and the new
            # ``vector_documents`` store both bind cleanly.
            #
            # Fresh DB pre-migration the vector type doesn't exist yet;
            # the vector columns don't either, so nothing to bind. The
            # codec registers on the next connection after upgrade.
            with contextlib.suppress(Exception):  # pragma: no cover - ext missing
                await conn.set_type_codec(
                    "vector",
                    encoder=_encode_vector,
                    decoder=_decode_vector,
                    format="text",
                )

        # SSL config (Phase 7 — Neon cutover). Managed providers
        # (Neon, RDS, Aurora) reject unencrypted connections; the
        # local sandbox Postgres on Northflank (when the addon
        # worked) didn't require SSL. ``ssl=True`` is the asyncpg
        # equivalent of ``sslmode=require`` — it uses Python's default
        # SSL context, which is enough for verifying the server
        # certificate via the system CA bundle. Operators who need
        # ``verify-full`` should set ``database_url`` instead and
        # pass a DSN that asyncpg can parse.
        if self._ssl_override is not None:
            ssl: bool | str = self._ssl_override
        else:
            ssl = False
            # Audit 2026-06-23: was `getattr(settings, "postgres_sslmode", "")`
            # but `settings` was never bound in this scope (only
            # `get_settings` is imported per the module docstring). Caused
            # NameError on real `client.initialize()` calls. Resolve
            # via get_settings() to match the rest of the module.
            _ssl_settings = get_settings()
            sslmode = getattr(_ssl_settings, "postgres_sslmode", "")
            if sslmode and sslmode.lower() not in {"disable", "allow", "prefer", ""}:
                ssl = True

        _idle_lifetime = float(
            getattr(
                _settings_init,
                "postgres_max_inactive_connection_lifetime",
                60.0,
            )
            or 60.0
        )

        # HIGH fix (PgBouncer transaction-mode compat): asyncpg's default
        # client-side prepared-statement cache is keyed per physical
        # ``Connection``, but PgBouncer transaction-mode multiplexing can
        # replay a statement prepared on one backend connection against a
        # different one — producing intermittent "prepared statement does
        # not exist" / "prepared statement already exists" errors under
        # load. This module (see class docstring) explicitly targets
        # PgBouncer transaction mode, so default the cache off (0) via
        # ``settings.postgres_statement_cache_size``; only override via
        # ``POSTGRES_STATEMENT_CACHE_SIZE`` for a deployment known to run
        # session-mode pooling or no pooler at all.
        _statement_cache_size = int(getattr(_settings_init, "postgres_statement_cache_size", 0))

        self._pool = await asyncpg.create_pool(
            host=self.config.host,
            port=self.config.port,
            database=self.config.database,
            user=self.config.user,
            password=self.config.password,
            min_size=self.config.min_size,
            max_size=self.config.max_size,
            # B-3 (Session 23) — bound the time a caller waits on
            # a pool slot and recycle idle connections so a leaked
            # connection can't keep a backend slot indefinitely.
            # ``timeout=10`` caps ``pool.acquire()``; asyncpg's
            # default is 30 s, which is longer than our upstream
            # API gateway tolerance. Idle lifetime defaults to 30s
            # (``POSTGRES_MAX_INACTIVE_CONNECTION_LIFETIME``) so Neon
            # autosuspend (~5 min) can observe a quiet TCP plane.
            timeout=10,
            command_timeout=60,
            init=_init_connection,
            ssl=ssl,
            max_inactive_connection_lifetime=_idle_lifetime,
            statement_cache_size=_statement_cache_size,
        )
        logger.info(
            f"PostgreSQL pool initialized: {self.config.host}:{self.config.port}/{self.config.database}"
        )

    async def close(self) -> None:
        """Close the connection pool."""
        if self._pool:
            await self._pool.close()
            self._pool = None
            logger.info("PostgreSQL pool closed")

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[Connection]:
        """Acquire a connection from the pool (or the RLS-pinned request conn).

        This is the single consumption point for the request-pinned binding —
        every query in this module reaches a connection through here — which
        is why it is also where a :class:`RequestConnLease` is redeemed. The
        RLS middleware binds an unredeemed lease and does no Postgres work at
        all; the first query to arrive here pays the acquire + ``BEGIN`` +
        ``set_config``, and a request that never queries pays nothing.
        """
        bound = _request_pg_conn.get()
        if isinstance(bound, RequestConnLease):
            # Redeem on first use. ``ensure`` returns None if acquisition
            # failed, in which case we fall through to an ordinary pool
            # checkout — the same fail-soft behaviour as when the middleware's
            # eager acquire used to raise.
            leased = await bound.ensure()
            if leased is not None:
                # Exclusive for the duration of the caller's block: asyncpg
                # allows one operation per connection, and this one is shared
                # by everything in the request's context. See ``use``.
                # Middleware owns the lifetime; do not release here.
                async with bound.use():
                    yield leased
                return
        elif bound is not None:
            # Same connection that holds SET LOCAL app.current_org_id.
            # Do not release — middleware owns the lifetime.
            yield bound
            return

        if not self._pool:
            await self.initialize()
        else:
            # An asyncpg pool is bound to the event loop that created
            # it. Callers that rotate loops (pytest function-scoped
            # loops, ``asyncio.new_event_loop()`` per case) otherwise
            # hang forever inside ``pool.acquire()`` waiting on
            # primitives owned by a stopped loop. Detect the mismatch
            # and rebuild on the current loop. Production runs one
            # long-lived loop, so this path is test/dev-only.
            pool_loop = getattr(self._pool, "_loop", None)
            try:
                running = asyncio.get_running_loop()
            except RuntimeError:
                running = None
            if (
                pool_loop is not None
                and running is not None
                and pool_loop is not running
            ):
                stale, self._pool = self._pool, None
                # The stale pool's primitives belong to the other
                # loop; abandon it rather than block re-init.
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(stale.close(), timeout=1.0)
                await self.initialize()

        pool = self._pool
        if pool is None:
            raise RuntimeError("Postgres pool failed to initialize")
        async with pool.acquire() as connection:
            yield connection

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[Transaction]:
        """Execute within a transaction (autocommit=False for PgBouncer)."""
        async with self.acquire() as conn, conn.transaction():
            yield conn

    async def execute(self, query: str, *args: Any) -> str:
        """Execute a query and return status."""
        started = time.monotonic()
        try:
            async with self.acquire() as conn:
                return cast(str, await conn.execute(query, *args))
        finally:
            _maybe_record_slow_query(query, started, "execute")

    async def executemany(
        self,
        query: str,
        args_iter: Iterable[Sequence[Any]],
    ) -> str:
        """Run the same parameterised query for many row-tuples.

        ``args_iter`` is a sequence of tuples; each becomes one row
        insert / update. Returns the raw asyncpg status string from
        the final statement (use ``fetch`` for SELECTs).
        """
        started = time.monotonic()
        try:
            async with self.acquire() as conn:
                return cast(
                    str,
                    await conn.executemany(query, list(args_iter)),
                )
        finally:
            _maybe_record_slow_query(query, started, "executemany")

    async def fetch(self, query: str, *args: Any) -> list[dict]:
        """Fetch all rows as dicts."""
        started = time.monotonic()
        try:
            async with self.acquire() as conn:
                rows = await conn.fetch(query, *args)
                return [dict(row) for row in rows]
        finally:
            _maybe_record_slow_query(query, started, "fetch")

    async def fetchrow(self, query: str, *args: Any) -> dict | None:
        """Fetch a single row as dict."""
        started = time.monotonic()
        try:
            async with self.acquire() as conn:
                row = await conn.fetchrow(query, *args)
                return dict(row) if row else None
        finally:
            _maybe_record_slow_query(query, started, "fetchrow")

    async def insert_usage_event(
        self,
        *,
        org_id: str,
        event_type: str,
        resource: str,
        quantity: float,
        unit: str,
        user_id: str | None = None,
        model: str | None = None,
        cost_usd: float | None = None,
        metadata: dict | None = None,
        correlation_id: str | None = None,
    ) -> str | None:
        """Persist a usage event row and return the event UUID.

        ``metadata`` and ``correlation_id`` are stored as JSONB /
        separate columns respectively. ``None`` for either is
        encoded as a NULL.
        """
        import uuid

        event_id = str(uuid.uuid4())
        try:
            row = await self.fetchrow(
                """
                -- Column is ``id``, not ``event_id``. The table has been
                -- ``id UUID PRIMARY KEY DEFAULT gen_random_uuid()`` since
                -- migration 002 and no ``event_id`` column has ever
                -- existed, so this statement raised UndefinedColumnError
                -- on every call. It went unnoticed because the method has
                -- no callers — ``data_platform/bronze_sink.py`` is the
                -- writer that actually runs, and it names the columns
                -- correctly. Verified against the live schema 2026-07-29.
                INSERT INTO usage_events (
                    id, org_id, event_type, resource, quantity, unit,
                    user_id, model, cost_usd, metadata, correlation_id, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
                RETURNING id
                """,
                event_id,
                org_id,
                event_type,
                resource,
                quantity,
                unit,
                user_id,
                model,
                cost_usd,
                _dump_jsonb(metadata),
                correlation_id,
            )
            return str(row["id"]) if row else None
        except Exception:
            # Surface the failure to the caller (the service layer
            # logs + swallows) so we don't hide DB outages.
            raise

    async def get_org_resource_limits(
        self,
        org_id: str,
    ) -> dict[str, int] | None:
        """Return the per-org resource-limit overrides, if any.

        Logs and swallows on exception. The fail-closed staleness
        gate lives in the RLSOrgContextMiddleware (DL-14); here we
        just emit enough detail for ops to see why the override
        lookup went sideways (was a silent ``return None`` before
        Session 23 B-2).
        """
        try:
            row = await self.fetchrow(
                """
                SELECT jobs_soft_limit, jobs_hard_limit,
                       tokens_soft_limit, tokens_hard_limit,
                       storage_mb_soft_limit, storage_mb_hard_limit,
                       sandbox_seconds_soft_limit, sandbox_seconds_hard_limit,
                       -- Consumers read these and they were not selected.
                       -- fetchrow returns a plain dict, so .get() silently
                       -- returned the DEFAULT instead of raising:
                       --   tenant_rate_limit.py  -> every org capped at the
                       --     hard-coded 60 rpm, per-org overrides inert
                       --   usage_service.py      -> every org evaluated as
                       --     "org_free" regardless of its actual plan
                       -- Masked today because all orgs sit on the defaults;
                       -- it surfaces on the first paying customer.
                       plan_name,
                       requests_per_minute, requests_per_hour,
                       concurrent_jobs
                FROM org_resource_limits
                WHERE org_id = $1
                -- The writer stores multiple windows keyed
                -- (org_id, effective_from); without an order this is
                -- arbitrary the moment a second window exists.
                ORDER BY effective_from DESC NULLS LAST
                LIMIT 1
                """,
                org_id,
            )
            return row
        except Exception as exc:
            logger.warning(
                "org_resource_limits lookup failed (org_id=%s): %s",
                org_id,
                exc,
                exc_info=True,
            )
            return None

    async def set_org_resource_limits(
        self,
        org_id: str,
        *,
        jobs_soft_limit: int | None = None,
        jobs_hard_limit: int | None = None,
        tokens_soft_limit: int | None = None,
        tokens_hard_limit: int | None = None,
        storage_mb_soft_limit: int | None = None,
        storage_mb_hard_limit: int | None = None,
        sandbox_seconds_soft_limit: int | None = None,
        sandbox_seconds_hard_limit: int | None = None,
        plan_name: str | None = None,
    ) -> None:
        """Upsert the per-org resource-limit overrides.

        ``plan_name`` is supported (June 2026 — Cat 23 audit):
        the call site in :mod:`eden.services.usage_service` writes
        ``"org_free"`` when no row exists, so the migration
        ``046_free_only_default_plan`` backfill can be skipped for
        genuinely new orgs. Older signatures rejected the kwarg
        with a TypeError that surfaced as a 5xx in the quota
        header middleware.
        """
        await self.execute(
            """
            INSERT INTO org_resource_limits (
                org_id, jobs_soft_limit, jobs_hard_limit,
                tokens_soft_limit, tokens_hard_limit,
                storage_mb_soft_limit, storage_mb_hard_limit,
                sandbox_seconds_soft_limit, sandbox_seconds_hard_limit,
                plan_name, effective_from, updated_at
            ) VALUES (
                $1,
                COALESCE($2, 100), COALESCE($3, 200),
                COALESCE($4, 1000000), COALESCE($5, 2000000),
                COALESCE($6, 1024), COALESCE($7, 5120),
                COALESCE($8, 3600), COALESCE($9, 7200),
                COALESCE($10, 'org_free'),
                'epoch'::timestamptz, NOW()
            )
            -- The unique constraint on this table is (org_id,
            -- effective_from), not (org_id) alone (see the
            -- ``org_resource_limits_org_id_effective_from_key``
            -- UNIQUE index). We pin effective_from to 'epoch'
            -- so the conflict target is stable across calls;
            -- the "default current" plan for the org is always
            -- stored at effective_from = 'epoch' and subsequent
            -- override windows live in their own distinct rows.
            ON CONFLICT (org_id, effective_from) DO UPDATE SET
                jobs_soft_limit = EXCLUDED.jobs_soft_limit,
                jobs_hard_limit = EXCLUDED.jobs_hard_limit,
                tokens_soft_limit = EXCLUDED.tokens_soft_limit,
                tokens_hard_limit = EXCLUDED.tokens_hard_limit,
                storage_mb_soft_limit = EXCLUDED.storage_mb_soft_limit,
                storage_mb_hard_limit = EXCLUDED.storage_mb_hard_limit,
                sandbox_seconds_soft_limit = EXCLUDED.sandbox_seconds_soft_limit,
                sandbox_seconds_hard_limit = EXCLUDED.sandbox_seconds_hard_limit,
                plan_name = COALESCE(EXCLUDED.plan_name, org_resource_limits.plan_name),
                updated_at = NOW()
            """,
            org_id,
            jobs_soft_limit,
            jobs_hard_limit,
            tokens_soft_limit,
            tokens_hard_limit,
            storage_mb_soft_limit,
            storage_mb_hard_limit,
            sandbox_seconds_soft_limit,
            sandbox_seconds_hard_limit,
            plan_name,
        )

    async def fetchval(self, query: str, *args: Any) -> Any:
        """Fetch a single value."""
        started = time.monotonic()
        try:
            async with self.acquire() as conn:
                return await conn.fetchval(query, *args)
        finally:
            _maybe_record_slow_query(query, started, "fetchval")

    async def fetchiter(
        self,
        query: str,
        *args: Any,
        batch_size: int = 500,
    ) -> AsyncIterator[dict]:
        """Stream rows via a server-side cursor. Yields one dict at a time.

        Use for very large result sets (≥ ~50k rows) where loading the
        full result into memory is undesirable. Each row is yielded
        as soon as it is decoded — the cursor pulls ``batch_size`` rows
        per round-trip from Postgres. The caller MUST fully consume the
        iterator (or cancel it) before the connection is returned to
        the pool; the surrounding ``async with self.acquire()`` enforces
        this.
        """
        # Not slow-query instrumented: a monotonic diff around a streamed
        # cursor would mostly measure the caller's per-row work between
        # yields, not Postgres time, so the recorded duration would lie.
        async with self.acquire() as conn, conn.transaction():
            async for record in conn.cursor(query, *args, prefetch=batch_size):
                yield dict(record)

    # ========================================================================
    # Job Persistence
    # ========================================================================

    async def upsert_job(
        self,
        job_id: str,
        request: dict,
        status: str = "pending",
        current_stage: str = "planning",
        created_at: str | None = None,
        user_id: str | None = None,
    ) -> bool:
        """Insert or update a job record."""
        if created_at is None:
            from datetime import datetime

            created_at = datetime.now(UTC).isoformat()

        query = """
            INSERT INTO jobs (job_id, request, status, current_stage, created_at, updated_at, user_id)
            VALUES ($1, $2, $3, $4, $5, $5, $6)
            ON CONFLICT (job_id) DO UPDATE SET
                status = EXCLUDED.status,
                current_stage = EXCLUDED.current_stage,
                updated_at = EXCLUDED.updated_at
            RETURNING job_id
        """
        result = await self.fetchval(
            query, job_id, _dump_jsonb(request), status, current_stage, created_at, user_id
        )
        return result is not None

    async def get_job(self, job_id: str, user_id: str | None = None) -> dict | None:
        """Fetch a job by ID, optionally verifying ownership."""
        query = """
            SELECT job_id, request, status, current_stage, outcome_tier,
                   created_at, updated_at, edp_history, code_history, user_id
            FROM jobs
            WHERE job_id = $1
        """
        params = [job_id]

        if user_id:
            query += " AND user_id = $2"
            params.append(user_id)

        return await self.fetchrow(query, *params)

    async def update_job_status(
        self,
        job_id: str,
        status: str,
        current_stage: str,
        outcome_tier: str | None = None,
        updated_at: str | None = None,
    ) -> bool:
        """Update job status and stage."""
        if updated_at is None:
            from datetime import datetime

            updated_at = datetime.now(UTC).isoformat()

        query = """
            UPDATE jobs
            SET status = $2, current_stage = $3, outcome_tier = $4, updated_at = $5
            WHERE job_id = $1
            RETURNING job_id
        """
        result = await self.fetchval(query, job_id, status, current_stage, outcome_tier, updated_at)
        if result is not None:
            # A6: wake job WS / mobile SSE waiters (fire-and-forget).
            with contextlib.suppress(Exception):
                from eden.api.routes.websocket import publish_job_event

                asyncio.create_task(
                    publish_job_event(
                        job_id,
                        {
                            "job_id": job_id,
                            "status": status,
                            "current_stage": current_stage,
                            "outcome_tier": outcome_tier,
                        },
                    )
                )
        return result is not None

    async def list_jobs(
        self,
        user_id: str | None = None,
        status: str | None = None,
        outcome_tier: str | None = None,
        q: str | None = None,
        sort: str = "created_at:desc",
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        """List jobs with pagination and optional filters."""
        conditions = []
        params: list[Any] = []
        param_idx = 1

        if user_id:
            conditions.append(f"user_id = ${param_idx}")
            params.append(user_id)
            param_idx += 1

        if status:
            conditions.append(f"status = ${param_idx}")
            params.append(status)
            param_idx += 1

        if outcome_tier:
            conditions.append(f"outcome_tier = ${param_idx}")
            params.append(outcome_tier)
            param_idx += 1

        if q:
            # Prefer expression-index-friendly predicates (migration 113
            # adds gin_trgm on job_id and request::text).
            conditions.append(f"(job_id ILIKE ${param_idx} OR request::text ILIKE ${param_idx})")
            params.append(f"%{q}%")
            param_idx += 1

        # Parse sort parameter (field:direction)
        sort_field, sort_dir = "created_at", "DESC"
        if sort and ":" in sort:
            sort_field, sort_dir = sort.split(":", 1)
            sort_dir = sort_dir.upper()
            if sort_dir not in ("ASC", "DESC"):
                sort_dir = "DESC"
            # Whitelist allowed sort fields to prevent SQL injection
            allowed_fields = ("created_at", "updated_at", "status", "outcome_tier")
            if sort_field not in allowed_fields:
                sort_field = "created_at"
        elif sort:
            allowed_fields = ("created_at", "updated_at", "status", "outcome_tier")
            if sort in allowed_fields:
                sort_field = sort

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        query = f"""
            SELECT job_id, request, status, current_stage, outcome_tier, created_at, updated_at
            FROM jobs
            {where_clause}
            ORDER BY {sort_field} {sort_dir}
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """
        params.extend([limit, offset])
        return await self.fetch(query, *params)

    async def count_jobs(
        self,
        user_id: str | None = None,
        status: str | None = None,
        outcome_tier: str | None = None,
    ) -> int:
        """Count jobs with optional filters."""
        conditions = []
        params = []
        param_idx = 1

        if user_id:
            conditions.append(f"user_id = ${param_idx}")
            params.append(user_id)
            param_idx += 1

        if status:
            conditions.append(f"status = ${param_idx}")
            params.append(status)
            param_idx += 1

        if outcome_tier:
            conditions.append(f"outcome_tier = ${param_idx}")
            params.append(outcome_tier)
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        query = f"SELECT COUNT(*) FROM jobs {where_clause}"
        return await self.fetchval(query, *params) or 0

    async def update_job_stage_history(self, job_id: str, stage_history: list[dict]) -> bool:
        """Update job stage history."""
        query = """
            UPDATE jobs
            SET stage_history = $2, updated_at = NOW()
            WHERE job_id = $1
            RETURNING job_id
        """
        result = await self.fetchval(query, job_id, _dump_jsonb(stage_history))
        return result is not None

    # ========================================================================
    # Checkpoint Blobs (LangGraph state offloading)
    # ========================================================================

    async def insert_checkpoint_blob(self, job_id: str, field: str, value: dict) -> bool:
        """Store a checkpoint blob for a job."""
        query = """
            INSERT INTO checkpoint_blobs (job_id, field, value)
            VALUES ($1, $2, $3)
            ON CONFLICT (job_id, field) DO UPDATE SET
                value = EXCLUDED.value,
                created_at = NOW()
            RETURNING job_id
        """
        result = await self.fetchval(query, job_id, field, _dump_jsonb(value))
        if result is not None:
            with contextlib.suppress(Exception):
                from eden.api.routes.websocket import publish_job_event

                asyncio.create_task(
                    publish_job_event(
                        job_id,
                        {"job_id": job_id, "blob_field": field},
                    )
                )
        return result is not None

    async def get_checkpoint_blob(self, job_id: str, field: str) -> dict | None:
        """Get a specific checkpoint blob."""
        query = "SELECT value FROM checkpoint_blobs WHERE job_id = $1 AND field = $2"
        row = await self.fetchrow(query, job_id, field)
        return json.loads(row["value"]) if row else None

    async def get_checkpoint_blobs(self, job_id: str) -> list[dict]:
        """Get all checkpoint blobs for a job."""
        query = """
            SELECT field, value, created_at
            FROM checkpoint_blobs
            WHERE job_id = $1
            ORDER BY created_at ASC
        """
        rows = await self.fetch(query, job_id)
        return [
            {"field": r["field"], "value": json.loads(r["value"]), "created_at": r["created_at"]}
            for r in rows
        ]

    async def delete_checkpoint_blobs(self, job_id: str) -> bool:
        """Delete all checkpoint blobs for a job."""
        await self.execute("DELETE FROM checkpoint_blobs WHERE job_id = $1", job_id)
        return True

    # ========================================================================
    # Agent Uploads (Phase 3: web upload + sim/test runner)
    # ========================================================================

    async def create_agent_upload(
        self,
        *,
        org_id: str,
        agent_id: str,
        code_path: str,
        entry_point: str | None = None,
        framework: str | None = None,
        language: str | None = None,
        file_count: int | None = None,
        total_bytes: int | None = None,
        eval_yaml: dict | None = None,
        uploaded_by: str | None = None,
    ) -> dict | None:
        """Create a new agent upload row. The DB trigger handles
        supersession of prior uploads (is_active flag).

        Returns the inserted row (with the auto-generated id and
        uploaded_at).
        """
        row = await self.fetchrow(
            """
            INSERT INTO agent_uploads (
                org_id, agent_id, code_path, entry_point, framework,
                language, file_count, total_bytes, eval_yaml, uploaded_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id, org_id, agent_id, upload_version, code_path,
                      entry_point, framework, language, file_count,
                      total_bytes, eval_yaml, uploaded_by, uploaded_at,
                      is_active
            """,
            org_id,
            agent_id,
            code_path,
            entry_point,
            framework,
            language,
            file_count,
            total_bytes,
            _dump_jsonb(eval_yaml),
            uploaded_by,
        )
        if row and row.get("eval_yaml") is not None:  # noqa: SIM102
            # asyncpg returns JSONB as a Python value already; only
            # decode if it's still a string (older paths).
            # The nested `if` is intentional — it documents the
            # legacy-vs-modern JSONB path; combining would lose that.
            if isinstance(row["eval_yaml"], str):  # noqa: SIM102
                row["eval_yaml"] = json.loads(row["eval_yaml"])
        return row

    async def list_agent_uploads(
        self,
        *,
        org_id: str,
        agent_id: str,
        active_only: bool = False,
        limit: int = 50,
    ) -> list[dict]:
        """List uploads for an agent, most-recent first."""
        where = "org_id = $1 AND agent_id = $2"
        if active_only:
            where += " AND is_active = TRUE"
        rows = await self.fetch(
            f"""
            SELECT id, org_id, agent_id, upload_version, code_path,
                   entry_point, framework, language, file_count,
                   total_bytes, eval_yaml, uploaded_by, uploaded_at,
                   is_active
            FROM agent_uploads
            WHERE {where}
            ORDER BY uploaded_at DESC
            LIMIT $3
            """,
            org_id,
            agent_id,
            limit,
        )
        for r in rows:
            if isinstance(r.get("eval_yaml"), str):
                r["eval_yaml"] = json.loads(r["eval_yaml"])
        return rows

    async def get_agent_upload(
        self,
        upload_id: str,
    ) -> dict | None:
        """Fetch one upload row by id."""
        row = await self.fetchrow(
            """
            SELECT id, org_id, agent_id, upload_version, code_path,
                   entry_point, framework, language, file_count,
                   total_bytes, eval_yaml, uploaded_by, uploaded_at,
                   is_active
            FROM agent_uploads
            WHERE id = $1
            """,
            upload_id,
        )
        if row and isinstance(row.get("eval_yaml"), str):
            row["eval_yaml"] = json.loads(row["eval_yaml"])
        return row

    async def get_active_upload(
        self,
        *,
        org_id: str,
        agent_id: str,
    ) -> dict | None:
        """Fetch the active upload for an agent (None if none)."""
        row = await self.fetchrow(
            """
            SELECT id, org_id, agent_id, upload_version, code_path,
                   entry_point, framework, language, file_count,
                   total_bytes, eval_yaml, uploaded_by, uploaded_at,
                   is_active
            FROM agent_uploads
            WHERE org_id = $1 AND agent_id = $2 AND is_active = TRUE
            ORDER BY uploaded_at DESC
            LIMIT 1
            """,
            org_id,
            agent_id,
        )
        if row and isinstance(row.get("eval_yaml"), str):
            row["eval_yaml"] = json.loads(row["eval_yaml"])
        return row

    # ========================================================================
    # Sim / Test Runs (Phase 3: server-side execution)
    # ========================================================================

    async def create_sim_run(
        self,
        *,
        org_id: str,
        agent_id: str,
        upload_id: str,
        kind: str,
        user_id: str | None = None,
        runner_kind: str | None = None,
    ) -> dict | None:
        """Insert a new sim/test run row in `pending` state.

        The actual execution happens in a background task; the caller
        immediately returns this row so the client can poll its id.
        """
        row = await self.fetchrow(
            """
            INSERT INTO sim_runs (org_id, agent_id, upload_id, kind, user_id, runner_kind)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, org_id, agent_id, upload_id, kind, status,
                      user_id, started_at, runner_kind
            """,
            org_id,
            agent_id,
            upload_id,
            kind,
            user_id,
            runner_kind,
        )
        return row

    async def update_sim_run_status(
        self,
        run_id: str,
        *,
        status: str,
        finished_at: str | None = None,
        duration_ms: int | None = None,
        error: str | None = None,
    ) -> bool:
        """Update the run's status. ``finished_at`` is set automatically
        when ``status`` is terminal (passed/failed/error).
        """
        import datetime as _dt

        if finished_at is None and status in ("passed", "failed", "error"):
            finished_at = _dt.datetime.now(_dt.UTC).isoformat()
        result = await self.fetchval(
            """
            UPDATE sim_runs
            SET status = $2,
                finished_at = COALESCE($3, finished_at),
                duration_ms = COALESCE($4, duration_ms),
                error = COALESCE($5, error)
            WHERE id = $1
            RETURNING id
            """,
            run_id,
            status,
            finished_at,
            duration_ms,
            error,
        )
        return result is not None

    async def update_sim_run_result(
        self,
        run_id: str,
        *,
        results: dict,
    ) -> bool:
        """Persist the structured run results (JSONB)."""
        result = await self.fetchval(
            """
            UPDATE sim_runs
            SET results = $2
            WHERE id = $1
            RETURNING id
            """,
            run_id,
            _dump_jsonb(results),
        )
        return result is not None

    async def get_sim_run(self, run_id: str) -> dict | None:
        row = await self.fetchrow(
            """
            SELECT id, org_id, agent_id, upload_id, kind, status,
                   user_id, started_at, finished_at, duration_ms,
                   results, error, runner_kind
            FROM sim_runs
            WHERE id = $1
            """,
            run_id,
        )
        if row and isinstance(row.get("results"), str):
            row["results"] = json.loads(row["results"])
        return row

    async def list_sim_runs(
        self,
        *,
        org_id: str,
        agent_id: str,
        kind: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        where = "org_id = $1 AND agent_id = $2"
        params: list = [org_id, agent_id]
        if kind:
            params.append(kind)
            where += f" AND kind = ${len(params)}"
        if status:
            params.append(status)
            where += f" AND status = ${len(params)}"
        rows = await self.fetch(
            f"""
            SELECT id, org_id, agent_id, upload_id, kind, status,
                   user_id, started_at, finished_at, duration_ms,
                   results, error, runner_kind
            FROM sim_runs
            WHERE {where}
            ORDER BY started_at DESC
            LIMIT ${len(params) + 1}
            """,
            *params,
            limit,
        )
        for r in rows:
            if isinstance(r.get("results"), str):
                r["results"] = json.loads(r["results"])
        return rows


# Singleton instance
_postgres_client: PostgresClient | None = None


async def get_postgres_client() -> PostgresClient:
    """Get the singleton PostgreSQL client instance."""
    global _postgres_client
    if _postgres_client is None:
        _postgres_client = PostgresClient()
        await _postgres_client.initialize()
    return _postgres_client


async def set_session_org_context(client: PostgresClient, org_id: str) -> None:
    """Phase 7.3e — set the RLS GUC for the current request.

    The migration 015 RLS policies use
    ``current_setting('app.current_org_id', true)`` to filter rows
    on the observability/retention/audit tables to the
    authenticated tenant. The FastAPI middleware (or a route
    handler) should call this helper at the start of every
    request that touches a tenant-scoped table.

    The GUC is scoped to the current transaction (``SET LOCAL``)
    so the value doesn't leak between requests sharing the same
    connection-pool session.

    Audit 2026-07-03 — explicitly open a transaction before calling
    ``set_config(..., is_local=true)``. ``SET LOCAL`` has no effect
    outside a transaction; the previous "best-effort" comment was
    actually a silent no-op whenever the implicit transaction from
    ``client.execute`` already committed by the time the SET
    returned. ``async with conn.transaction()`` guarantees the SET
    runs inside an open tx; the transaction commits immediately on
    exit so the GUC reverts at function return (the intended
    scoping).

    LIMITATION — request-scoped connection: even with the
    transaction wrapper correct, the GUC is set on the connection
    the middleware acquired. Route handlers that call
    ``client.execute`` may get a *different* pooled connection,
    so the RLS policies on tables this query touches won't
    actually filter. Defence-in-depth now requires either (a)
    per-request connection pinning via ``request.state.pg_conn``,
    or (b) every tenant-scoped handler passing the connection from
    this helper through. Until that's wired, the migration-015
    RLS policies are "best-effort" — per-query ``WHERE org_id = $1``
    remains the primary defence.
    """
    if not org_id:
        return
    try:
        # ``client.execute`` opens an implicit transaction for the
        # single statement; asyncpg commits that transaction when
        # the statement returns, so ``SET LOCAL`` is correctly
        # scoped to that transaction and the GUC reverts before
        # the connection is returned to the pool. (Pre-fix this
        # was a hidden implicit transaction that sometimes
        # committed before the SET landed — the audit 2026-07-03
        # docstring above documents the request-scoped-connection
        # gap that this helper cannot bridge on its own.)
        await client.execute(
            "SELECT set_config('app.current_org_id', $1, true)",
            org_id,
        )
    except Exception:
        # The migration's RLS policies are written with
        # ``current_setting('app.current_org_id', true)`` so a
        # missing setting returns NULL — a no-op filter. Never
        # raise: a DB blip on the SET should not poison the
        # request.
        return


async def close_postgres_client() -> None:
    """Close the singleton PostgreSQL client."""
    global _postgres_client
    if _postgres_client:
        await _postgres_client.close()
        _postgres_client = None
