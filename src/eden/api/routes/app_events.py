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

from eden.api.utils.redact import redact_all
import logging
import time
from collections import OrderedDict, deque
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field, field_validator

from eden.api.deps import get_ingest_auth
from eden.config import get_settings
from eden.services.app_intel import MAX_BATCH, AppEventsService

logger = logging.getLogger(__name__)

# Auth is ``get_ingest_auth`` only (API key or session cookie) — not
# ``require_path_org_access``, which depends on Clerk ``get_current_user``
# and would 401 valid ``X-Org-Api-Key`` browser-SDK callers before
# ingest auth runs. Mirrors ``ingestion.py`` / telemetry ingest.
router = APIRouter(prefix="/orgs/{org_id}/ingest", tags=["app-ingest"])


def _assert_ingest_org(auth_ctx: dict, org_id: str) -> str:
    """Reject path/auth org mismatches; return the authenticated org id."""
    auth_org = auth_ctx.get("org_id")
    if not auth_org or str(auth_org) != str(org_id):
        raise HTTPException(
            status_code=403,
            detail="Path org_id does not match authenticated org",
        )
    return str(auth_org)


# ── Per-tenant rate limiter ───────────────────────────────────────────
# Higher cap than the agent ingest path because browser SDKs flush
# events in batches; operators tune via Settings.
#
# F63 — ``_rate_buckets`` is now an ``OrderedDict`` keyed by
# ``org_id`` with a hard cap and a TTL. Same pattern as the
# agent-telemetry ingest path
# (``eden.api.routes.ingestion._rate_buckets``). See the
# F63 entry in ``FIXES_LOG.md`` for the full reasoning.
#
# Pre-F63 the dict grew unbounded against unique-tenant
# browser-SDK traffic: a single malicious page could
# register under a fresh ``X-Org-Id`` on every request,
# creating a new entry with each call and never freeing
# the old one. The deque values are cheap but the keys
# live forever — long-running pods accumulate stale
# org_id entries for every tenant who ever sent a single
# event.

_rate_buckets: OrderedDict[str, deque[float]] = OrderedDict()
_MAX_RATE_BUCKETS: int = 4096
_RATE_WINDOW_SECONDS: float = 60.0


def _touch_bucket(org_id: str) -> None:
    """Bump the LRU position for an org's rate-limit bucket.

    Pure housekeeping. Best-effort: any exception inside
    the OrderedDict rewrite is silently dropped so a
    transient bookkeeping issue cannot break a paying
    customer's API call. Mirrors
    ``ingestion._touch_bucket`` and ``multi_agent._touch_env``
    (F61)."""
    try:
        if org_id in _rate_buckets:
            _rate_buckets.move_to_end(org_id)
    except Exception:
        pass


def _evict_idle_buckets(now: float) -> None:
    """Drop buckets whose sliding window is empty AND
    whose last access predates ``now - _RATE_WINDOW_SECONDS``.

    Pre-F63 nothing reaped idle tenants — the deque
    values auto-collapsed to empty on a window-expiry
    but the key itself lived in the dict forever."""
    cutoff = now - _RATE_WINDOW_SECONDS
    stale: list[str] = []
    for org_id, bucket in _rate_buckets.items():
        if not bucket or bucket[-1] < cutoff:
            stale.append(org_id)
    for org_id in stale:
        _rate_buckets.pop(org_id, None)


def _enforce_rate_buckets_cap(org_id: str) -> None:
    """Enforce the hard cap on ``_rate_buckets``.

    Drops the least-recently-touched org until the size
    is back under the limit. The new org always succeeds
    — only older ones are evicted. Mirrors
    ``multi_agent._enforce_cap_on_insert`` (F61)."""
    while len(_rate_buckets) >= _MAX_RATE_BUCKETS:
        try:
            _rate_buckets.popitem(last=False)
        except KeyError:
            break


def _check_rate_limit(org_id: str) -> None:
    s = get_settings()
    cap = getattr(s, "app_ingest_per_tenant_rpm", 5000)
    if cap <= 0:
        return
    now = time.monotonic()
    window = _RATE_WINDOW_SECONDS
    # F63: opportunistic housekeeping on the hot path.
    # Both sweeps are O(buckets) and run in microseconds
    # for the healthy multi-tenant case (< 100 entries).
    _evict_idle_buckets(now)
    _enforce_rate_buckets_cap(org_id)
    bucket = _rate_buckets.get(org_id)
    if bucket is None:
        bucket = deque()
        _rate_buckets[org_id] = bucket
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
    # F63: bump LRU so an active tenant survives the cap
    # eviction triggered by a churning one-shot tenant.
    _touch_bucket(org_id)


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
    org_id: str = Path(..., description="Organization ID"),
    body: AppEventsBatch = ...,
    auth_ctx: dict = Depends(get_ingest_auth),
) -> IngestResponse:
    org_id = _assert_ingest_org(auth_ctx, org_id)
    _check_rate_limit(org_id)

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
    try:
        result = await svc.ingest_batch(org_id, events_dicts)
    except Exception as exc:
        # Service normally soft-rejects rows; unexpected faults → 503
        # so SDKs retry instead of treating a bare 500 as fatal.
        from eden.api.utils.safe_error import safe_detail

        logger.exception("app ingest failed for org %s: %s", org_id, redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(
                exc,
                fallback="App ingest temporarily unavailable; retry after backoff",
            ),
            headers={"Retry-After": "5"},
        ) from exc
    return IngestResponse(**result)
