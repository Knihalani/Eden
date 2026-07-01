"""B-1 fix — RLS GUC middleware.

The migration-015 Row-Level Security policies read
``current_setting('app.current_org_id', true)`` to filter rows
on the observability/retention/audit tables. The previous
state: ``set_session_org_context`` was implemented but never
invoked from any production route — RLS policies were
inactive on every request (defence in depth, but not actually
defending).

This middleware closes the gap by firing the GUC on every
request that can resolve an ``org_id``. Org resolution:

1. ``{org_id}`` path parameter (the canonical pattern for
   ``/orgs/{org_id}/...`` routes — the router has already
   matched the URL by the time middleware sees it).
2. ``X-Org-Id`` header (used by API key + some cookie flows).
3. ``org_id`` parsed from the ``authorization`` cookie via the
   legacy JWT decoder.

Failures are swallowed (logged at WARNING). A DB blip on the
``set_config`` should never poison the request — the
``:func:set_session_org_context` helper already swallows
``Exception`` internally, so a successful invocation is
necessary but missing-GUC is fail-safe (RLS returns NULL →
empty row set → no data leak).
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from eden.storage.postgres import set_session_org_context

logger = logging.getLogger(__name__)


class RLSOrgContextMiddleware(BaseHTTPMiddleware):
    """Set the RLS ``app.current_org_id`` GUC for the current
    request transaction.

    Single chokepoint (audit risk: "one miss = silent policy
    bypass") — every tenant-scoped table hits Postgres with
    the GUC set, so even if a new route forgets to filter by
    ``org_id`` in its WHERE clause the migration-015 RLS
    policies will.
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        org_id = await self._resolve_org_id(request)
        if org_id:
            try:
                # Lazy import to avoid a cycle: storage.postgres
                # imports eden.config, which transitively loads
                # app.py during settings validation.
                from eden.storage.postgres import get_postgres_client

                client = await get_postgres_client()
                await set_session_org_context(client, org_id)
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
        return await call_next(request)

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
        # during login. We avoid Clerk here — the dual-mode
        # Clerk+JWT path lives in ``deps.py``, and Clerk
        # tokens don't carry an org context.
        cookie = request.cookies.get("authorization")
        if cookie:
            try:
                from eden.api.utils.auth import decode_access_token

                payload = decode_access_token(cookie)
                if payload:
                    return payload.get("current_org_id")
            except Exception:
                pass

        return None
