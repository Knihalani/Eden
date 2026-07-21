"""Phase 7.0 — Multi-Format Telemetry Ingestion endpoints.

Nine POST endpoints, one per supported source format, plus a generic
webhook catch-all. All share the same handler shape::

    POST /orgs/{org_id}/ingest/{format}
        Headers:
            X-Org-Id:         <org>      (must match URL)
            X-Org-Api-Key:    <key>      (programmatic auth)
            X-Project-Id:     <proj>     (optional; default "default")
            X-Source-Format:  <fmt>      (only for /ingest/webhook)
            X-Source-Framework: <name>   (only for /ingest/framework)
            Content-Type:     application/json | application/x-otel-protobuf
            Content-Encoding: gzip (optional; SDKs compress JSON bodies)
        Body:
            format-specific JSON (or OTLP protobuf for /ingest/otel);
            may be gzip-compressed when Content-Encoding is gzip
        Response:
            {accepted, rejected, deduplicated, total, source_format}

Auth: ``get_ingestion_auth`` (Phase 7.0) — accepts either API key
(``X-Org-Api-Key``) or cookie JWT. The path ``org_id`` is the source
of truth; the ``X-Org-Id`` header must match (defence in depth).

Rate limit: a per-tenant in-process sliding window keyed by
``f"ingestion:{org_id}"`` with cap ``settings.ingestion_per_tenant_rpm``.
This is a tighter cap than the global middleware default; the existing
``tenant_rate_limit`` middleware ALSO runs and may additionally cap by
tier or by API-key. Returns 429 on cap exhaustion.
"""

from __future__ import annotations

from eden.api.utils.redact import redact_all
import logging
import time
from collections import OrderedDict, deque
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from eden.api.deps import get_ingest_auth
from eden.config import get_settings
from eden.observability.ingestion import (
    IngestError,
    exception_to_http_status,
    get_format_registry,
)
from eden.observability.ingestion.attribution import Attribution
from eden.observability.telemetry_collector import (
    TelemetryCollector,
    get_telemetry_collector,
)

logger = logging.getLogger(__name__)

# Auth is ``get_ingest_auth`` only (API key or session cookie) — not
# ``require_path_org_access``, which depends on Clerk ``get_current_user``
# and would 401 valid ``X-Org-Api-Key`` SDK callers before ingest auth runs.
router = APIRouter(prefix="/orgs/{org_id}/ingest", tags=["ingestion"])


def _assert_ingest_org(auth_ctx: dict, org_id: str) -> str:
    """Reject path/auth org mismatches; return the authenticated org id."""
    auth_org = auth_ctx.get("org_id")
    if not auth_org or str(auth_org) != str(org_id):
        raise HTTPException(
            status_code=403,
            detail="Path org_id does not match authenticated org",
        )
    return str(auth_org)


# ── Per-tenant in-process rate limiter ───────────────────────────────
# Simple sliding window — not distributed, but fast. Replaced by the
# Redis-backed ``SlidingWindowRateLimiter`` in Phase 3 when RBAC +
# multi-instance arrive. Keyed by tenant; the global middleware also
# runs and may additionally cap by tier or API-key.
#
# F63 — ``_rate_buckets`` is now an ``OrderedDict`` keyed by
# ``org_id`` with a hard cap and a TTL.
#
# Pre-F63 the dict grew unbounded against unique-tenant traffic. The
# sliding-window ``deque`` values are cheap (~hundreds of bytes
# each) but a malicious caller spamming unique ``X-Org-Id`` headers
# (or just churning a long tail of one-shot tenants) could multiply
# the API's resident set size with no upper bound. Worse: every
# entry lived for the lifetime of the pod because the only way to
# drop a bucket was to wait the full 60s window AND have it
# organically empty.
#
# * ``_MAX_RATE_BUCKETS`` — hard cap on the number of tenant
#   entries. Once exceeded, the least-recently-touched org_id is
#   dropped at insertion time. Sized for healthy multi-tenant
#   traffic; a busy multi-tenant API process sees < 100 entries.
# * ``_evict_idle_buckets`` — sweep helper that drops buckets
#   whose sliding window is empty AND whose last access is older
#   than the rate-limit window. Defends against parked tenants
#   who walked away.
# * ``_touch_bucket`` — bumps the LRU position of an existing
#   bucket on every ``_check_rate_limit`` call. Active tenants
#   always survive eviction; cold tenants get reaped first.

