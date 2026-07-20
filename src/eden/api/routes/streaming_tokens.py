"""Streaming tokens API — D.8 (§C.1).

Per-trace token list endpoint used by the portal trace
detail UI to render the per-token sparkline + flag stalls.

Routes:

* ``GET /orgs/{org_id}/traces/{trace_id}/tokens`` — return
  every captured token for the trace, ordered by
  ``(span_id, token_index)``.

The gateway SSE/WebSocket ingest endpoint calls
:class:`StreamingTokenCapture.write_batch` directly
(in-process); this HTTP route is the read side for the
portal.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    resolve_path_org_access,
)
from eden.sdk.streaming import StreamingTokenCapture

logger = logging.getLogger(__name__)


async def _require_path_org(
    org_id: str = Path(..., description="Organization ID"),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> str:
    _, eden_org = await resolve_path_org_access(org_id, user, payload)
    return eden_org


router = APIRouter(
    prefix="/orgs/{org_id}/traces",
    tags=["streaming-tokens"],
    dependencies=[Depends(_require_path_org)],
)


@router.get("/{trace_id}/tokens")
async def list_trace_tokens(
    org_id: str = Depends(_require_path_org),
    trace_id: str = Path(...),
    limit: int = Query(5000, ge=1, le=50000),
) -> dict[str, Any]:
    """Return every captured token for the trace.

    The portal renders this as a per-token sparkline + a
    stall summary. The response shape is stable: a flat
    list of token dicts with the columns the portal reads
    directly (no envelope wrapping the inner data so the
    client doesn't have to double-unwrap).
    """
    capture = StreamingTokenCapture()
    tokens = await capture.list_tokens(
        trace_id, org_id=org_id, limit=limit
    )
    return {
        "status": "ok",
        "feature": "streaming_tokens",
        "live": True,
        "data": {
            "trace_id": trace_id,
            "tokens": tokens,
            "count": len(tokens),
        },
    }
