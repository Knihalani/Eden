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
        Body:
            format-specific JSON (or OTLP protobuf for /ingest/otel)
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

import logging
import time
from collections import defaultdict, deque
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from eden.api.deps import get_ingestion_auth
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

router = APIRouter(prefix="/orgs/{org_id}/ingest", tags=["ingestion"])


# ── Per-tenant in-process rate limiter ───────────────────────────────
# Simple sliding window — not distributed, but fast. Replaced by the
# Redis-backed ``SlidingWindowRateLimiter`` in Phase 3 when RBAC +
# multi-instance arrive. Keyed by tenant; the global middleware also
# runs and may additionally cap by tier or API-key.

_rate_buckets: dict[str, deque[float]] = defaultdict(deque)


def _check_rate_limit(org_id: str) -> None:
    settings = get_settings()
    cap = settings.ingestion_per_tenant_rpm
    if cap <= 0:
        return
    now = time.monotonic()
    window = 60.0
    bucket = _rate_buckets[org_id]
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

    # Build attribution
    attribution = Attribution(
        tenant_id=org_id,
        project_id=project_id,
        source_format=path_format,
        user_id=auth_ctx.get("user_id"),
        api_key_id=auth_ctx.get("api_key_id"),
        auth_method=auth_ctx.get("auth_method", "api_key"),
    )

    # Decode
    registry = get_format_registry()
    try:
        events = await registry.decode(path_format, body, attribution)
    except IngestError as exc:
        status_code = exception_to_http_status(exc)
        problems = getattr(exc, "problems", None)
        detail: Any = str(exc)
        if problems:
            detail = {"error": detail, "problems": problems}
        raise HTTPException(status_code=status_code, detail=detail)
    except Exception as exc:
        logger.exception(f"ingest decode failed: {exc}")
        raise HTTPException(status_code=500, detail="Ingestion failed")

    # Write
    collector: TelemetryCollector = await get_telemetry_collector()
    result = await collector.ingest_batch(events)

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
        auth_ctx: dict = Depends(get_ingestion_auth),
    ) -> IngestResponse:
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
    auth_ctx: dict = Depends(get_ingestion_auth),
) -> ChunksIngestResponse:
    body = await request.body()
    settings = get_settings()
    if (
        settings.ingestion_max_body_bytes
        and len(body) > settings.ingestion_max_body_bytes
    ):
        raise HTTPException(status_code=413, detail="Body too large")
    _check_rate_limit(org_id)
    try:
        payload = ChunksIngestRequest.model_validate_json(body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid body: {exc}")

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

    from eden.observability.telemetry_collector import get_telemetry_collector
    collector = await get_telemetry_collector()
    try:
        result = await collector.record_stream_chunks(
            org_id, payload.chunks, settings=settings
        )
    except Exception as exc:  # ponytail: IngestionUnavailable + future backend-down signals
        # DL-3: surface Postgres-unavailable as 503 + Retry-After so
        # the SDK buffers and retries.
        raise HTTPException(
            status_code=503,
            detail=str(exc) or "ingestion_unavailable",
            headers={"Retry-After": "5"},
        )
    return ChunksIngestResponse(**result)