_rate_buckets: OrderedDict[str, deque[float]] = OrderedDict()
_MAX_RATE_BUCKETS: int = 4096
_RATE_WINDOW_SECONDS: float = 60.0
# Throttle idle-bucket sweeps so high-RPM tenants do not pay
# O(buckets) on every request. Cap eviction still runs always.
_last_idle_evict_at: float = 0.0
_IDLE_EVICT_MIN_INTERVAL: float = 1.0


def _touch_bucket(org_id: str) -> None:
    """Bump the LRU position for an org's rate-limit bucket.

    Pure housekeeping. Best-effort: any exception inside the
    OrderedDict rewrite is silently dropped so a transient
    bookkeeping issue cannot break a paying customer's API
    call. Mirrors ``multi_agent._touch_env`` (F61) and
    ``gateway._upstream_client_cache.move_to_end`` (F62)."""
    try:
        if org_id in _rate_buckets:
            _rate_buckets.move_to_end(org_id)
    except Exception:
        pass


def _evict_idle_buckets(now: float) -> None:
    """Drop buckets whose sliding window is empty AND whose
    last access predates ``now - _RATE_WINDOW_SECONDS``.

    Pre-F63 nothing reaped idle tenants — the deque values
    auto-collapsed to empty on a window-expiry, but the key
    itself lived in the dict forever. A long-running pod would
    accumulate stale org_id keys for every tenant who ever sent
    a single event. F63 walks the dict on every rate-limit
    check and drops the empty, idle entries."""
    cutoff = now - _RATE_WINDOW_SECONDS
    # Collect first to avoid mutating during iteration.
    stale: list[str] = []
    for org_id, bucket in _rate_buckets.items():
        if not bucket or bucket[-1] < cutoff:
            stale.append(org_id)
    for org_id in stale:
        _rate_buckets.pop(org_id, None)


def _enforce_rate_buckets_cap(org_id: str) -> None:
    """Enforce the hard cap on ``_rate_buckets``.

    Drops the least-recently-touched org until the size is
    back under the limit. The new org always succeeds — only
    older ones are evicted. Mirrors
    ``multi_agent._enforce_cap_on_insert`` (F61)."""
    while len(_rate_buckets) >= _MAX_RATE_BUCKETS:
        try:
            _rate_buckets.popitem(last=False)
        except KeyError:
            break


def _check_rate_limit(org_id: str) -> None:
    settings = get_settings()
    cap = settings.ingestion_per_tenant_rpm
    if cap <= 0:
        return
    now = time.monotonic()
    window = _RATE_WINDOW_SECONDS
    # F63: opportunistic housekeeping on the hot path. Cap
    # enforcement is cheap and always runs; idle eviction is
    # throttled to once per ``_IDLE_EVICT_MIN_INTERVAL`` so a
    # single hot tenant does not re-walk the dict every RPM tick.
    global _last_idle_evict_at
    if now - _last_idle_evict_at >= _IDLE_EVICT_MIN_INTERVAL:
        _evict_idle_buckets(now)
        _last_idle_evict_at = now
    _enforce_rate_buckets_cap(org_id)
    bucket = _rate_buckets.get(org_id)
    if bucket is None:
        bucket = deque()
        _rate_buckets[org_id] = bucket
    # Drop entries outside the window.
    while bucket and bucket[0] < now - window:
        bucket.popleft()
    if len(bucket) >= cap:
        retry_after = max(1, int(bucket[0] + window - now))
        raise HTTPException(
            status_code=429,
            detail=(
                f"Ingestion rate limit exceeded for org {org_id} "
                f"({cap} req/min)"
            ),
            headers={"Retry-After": str(retry_after)},
        )
    bucket.append(now)
    # F63: bump LRU so an active tenant survives the cap
    # eviction triggered by a churning one-shot tenant.
    _touch_bucket(org_id)


# ── Response schema ──────────────────────────────────────────────────


class IngestResponse(BaseModel):
    accepted: int = 0
    rejected: int = 0
    deduplicated: int = 0
    total: int = 0
    source_format: str


# ── Generic ingest handler ───────────────────────────────────────────


