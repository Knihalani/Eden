"""App/site events ingestion (Phase A1, 2026-06-19).

``POST /orgs/{org_id}/ingest/app`` — high-volume batch endpoint for
app/site events from the ``@eden/sdk/browser`` SDK (and the React /
Next.js / React Native SDKs).

Backed by ``AppEventsService`` in
:mod:`eden.services.app_intel.events`. The events land in the
``app_events`` table (migration 036) and are joined to
``telemetry_events`` via ``trace_id`` on read.

Auth: ``X-Org-Id`` + ``X-Org-Api-Key`` headers (same as the other
``/ingest/*`` endpoints). Rate limit: per-tenant in-process sliding
window, separate cap from the agent telemetry ingest
(``settings.app_ingest_per_tenant_rpm``, default 5000/min).
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field, field_validator

from eden.api.deps import get_ingestion_auth
from eden.config import get_settings
from eden.services.app_intel import MAX_BATCH, AppEventsService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/ingest", tags=["app-ingest"])


# ── Per-tenant rate limiter ───────────────────────────────────────────
# Higher cap than the agent ingest path because browser SDKs flush
# events in batches; operators tune via Settings.

_rate_buckets: dict[str, deque[float]] = defaultdict(deque)


def _check_rate_limit(org_id: str) -> None:
    s = get_settings()
    cap = getattr(s, "app_ingest_per_tenant_rpm", 5000)
    if cap <= 0:
        return
    now = time.monotonic()
    window = 60.0
    bucket = _rate_buckets[org_id]
    while bucket and bucket[0] < now - window:
        bucket.popleft()
    if len(bucket) >= cap:
        retry_after = max(1, int(bucket[0] + window - now))
        raise HTTPException(
            status_code=429,
            detail=(
                f"App ingest rate limit exceeded for org {org_id} "
                f"({cap} req/min)"
            ),
            headers={"Retry-After": str(retry_after)},
        )
    bucket.append(now)


# ── Request / response models ──────────────────────────────────────────


class AppEvent(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    ts: datetime
    properties: dict[str, Any] | None = None
    trace_id: str | None = Field(default=None, max_length=128)
    session_id: str | None = Field(default=None, max_length=64)
    user_id: str | None = Field(default=None, max_length=128)
    source: str = Field(default="browser", max_length=16)

    @field_validator("source")
    @classmethod
    def _check_source(cls, v: str) -> str:
        if v not in {"browser", "server", "mobile"}:
            raise ValueError("source must be browser|server|mobile")
        return v


class AppEventsBatch(BaseModel):
    events: list[AppEvent] = Field(..., min_length=1)


class IngestResponse(BaseModel):
    accepted: int
    rejected: int
    total: int
    source_format: str = "app_events"


# ── Route ─────────────────────────────────────────────────────────────


@router.post("/app", response_model=IngestResponse)
async def ingest_app_events(
    org_id: str = Path(...),
    body: AppEventsBatch = ...,
    auth_ctx: dict = Depends(get_ingestion_auth),
) -> IngestResponse:
    _check_rate_limit(org_id)

    # Defence in depth — the path is the source of truth.
    if auth_ctx.get("org_id") and auth_ctx["org_id"] != org_id:
        raise HTTPException(status_code=403, detail="org mismatch")

    if len(body.events) > MAX_BATCH:
        raise HTTPException(
            status_code=400,
            detail=f"batch too large (max {MAX_BATCH})",
        )

    events_dicts = [e.model_dump(mode="json") for e in body.events]
    # serialise datetime as ISO 8601
    for e in events_dicts:
        if isinstance(e.get("ts"), datetime):
            e["ts"] = e["ts"].isoformat()

    svc = AppEventsService()
    result = await svc.ingest_batch(org_id, events_dicts)
    return IngestResponse(**result)
