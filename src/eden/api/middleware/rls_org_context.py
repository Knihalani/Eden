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
6. Committing the transaction and releasing the connection
   on response completion (success OR error path).

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

Audit 2026-07-06 — converted from BaseHTTPMiddleware to pure ASGI.
Still constructs ``Request(scope, receive)`` so helpers and
``request.state.pg_conn`` pinning keep working.
"""

from __future__ import annotations

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
        conn_ctx = None
        tx = None
        bind_token = None
        if org_id:
            try:
                # Lazy import to avoid a cycle: storage.postgres
                # imports eden.config, which transitively loads
                # app.py during settings validation.
                from eden.storage.postgres import (
                    bind_request_pg_conn,
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
                    # Pin ONE pooled connection for this request so
                    # the GUC set in the SET LOCAL transaction is
                    # the same connection the route handler's queries
                    # use. We acquire manually (not via
                    # ``client.execute`` which would acquire+release
                    # on each call) and commit/release in the
                    # ``finally`` below.
                    conn_ctx = client._pool.acquire()
                    conn = await conn_ctx.__aenter__()
                    tx = conn.transaction()
                    await tx.__aenter__()
                    # SET LOCAL inside the open transaction. When
                    # we commit below the GUC reverts — the desired
                    # scoping.
                    await conn.execute(
                        "SELECT set_config('app.current_org_id', $1::text, true)",
                        str(org_id),
                    )
                    # Stash for routes that want RLS-correct queries.
                    request.state.pg_conn = conn
                    request.state._pg_tx = tx
                    request.state._pg_conn_ctx = conn_ctx
                    # Also bind via contextvar so PostgresClient.fetch
                    # / execute / acquire reuse this connection without
                    # every route switching to get_request_pg_conn.
                    bind_token = bind_request_pg_conn(conn)
                    request.state._pg_bind_token = bind_token
                    # Mark these as live so the finally knows whether
                    # to clean up.
                    conn_ctx = None
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
                # Best-effort cleanup if we partially acquired.
                if tx is not None:
                    with contextlib.suppress(Exception):
                        await tx.__aexit__(None, None, None)
                if conn_ctx is not None:
                    with contextlib.suppress(Exception):
                        await conn_ctx.__aexit__(None, None, None)

        try:
            await self.app(scope, receive, send)
        finally:
            # Commit the transaction so the SET LOCAL GUC reverts
            # and the connection is returned to the pool clean.
            # Without this the pinned connection would hold row
            # locks + a stale GUC for the next request.
            token = getattr(request.state, "_pg_bind_token", None)
            if token is not None:
                try:
                    from eden.storage.postgres import reset_request_pg_conn

                    reset_request_pg_conn(token)
                except Exception as exc:
                    logger.debug("RLS bind reset failed (non-fatal): %s", exc)
            tx = getattr(request.state, "_pg_tx", None)
            ctx = getattr(request.state, "_pg_conn_ctx", None)
            if tx is not None:
                try:
                    await tx.__aexit__(None, None, None)
                except Exception as exc:
                    logger.debug("RLS tx commit failed (non-fatal): %s", exc)
            if ctx is not None:
                try:
                    await ctx.__aexit__(None, None, None)
                except Exception as exc:
                    logger.debug("RLS conn release failed (non-fatal): %s", exc)

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
        header_org = request.headers.get("x-org-id")
        if header_org:
            return header_org

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
    """
    return getattr(request.state, "pg_conn", None)