async def _ingest_handler(
    org_id: str,
    body: bytes,
    path_format: str,
    auth_ctx: dict,
    project_id: str = "default",
    content_type: str | None = None,
    headers: dict[str, str] | None = None,
) -> IngestResponse:
    """Shared body for all 9 endpoints. Decode → PII pre-mask → collector."""
    settings = get_settings()

    # Body size guard
    if (
        settings.ingestion_max_body_bytes
        and len(body) > settings.ingestion_max_body_bytes
    ):
        raise HTTPException(
            status_code=413,
            detail=(
                f"Body too large: {len(body)} bytes > "
                f"{settings.ingestion_max_body_bytes}"
            ),
        )

    # Whitelist check
    if path_format not in settings.ingestion_allowed_formats:
        raise HTTPException(
            status_code=415,
            detail=(
                f"Source format {path_format!r} is not in "
                f"settings.ingestion_allowed_formats"
            ),
        )

    # Rate limit
    _check_rate_limit(org_id)
    # Load shed (W9) — distinct from per-tenant RPM
    from eden.observability.ingestion.shed import check_ingest_shed

    check_ingest_shed(org_id)

    # Build attribution
    attribution = Attribution(
        tenant_id=org_id,
        project_id=project_id,
        source_format=path_format,
        user_id=auth_ctx.get("user_id"),
        # ``get_current_org_api_key`` returns ``key_id``; also accept
        # ``api_key_id`` for overrides / gateway-shaped auth dicts.
        api_key_id=auth_ctx.get("api_key_id") or auth_ctx.get("key_id"),
        auth_method=auth_ctx.get("auth_method", "api_key"),
    )

    # Decode — gunzip first (SDKs send Content-Encoding: gzip).
    # Without this, registry.decode sees binary and fails → SDK retry storms.
    registry = get_format_registry()
    try:
        from eden.observability.ingestion.providers import maybe_gunzip_body_async

        content_encoding = (headers or {}).get("content-encoding")
        body = await maybe_gunzip_body_async(body, content_encoding)
        if (
            settings.ingestion_max_body_bytes
            and len(body) > settings.ingestion_max_body_bytes
        ):
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Body too large after decompress: {len(body)} bytes > "
                    f"{settings.ingestion_max_body_bytes}"
                ),
            )
        events = await registry.decode(path_format, body, attribution)
    except IngestError as exc:
        status_code = exception_to_http_status(exc)
        problems = getattr(exc, "problems", None)
        detail: Any = str(exc)
        if problems:
            detail = {"error": detail, "problems": problems}
        raise HTTPException(status_code=status_code, detail=detail) from exc
    except HTTPException:
        raise
    except (ValueError, TypeError, UnicodeDecodeError, KeyError) as exc:
        # Client/payload faults (e.g. invalid gzip, unexpected shapes)
        # must be 4xx — never 500.
        logger.warning("ingest decode client error: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=400,
            detail=str(exc) or "Invalid ingest payload",
        ) from exc
    except Exception as exc:
        # True infra / unexpected decoder faults → 503 so SDKs retry.
        from eden.api.utils.safe_error import safe_detail

        logger.exception("ingest decode failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(
                exc,
                fallback="Ingestion temporarily unavailable; retry after backoff",
            ),
            headers={"Retry-After": "5"},
        ) from exc

    # Write
    from eden.observability.errors import IngestionUnavailable

    collector: TelemetryCollector = await get_telemetry_collector()
    try:
        result = await collector.ingest_batch(events)
    except IngestionUnavailable as exc:
        # Mirror /chunks: Postgres-unavailable → 503 + Retry-After so
        # SDKs buffer and retry instead of treating a 500 as fatal.
        raise HTTPException(
            status_code=503,
            detail=str(exc.message) if hasattr(exc, "message") else str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    except Exception as exc:
        from eden.api.utils.safe_error import safe_detail

        logger.exception("ingest write failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(
                exc,
                fallback="Ingestion temporarily unavailable; retry after backoff",
            ),
            headers={"Retry-After": "5"},
        ) from exc

    return IngestResponse(
        accepted=result.get("accepted", len(events)),
        rejected=result.get("rejected", 0),
        deduplicated=result.get("deduplicated", 0),
        total=result.get("total", len(events)),
        source_format=path_format,
    )


# ── Endpoint factory ─────────────────────────────────────────────────
#
# We can't just make a single @router.post with path /{format} because
# we want the OpenAPI schema to list each format explicitly (so the
# portal's "API Explorer" surfaces them). One decorator per format.


def _make_endpoint(path_format: str):
    """Build a per-format endpoint handler."""

    async def handler(
        request: Request,
        org_id: str = Path(..., description="Organization ID"),
        auth_ctx: dict = Depends(get_ingest_auth),
    ) -> IngestResponse:
        org_id = _assert_ingest_org(auth_ctx, org_id)
        # Read raw body — decoders handle their own JSON parsing.
        body = await request.body()
        project_id = request.headers.get("X-Project-Id", "default")
        content_type = request.headers.get("Content-Type")
        headers = {k.lower(): v for k, v in request.headers.items()}
        return await _ingest_handler(
            org_id=org_id,
            body=body,
            path_format=path_format,
            auth_ctx=auth_ctx,
            project_id=project_id,
            content_type=content_type,
            headers=headers,
        )

    handler.__name__ = f"ingest_{path_format}"
    return handler


