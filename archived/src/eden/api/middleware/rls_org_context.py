"""B-1 fix — RLS GUC middleware with request-scoped connection.

The migration-015 Row-Level Security policies read
``current_setting('app.current_org_id', true)`` to filter rows
on the observability/retention/audit tables. The previous
state: ``set_session_org_context`` was implemented but never
invoked from any production route — RLS policies were
inactive on every request (defence in depth, but not actually
defending).

This middleware closes the gap by:

1. Resolving the request's org (path param → X-Org-Id → JWT cookie).
2. Acquiring a single pooled connection for the lifetime of
   the request.
3. Opening a transaction on that connection so ``SET LOCAL``
   scopes the GUC correctly.
4. Issuing ``SELECT set_config('app.current_org_id', $1, true)``
   so the migration-015 RLS policies filter rows.
5. Stashing the pinned connection on ``request.state.pg_conn``
   so route handlers that need RLS-correct queries can do
   ``await request.state.pg_conn.fetch(...)`` directly.
6. Committing the transaction and releasing the connection as
   soon as the response *headers* are ready (see "Streaming
   responses" below) — NOT held for the full response lifetime.

Org resolution:
  1. ``{org_id}`` path parameter (the canonical pattern for
     ``/orgs/{org_id}/...`` routes — the router has already
     matched the URL by the time middleware sees it).
  2. ``X-Org-Id`` header (used by API key + some cookie flows).
  3. ``org_id`` parsed from the ``authorization`` cookie via the
     legacy JWT decoder.

Failures on the GUC side are swallowed (logged at WARNING).
A DB blip on the ``set_config`` should never poison the request
— the ``set_session_org_context`` helper already swallows
``Exception`` internally, so a successful invocation is
necessary but missing-GUC is fail-safe (RLS returns NULL →
empty row set → no data leak).

Request-scoped connection helper — see
:func:`get_request_pg_conn` in this module. Routes that touch
RLS-protected tables should use it instead of
``client.execute(...)`` so the same pooled connection that
holds the GUC is the one issuing the query.

Streaming responses (HIGH fix, 2026-07-27 deep-audit):
  Pre-fix, ``await self.app(scope, receive, send)`` did not return
  until the ENTIRE downstream response finished — including a
  long-lived ``StreamingResponse``/SSE body (e.g.
  ``/orgs/{org_id}/ai/chat``). That held the pinned pool
  connection + open transaction for the whole streaming session
  instead of just the synchronous request-handling work, colliding
  with ``idle_in_transaction_session_timeout`` (~60s) and risking
  pool exhaustion (default pool size 10-20) under a handful of
  concurrent SSE sessions.

  Fix: the ``send`` callable passed to the downstream app is
  wrapped so the FIRST ``http.response.start`` message triggers
  ``_finalize_pg_context`` — commit + release/close — BEFORE that
  message (and therefore any following ``http.response.body``
  chunks) is forwarded. By the time a route handler has produced a
  response object (streaming or not), all of the RLS-scoped
  synchronous DB work it needed is already done; only body
  transmission remains, which for a stream can run for minutes.
  Releasing here returns the connection to the pool well before
  the SSE body starts sending chunks. A route that needs DB access
  *during* the stream body itself must acquire its own short-lived
  connection per call (e.g. ``get_postgres_client()`` /
  ``client.fetch(...)``) rather than relying on this request-wide
  pin, which is no longer valid once the response has started.
  ``request.state.pg_conn`` is cleared to ``None`` at finalize time
  precisely so such a route fails loudly (AttributeError-ish
  ``None`` deref or an explicit ``is not None`` check) instead of
  silently reusing a connection that may already be back in the
  pool serving a different tenant.

  ``_finalize_pg_context`` is idempotent (guarded by
  ``request.state._pg_finalized``) so the early release above and
  the ``finally`` fallback in ``__call__`` (still needed for the
  case where the downstream app never sends a response at all,
  e.g. it raises before any ASGI message goes out) never
  double-release the same connection.

Audit 2026-07-06 — converted from BaseHTTPMiddleware to pure ASGI.
Still constructs ``Request(scope, receive)`` so helpers and
``request.state.pg_conn`` pinning keep working.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from fastapi import Request
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger(__name__)


class RLSOrgContextMiddleware:
    """Set the RLS ``app.current_org_id`` GUC for the current
    request transaction.

    Single chokepoint (audit risk: "one miss = silent policy
    bypass") — every tenant-scoped table hits Postgres with
    the GUC set, so even if a new route forgets to filter by
    ``org_id`` in its WHERE clause the migration-015 RLS
    policies will.

    Audit 2026-07-06 — pure ASGI ``__call__`` (no ``BaseHTTPMiddleware``).
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Request shim — same pattern as TenantRateLimitMiddleware.
        # Helpers and ``request.state.pg_conn`` pin need a Request.
        request = Request(scope, receive)

        org_id = await self._resolve_org_id(request)
        bind_token = None
        if org_id:
            try:
                # Lazy import to avoid a cycle: storage.postgres
                # imports eden.config, which transitively loads
                # app.py during settings validation.
                from eden.storage.postgres import (
                    RequestConnLease,
                    bind_request_pg_lease,
                    get_postgres_client,
                )

                # Path / Clerk / header may carry a Clerk org id
                # (``org_…``). Telemetry tenant_id is the Eden UUID —
                # resolve so FORCE RLS matches stored rows.
                try:
                    from eden.api.deps import resolve_eden_org_id

                    resolved = await resolve_eden_org_id(str(org_id))
                    if resolved:
                        org_id = resolved
                except Exception as resolve_exc:  # noqa: BLE001
                    logger.debug(
                        "RLSOrgContextMiddleware: org resolve skipped: %s",
                        resolve_exc,
                    )

                client = await get_postgres_client()
                if client._pool is None:
                    await client.initialize()
                if client._pool is not None:
                    # Lazy lease: construct + bind only. Pool checkout,
                    # BEGIN, and SET LOCAL happen on first query via
                    # ``RequestConnLease.ensure`` (see postgres.py).
                    # Requests that never touch Postgres pay ~7 us
                    # instead of a full pin+GUC round trip.
                    def _on_materialize(
                        conn: Any,
                        conn_ctx: Any,
                        tx: Any,
                        tx_entered: bool,
                    ) -> None:
                        request.state.pg_conn = conn
                        request.state._pg_tx = tx
                        request.state._pg_tx_entered = tx_entered
                        request.state._pg_conn_ctx = conn_ctx

                    lease = RequestConnLease(
                        str(org_id),
                        client,
                        on_materialize=_on_materialize,
                    )
                    bind_token = bind_request_pg_lease(lease)
                    request.state._pg_bind_token = bind_token
                    request.state._pg_lease = lease
            except Exception as exc:
                # Fail-soft: the RLS policies treat a missing
                # GUC as ``NULL`` → empty row set, which is the
                # *safe* default. We log at WARNING so the on
                # call sees the DB blip but the request still
                # serves a clean 403/200.
                logger.warning(
                    "RLSOrgContextMiddleware: failed to set "
                    "app.current_org_id for org %s: %s",
                    org_id, exc,
                )

        if getattr(request.state, "_pg_bind_token", None) is None:
            # No lease was bound for this request (anonymous
            # request, pool unavailable, or the setup above failed) —
            # skip the send-wrapping machinery entirely.
            await self.app(scope, receive, send)
            return

        finalized = False

        async def send_wrapper(message: dict) -> None:
            nonlocal finalized
            if message["type"] == "http.response.start" and not finalized:
                # HIGH fix: release the pinned connection/commit the
                # transaction the moment the response headers are
                # ready — i.e. before the FIRST body chunk (streaming
                # or not) is forwarded — instead of holding it for the
                # entire response lifetime (which, for a
                # StreamingResponse/SSE body, can be minutes).
                finalized = True
                await self._finalize_pg_context(request)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            # Fallback: covers the case where the downstream app never
            # sent a single ASGI message (e.g. it raised before
            # producing any response) so the early-release hook in
            # ``send_wrapper`` never fired. Idempotent — a no-op if
            # ``send_wrapper`` already finalized.
            await self._finalize_pg_context(request)

    @staticmethod
    async def _release_pg_resources(
        *,
        conn: Any | None,
        tx: Any | None,
        tx_entered: bool,
        conn_ctx: Any | None,
    ) -> None:
        """Commit the transaction and release the connection — or, if
        the connection is suspected broken, close it explicitly
        instead of routing it through the ordinary pool-release path.

        LOW-MEDIUM fix: previously the caller unconditionally called
        ``tx.__aexit__(None, None, None)`` even when ``tx.__aenter__``
        (BEGIN) itself had raised — silently swallowing the resulting
        ``InterfaceError`` — and then still handed the (possibly
        broken) connection back to the pool through the normal release
        path with no health check. ``tx_entered`` tracks whether BEGIN
        actually completed: only then is ``tx.__aexit__`` meaningful
        (it attempts COMMIT). If BEGIN never completed, or the
        commit/rollback attempt itself fails, treat the underlying
        connection as suspect and close it directly rather than
        trusting the ordinary release path to notice — asyncpg detaches
        the pool's connection proxy on ``close()``/``terminate()``
        (``PoolConnectionHolder._release_on_close``), so the pool slot
        is still freed correctly and a subsequent
        ``conn_ctx.__aexit__()`` becomes a safe no-op.
        """
        conn_broken = False
        if tx is not None:
            if tx_entered:
                try:
                    await tx.__aexit__(None, None, None)
                except Exception as exc:
                    logger.debug("RLS tx commit failed (non-fatal): %s", exc)
                    conn_broken = True
            else:
                # BEGIN never completed — nothing to commit/rollback,
                # and a failed BEGIN is itself a strong signal that the
                # underlying connection is unhealthy.
                conn_broken = True

        if conn_broken and conn is not None:
            with contextlib.suppress(Exception):
                await conn.close()

        if conn_ctx is not None:
            with contextlib.suppress(Exception):
                await conn_ctx.__aexit__(None, None, None)

    @staticmethod
    async def _finalize_pg_context(request: Request) -> None:
        """Commit + release/close the pinned connection exactly once
        for this request.

        Idempotent (HIGH fix): guarded by
        ``request.state._pg_finalized`` so the early release fired
        from ``send_wrapper`` (before a StreamingResponse body starts
        sending chunks) and the ``finally`` fallback in ``__call__``
        never double-release the same connection.

        Shielded from cancellation (MEDIUM fix): the previous
        cleanup only caught ``Exception``, not ``asyncio.CancelledError``
        (a ``BaseException`` since Python 3.8) — if the request task is
        cancelled (client disconnect) exactly while a cleanup await is
        in flight, cancellation would abort that step instead of being
        handled, potentially leaking the connection mid-transaction.
        ``asyncio.shield`` runs the commit/release/close sequence as a
        separate task: if THIS task is cancelled while awaiting it, the
        cancellation only interrupts the wait here — the shielded
        cleanup keeps running to completion in the background — and we
        re-raise so the enclosing task's cancellation is still honored.

        ``reset_request_pg_conn(token)`` deliberately runs OUTSIDE the
        shield, directly in this coroutine (BUG FIX, 2026-07-27): a
        ``contextvars.Token`` is only valid for ``.reset()`` in the
        exact ``contextvars.Context`` it was created in.
        ``asyncio.shield(coro)`` wraps a bare coroutine in a brand-new
        ``asyncio.Task``, which runs in a *copy* of the current
        Context — not the request's own Context — so calling
        ``reset_request_pg_conn`` from inside the shielded coroutine
        raised ``ValueError: <Token ...> was created in a different
        Context`` on every request that pinned a connection. That
        ``ValueError`` was swallowed by a bare ``except Exception`` at
        ``logger.debug``, so the contextvar was silently never reset on
        the request's own task — ``postgres.get_bound_request_pg_conn()``
        kept returning the released (and potentially already
        recycled-to-a-different-tenant) connection to any code running
        later in the same task, reintroducing the exact cross-tenant
        connection reuse bug class the ``copy_context_without_
        request_pg_conn`` fix in ``webhook_delivery.py`` exists to
        prevent, via a different path. The reset must happen in THIS
        task/Context, so it cannot be inside the shielded coroutine —
        only the tx.__aexit__ / conn.close() / conn_ctx.__aexit__
        sequence (which doesn't touch the contextvar at all) needs
        shielding against cancellation.
        """
        state = request.state
        if getattr(state, "_pg_finalized", False):
            return
        state._pg_finalized = True

        token = getattr(state, "_pg_bind_token", None)
        lease = getattr(state, "_pg_lease", None)

        # Close the lease BEFORE reading materialization resources.
        # ``RequestConnLease.close`` serialises against ``ensure`` so a
        # racing late redemption cannot check out a connection that
        # this finalizer will never release.
        if lease is not None:
            try:
                await lease.close()
            except Exception as exc:
                logger.debug("RLS lease close failed (non-fatal): %s", exc)

        tx = getattr(state, "_pg_tx", None)
        tx_entered = getattr(state, "_pg_tx_entered", False)
        ctx = getattr(state, "_pg_conn_ctx", None)
        conn = getattr(state, "pg_conn", None)

        if token is None and tx is None and ctx is None and lease is None:
            return

        # Clear the pinned connection up front so a route that grabbed
        # a reference to ``request`` (e.g. mid-stream, from inside a
        # StreamingResponse body iterator) sees ``None`` rather than a
        # connection that may already be back in the pool serving a
        # different tenant. Routes needing DB access during a stream
        # must acquire their own short-lived connection instead.
        state.pg_conn = None
        state._pg_lease = None

        # Reset the bind contextvar directly in THIS Context — unshielded,
        # on the request's own task — BEFORE the shielded release below.
        # Must run here (not inside ``asyncio.shield``, which executes in
        # a copied Context where the token is invalid) and must run
        # before the underlying connection is actually closed/released
        # back to the pool, so no window exists where
        # ``get_bound_request_pg_conn()`` could still return a connection
        # that a concurrent step elsewhere has already begun recycling.
        if token is not None:
            try:
                from eden.storage.postgres import reset_request_pg_conn

                reset_request_pg_conn(token)
            except Exception as exc:
                logger.debug("RLS bind reset failed (non-fatal): %s", exc)

        async def _do_cleanup() -> None:
            await RLSOrgContextMiddleware._release_pg_resources(
                conn=conn, tx=tx, tx_entered=tx_entered, conn_ctx=ctx,
            )

        try:
            await asyncio.shield(_do_cleanup())
        except asyncio.CancelledError:
            # The shielded cleanup task keeps running to completion
            # even though our own await was interrupted — re-raise so
            # this task's cancellation is still honored by its caller.
            raise

    @staticmethod
    async def _has_verified_identity(request: Request) -> bool:
        """True iff THIS request already carries a cryptographically
        verified identity: Eden-issued cookie JWT, Clerk Bearer JWT,
        or a hash-verified ``X-Org-Api-Key``.

        CRITICAL fix (2026-07-27 finding): ``_resolve_org_id`` used to
        return the raw ``X-Org-Id`` header verbatim with zero proof
        that it belongs to the caller. ``DefaultDenyAuthMiddleware``
        (even executing first, post C1) only checks that *some*
        credential-shaped value is present — it never verifies a
        signature — so a request with e.g. ``Authorization: Bearer
        garbage`` + ``X-Org-Id: <victim-org>`` sails past that gate
        and would previously have this middleware trust the header
        outright. This check is the actual signature verification
        gate that the header branch below is conditioned on, so the
        gap is closed regardless of middleware registration order.

        CRITICAL regression fix (2026-07-27, follow-up): the first
        cut of this method only recognized cookie-JWT and Clerk
        Bearer-JWT, NOT ``X-Org-Api-Key`` — a third, fully legitimate,
        cryptographically-verified auth mechanism (SHA-256 hash
        lookup against ``org_api_keys.key_hash``, scoped to the same
        org_id; see ``get_current_org_api_key`` /
        ``_ingestion_auth_impl`` in ``eden.api.deps``). The AI Gateway
        (``gateway.router``, mounted at ``/gateway/v1`` with no
        ``{org_id}`` path param) authenticates purely via
        ``X-Org-Api-Key`` + ``X-Org-Id`` — so for that entire traffic
        class ``_resolve_org_id`` always returned ``None`` post-fix,
        silently disabling RLS org context for legitimately
        authenticated, key-verified requests (the exact bug class
        this middleware exists to prevent). The API-key branch below
        closes that gap.

        Cheap re-entry: checks ``request.state`` first in case a
        verified payload is already cached there (``eden_jwt_payload``
        by ``eden.api.deps._resolve_token_payload``,
        ``clerk_jwt_payload`` by
        ``eden.api.utils.clerk_auth.verify_clerk_token_for_request``,
        or ``org_api_key_row`` set by this method itself below — all
        three stash the verified result on ``request.state`` precisely
        so the same credential is not re-verified several times per
        call). Falls back to verifying inline (same cookie-decode /
        Clerk-JWKS / API-key hash-lookup calls the branches below and
        in ``_resolve_org_id`` make) when nothing is cached yet.
        """
        state = getattr(request, "state", None)
        if state is not None:
            for attr in ("eden_jwt_payload", "clerk_jwt_payload", "org_api_key_row"):
                cached = getattr(state, attr, None)
                if isinstance(cached, dict) and cached:
                    return True

        # Nothing cached — try the legacy Eden cookie (signature
        # verified inside ``decode_access_token``).
        cookie = request.cookies.get("authorization")
        if cookie:
            try:
                from eden.api.utils.auth import decode_access_token

                payload = decode_access_token(cookie)
                if payload:
                    if state is not None:
                        with contextlib.suppress(Exception):
                            state.eden_jwt_payload = payload
                    return True
            except Exception:
                pass

        # Try a Clerk Bearer (JWKS-verified inside
        # ``verify_clerk_token_for_request``, which caches its own
        # result on ``request.state.clerk_jwt_payload``).
        auth_header = request.headers.get("authorization")
        if auth_header and auth_header.lower().startswith("bearer "):
            try:
                from eden.api.utils.clerk_auth import (
                    verify_clerk_token_for_request,
                )

                clerk_payload = await verify_clerk_token_for_request(
                    request, auth_header[7:].strip()
                )
                if clerk_payload:
                    return True
            except Exception:
                pass

        # Try X-Org-Api-Key + X-Org-Id (gateway / ingest traffic
        # class). Real verification — a SHA-256 hash lookup against
        # ``org_api_keys.key_hash`` scoped to this exact org_id, plus
        # active/revoked/expires checks — via the same
        # ``get_current_org_api_key`` helper the FastAPI auth
        # dependencies use (``eden.api.deps._ingestion_auth_impl``).
        # Reused rather than reimplemented so a key considered valid
        # by the route's own auth dependency is treated identically
        # here (and vice versa): a disabled/revoked/expired/unknown
        # key raises ``HTTPException`` from that helper, which we
        # catch and treat as "not verified" — presence of the header
        # alone proves nothing.
        api_key = request.headers.get("x-org-api-key")
        header_org_for_key = request.headers.get("x-org-id")
        if api_key and header_org_for_key:
            try:
                from eden.api.deps import get_current_org_api_key

                org_row = await get_current_org_api_key(header_org_for_key, api_key)
                if org_row:
                    if state is not None:
                        with contextlib.suppress(Exception):
                            state.org_api_key_row = org_row
                    return True
            except Exception:
                pass

        return False

    @staticmethod
    async def _resolve_org_id(request: Request) -> str | None:
        """Pull org_id from path params, header, or auth cookie.

        Same precedence as ``QuotaEnforcementMiddleware`` —
        keep them in sync so quota and RLS agree on the tenant.
        """
        # 1. Path parameter — handles ``/orgs/{org_id}/...``
        # for routes mounted under the major routers.
        if "org_id" in request.path_params:
            return request.path_params["org_id"]

        # 2. ``X-Org-Id`` header — used by API key flows and
        # some portal flows that don't have the path param.
        #
        # CRITICAL defense-in-depth fix: a raw client header is
        # NEVER trusted as the RLS tenant boundary on its own — an
        # unauthenticated (or forged-Bearer) caller can set this to
        # anything. Only use it once this request has an
        # independently verified identity (see
        # ``_has_verified_identity`` above — cookie JWT, Clerk Bearer
        # JWT, or a hash-verified ``X-Org-Api-Key`` all count,
        # covering the gateway/ingest traffic class that has no
        # ``{org_id}`` path param and no cookie/Bearer). If nothing
        # verified the caller yet, org_id stays unresolved here and we
        # fall through to the cookie / Clerk-Bearer branches below,
        # which verify inline — we never return the header verbatim.
        header_org = request.headers.get("x-org-id")
        if header_org:
            if await RLSOrgContextMiddleware._has_verified_identity(request):
                return header_org
            logger.warning(
                "RLSOrgContextMiddleware: ignoring X-Org-Id=%s — no "
                "verified identity (cookie/Clerk Bearer/X-Org-Api-Key) "
                "on this request; refusing to trust an unauthenticated "
                "header as the RLS tenant boundary",
                header_org,
            )

        # 3. ``authorization`` cookie — decode via the legacy
        # JWT helper; the cookie has ``current_org_id`` set
        # during login.
        cookie = request.cookies.get("authorization")
        if cookie:
            try:
                from eden.api.utils.auth import decode_access_token

                payload = decode_access_token(cookie)
                if payload:
                    return payload.get("current_org_id")
            except Exception:
                pass

        # 4. Clerk Bearer — portal forwards session JWT; carries ``o.id``.
        auth_header = request.headers.get("authorization")
        if auth_header and auth_header.lower().startswith("bearer "):
            try:
                from eden.api.utils.clerk_auth import (
                    extract_org_id,
                    verify_clerk_token_for_request,
                )

                clerk_payload = await verify_clerk_token_for_request(
                    request, auth_header[7:].strip()
                )
                if clerk_payload:
                    return extract_org_id(clerk_payload)
            except Exception:
                pass

        return None


def get_request_pg_conn(request: Request) -> Any | None:
    """Return the per-request asyncpg connection pinned by
    :class:`RLSOrgContextMiddleware`, or ``None`` if no GUC
    was set (e.g. unauthenticated request, or pool unavailable).

    Usage in a route handler::

        @router.get("/orgs/{org_id}/secrets")
        async def list_secrets(
            request: Request,
            org_id: str,
            user: dict = Depends(get_current_user),
        ):
            conn = get_request_pg_conn(request)
            if conn is not None:
                # RLS-filtered query: the same conn that holds
                # ``app.current_org_id`` is the one issuing this.
                rows = await conn.fetch(
                    "SELECT * FROM secrets WHERE org_id = $1",
                    org_id,
                )
            else:
                # Fallback to pool — RLS may not apply (best-effort).
                client = await get_postgres_client()
                rows = await client.fetch(
                    "SELECT * FROM secrets WHERE org_id = $1",
                    org_id,
                )

    Returns ``None`` if the middleware did not pin a connection
    for this request. Callers should always fall back to the
    default ``client.execute(...)`` path; ``WHERE org_id = $1``
    remains the primary defence.

    NOTE: once the response has started (headers sent), the
    middleware releases/closes this connection even if the response
    body is still streaming (see the "Streaming responses" section
    in the module docstring) — this helper will then return ``None``.
    A route that needs DB access from inside a streaming body must
    acquire its own short-lived connection per call instead of
    relying on this request-wide pin.
    """
    return getattr(request.state, "pg_conn", None)