for fmt in (
    "otel",
    "helicone",
    "langfuse",
    "openai",
    "anthropic",
    "bedrock",
    "gemini",
    "framework",
    "webhook",
):
    router.add_api_route(
        f"/{fmt}",
        _make_endpoint(fmt),
        methods=["POST"],
        response_model=IngestResponse,
        summary=f"Ingest telemetry as {fmt}",
        description=(
            f"Accept a {fmt!r} payload, normalize to Eden "
            f"``TelemetryEvent``, run PII pre-mask, and write through "
            f"the existing ``TelemetryCollector``. The ``source_format`` "
            f"column is stamped ``{fmt!r}`` on every row."
        ),
    )


# ── Streaming chunks ingest (Phase 7.2a) ─────────────────────────────
# SDKs buffer per-token chunks (50 chunks OR 250ms) and POST them
# here in batches. The endpoint validates the parent event_id,
# deduplicates by chunk_id, and writes to telemetry_stream_chunks.
# PII pre-mask is run on delta_text and reasoning_delta.


class ChunksIngestRequest(BaseModel):
    """Request body for POST /orgs/{org_id}/ingest/chunks."""

    chunks: list[dict] = Field(
        ...,
        description=(
            "List of chunk objects. Required fields: event_id, "
            "trace_id, chunk_index, received_at_client_ms. Optional: "
            "parent_span_id, span_id, delta_text, reasoning_delta, "
            "tool_call_delta, ttft_ms, itl_ms, tpot_ms."
        ),
    )


class ChunksIngestResponse(BaseModel):
    accepted: int
    rejected: int
    deduplicated: int
    total: int


@router.post(
    "/chunks",
    response_model=ChunksIngestResponse,
    summary="Ingest streaming chunks (per-token capture)",
    description=(
        "Bulk endpoint for SDKs to flush buffered streaming chunks. "
        "Each chunk references the parent event_id emitted at end-of-"
        "stream. PII pre-mask runs on the text fields before insert."
    ),
)
async def ingest_chunks(
    request: Request,
    org_id: str = Path(..., description="Organization ID"),
    auth_ctx: dict = Depends(get_ingest_auth),
) -> ChunksIngestResponse:
    org_id = _assert_ingest_org(auth_ctx, org_id)
    body = await request.body()
    settings = get_settings()
    if (
        settings.ingestion_max_body_bytes
        and len(body) > settings.ingestion_max_body_bytes
    ):
        raise HTTPException(status_code=413, detail="Body too large")
    _check_rate_limit(org_id)
    from eden.observability.ingestion.shed import check_ingest_shed

    check_ingest_shed(org_id)
    try:
        from eden.observability.ingestion.providers import maybe_gunzip_body_async

        body = await maybe_gunzip_body_async(
            body, request.headers.get("content-encoding")
        )
        if (
            settings.ingestion_max_body_bytes
            and len(body) > settings.ingestion_max_body_bytes
        ):
            raise HTTPException(status_code=413, detail="Body too large")
        payload = ChunksIngestRequest.model_validate_json(body)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid body: {exc}") from exc

    if not payload.chunks:
        return ChunksIngestResponse(accepted=0, rejected=0, deduplicated=0, total=0)

    if (
        settings.ingestion_chunks_max_per_request
        and len(payload.chunks) > settings.ingestion_chunks_max_per_request
    ):
        raise HTTPException(
            status_code=413,
            detail=(
                f"Too many chunks: {len(payload.chunks)} > "
                f"{settings.ingestion_chunks_max_per_request}"
            ),
        )

    from eden.observability.errors import IngestionUnavailable
    from eden.observability.telemetry_collector import get_telemetry_collector
    collector = await get_telemetry_collector()
    try:
        result = await collector.record_stream_chunks(
            org_id, payload.chunks, settings=settings
        )
    except IngestionUnavailable as exc:
        # DL-3: surface Postgres-unavailable as 503 + Retry-After so
        # the SDK buffers and retries.
        raise HTTPException(
            status_code=503,
            detail=str(exc.message) if hasattr(exc, "message") else str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    except Exception:
        # Any other exception is an internal fault — log full
        # traceback server-side and return a generic 503 with no
        # leak of the raw error text. The SDK retries either way.
        from eden.api.utils.safe_error import safe_detail
        raise HTTPException(
            status_code=503,
            detail=safe_detail(
                Exception("Ingestion temporarily unavailable"),
                fallback="Ingestion temporarily unavailable; retry after backoff",
            ),
            headers={"Retry-After": "5"},
        ) from None
    return ChunksIngestResponse(**result)

