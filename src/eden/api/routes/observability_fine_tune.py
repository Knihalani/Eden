"""D.12.5 Fine-tune lineage API routes (§8.7).

Thin FastAPI wrapper over ``FineTuneLineageService`` +
``eden.sdk.fine_tune``. All persistence and validation logic
lives in those modules; this module only handles
request/response shaping, org membership enforcement, and the
OpenAI webhook signature dance.

Routes:
* ``GET  /v1/fine_tuning_runs``
* ``POST /v1/fine_tuning_runs``
* ``GET  /v1/fine_tuning_runs/{run_id}``
* ``GET  /v1/fine_tuning_runs/{run_id}/lineage``
* ``POST /v1/fine_tuning_runs/{run_id}/dataset_traces``
* ``POST /v1/fine_tuning_runs/{run_id}/trace_usage``
* ``POST /v1/fine_tuning_runs/{run_id}/drift_check``
* ``POST /v1/webhooks/openai/fine_tuning`` (signed, no org-member dep)
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Header, Path, Query, Request
from pydantic import BaseModel

from eden.api.deps import require_org_member
from eden.api.utils.redact import redact_all
from eden.sdk.fine_tune import parse_openai_webhook_payload
from eden.services.observability import get_fine_tune_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["fine-tune"])
webhook_router = APIRouter(prefix="/v1/webhooks", tags=["fine-tune"])


def _ok(data: Any, **extra: Any) -> dict[str, Any]:
    return {"status": "ok", "data": data, **extra}


class FineTuneRunCreate(BaseModel):
    provider: str
    base_model: str
    fine_tuned_model: str
    dataset_id: str
    training_params: dict[str, Any] | None = None
    provider_fine_tune_id: str | None = None
    status: str = "pending"
    eval_results: dict[str, Any] | None = None


class DatasetTracesRequest(BaseModel):
    trace_ids: list[str]
    span_id_by_trace: dict[str, str] | None = None


class TraceUsageCreate(BaseModel):
    trace_id: str


@router.post("/fine_tuning_runs")
async def post_fine_tuning_run(
    body: FineTuneRunCreate,
    org: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Register a fine-tuning run for the caller's org."""
    svc = get_fine_tune_service()
    try:
        run_id = await svc.register_run(
            org["org_id"],
            provider=body.provider,
            base_model=body.base_model,
            fine_tuned_model=body.fine_tuned_model,
            dataset_id=body.dataset_id,
            training_params=body.training_params,
            provider_fine_tune_id=body.provider_fine_tune_id,
            status=body.status,
            eval_results=body.eval_results,
        )
    except ValueError as exc:
        return {"status": "error", "message": redact_all(str(exc))}
    return _ok({"id": run_id})


@router.get("/fine_tuning_runs")
async def list_fine_tuning_runs(
    org: dict = Depends(require_org_member),
    status: str | None = Query(None),
    provider: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
) -> dict[str, Any]:
    """List fine-tuning runs for the caller's org."""
    svc = get_fine_tune_service()
    rows = await svc.list_runs_for_org(
        org["org_id"], status=status, provider=provider, limit=limit,
    )
    return _ok(rows, count=len(rows))


@router.get("/fine_tuning_runs/{run_id}")
async def get_fine_tuning_run(
    run_id: str = Path(...),
    org: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Return a single fine-tuning run, scoped to the caller's org."""
    svc = get_fine_tune_service()
    run = await svc.get_run(run_id, org_id=org["org_id"])
    if run is None:
        raise HTTPException(status_code=404, detail="fine-tuning run not found")
    return _ok(run)


@router.get("/fine_tuning_runs/{run_id}/lineage")
async def get_fine_tuning_run_lineage(
    run_id: str = Path(...),
    org: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Return the backward (dataset→traces) + forward
    (model→traces) lineage graph for a run, per spec §C.8.
    """
    svc = get_fine_tune_service()
    lineage = await svc.get_lineage_for_run(run_id, org_id=org["org_id"])
    if lineage is None:
        raise HTTPException(status_code=404, detail="fine-tuning run not found")
    return _ok(lineage)


@router.post("/fine_tuning_runs/{run_id}/dataset_traces")
async def post_fine_tuning_run_dataset_traces(
    body: DatasetTracesRequest,
    run_id: str = Path(...),
    org: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Bulk-link this run's dataset to the traces that built it
    (the backward lineage edge). The run's ``dataset_id`` is
    resolved server-side so callers only ever need the run id.
    """
    svc = get_fine_tune_service()
    run = await svc.get_run(run_id, org_id=org["org_id"])
    if run is None:
        raise HTTPException(status_code=404, detail="fine-tuning run not found")
    linked = await svc.link_dataset_to_traces(
        run["dataset_id"],
        trace_ids=body.trace_ids,
        span_id_by_trace=body.span_id_by_trace,
    )
    return _ok({"linked": linked})


@router.post("/fine_tuning_runs/{run_id}/trace_usage")
async def post_fine_tuning_run_trace_usage(
    body: TraceUsageCreate,
    run_id: str = Path(...),
    _org: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Record that a trace used this run's fine-tuned model
    in production (the forward lineage edge).
    """
    svc = get_fine_tune_service()
    ok = await svc.record_trace_usage(run_id, trace_id=body.trace_id)
    return _ok({"recorded": ok})


@router.post("/fine_tuning_runs/{run_id}/drift_check")
async def post_fine_tuning_run_drift_check(
    run_id: str = Path(...),
    window: int = Query(5, ge=3),
    z_threshold: float = Query(2.0, gt=0),
    _org: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Run the data-drift detector for this run's eval score
    against the org's trailing history for the same base model.
    Returns ``{"drift": False}`` (rather than 404/null) when no
    drift is detected — this is a read-only check, not a lookup.
    """
    svc = get_fine_tune_service()
    summary = await svc.detect_data_drift(
        run_id, window=window, z_threshold=z_threshold, fire_hook=True,
    )
    if summary is None:
        return _ok({"drift": False})
    return _ok(summary)


def _lookup_org_for_fine_tune_row(row: Any) -> str | None:
    org_id = row.get("org_id") if isinstance(row, dict) else row["org_id"]
    if not org_id or org_id == "unknown":
        return None
    return org_id


async def _lookup_org_for_fine_tune(provider_fine_tune_id: str) -> str | None:
    """Resolve the Eden ``org_id`` that owns a provider fine-tune
    job, for the webhook path where the caller has no org context
    (OpenAI doesn't know about Eden orgs — it just replays the
    ``fine_tune_id`` we gave it back to us).

    Returns ``None`` when the id is blank, no run has been
    registered for it yet, or the stored ``org_id`` is the
    ``"unknown"`` sentinel some earlier ingestion path may have
    written.
    """
    if not provider_fine_tune_id:
        return None
    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        if client is None:
            return None
        row = await client.fetchrow(
            """
            SELECT org_id FROM fine_tuning_runs
             WHERE provider_fine_tune_id = $1
             ORDER BY created_at DESC
             LIMIT 1
            """,
            provider_fine_tune_id,
        )
    except Exception as exc:
        logger.debug("fine_tune: org lookup failed: %s", redact_all(str(exc)))
        return None
    if row is None:
        return None
    return _lookup_org_for_fine_tune_row(row)


def _verify_openai_signature(body: bytes, header: str | None, secret: str) -> bool:
    """Verify an OpenAI webhook signature.

    OpenAI (like Clerk/svix) follows the standardwebhooks.com
    scheme: header value is ``t=<unix_ts>,v1=<hex_hmac_sha256>``,
    signed over ``f"{ts}."`` + the raw request body, keyed by the
    webhook's signing secret. A 5-minute replay window matches the
    tolerance used for the Clerk webhook.
    """
    if not header:
        return False
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    ts_raw, sig = parts.get("t"), parts.get("v1")
    if not ts_raw or not sig:
        return False
    try:
        ts = int(ts_raw)
    except ValueError:
        return False
    if abs(time.time() - ts) > 300:
        return False
    signed = f"{ts}.".encode() + body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


@webhook_router.post("/openai/fine_tuning")
async def openai_fine_tuning_webhook(
    request: Request,
    openai_webhook_signature: str | None = Header(
        None, alias="OpenAI-Webhook-Signature",
    ),
) -> dict[str, Any]:
    """Ingest an OpenAI fine-tuning job event (per spec R-12).

    Deliberately has no ``require_org_member`` dependency — OpenAI
    is the caller, not an Eden user — org scoping instead comes
    from :func:`_lookup_org_for_fine_tune` resolving the provider's
    ``fine_tune_id`` back to the org that originally registered it.
    """
    secret = os.environ.get("OPENAI_FINE_TUNE_WEBHOOK_SECRET", "")
    if not secret:
        logger.warning(
            "OpenAI fine-tune webhook received but "
            "OPENAI_FINE_TUNE_WEBHOOK_SECRET is unset; rejecting."
        )
        raise HTTPException(
            status_code=503, detail="fine-tune webhook secret not configured",
        )

    body = await request.body()
    if not _verify_openai_signature(body, openai_webhook_signature, secret):
        raise HTTPException(status_code=401, detail="invalid webhook signature")

    import json
    try:
        payload = json.loads(body) if body else {}
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail="invalid webhook JSON body",
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="webhook body must be a JSON object")
    parsed = parse_openai_webhook_payload(payload)
    if parsed["ignored"] or not parsed["fine_tune_id"]:
        return _ok({"ignored": True, "event_type": parsed["event_type"]})

    org_id = await _lookup_org_for_fine_tune(parsed["fine_tune_id"])
    if org_id is None:
        # Best-effort: we can't attribute this job to an org (it
        # may predate webhook wiring, or belong to another tenant
        # entirely). Ack 200 so OpenAI doesn't retry forever.
        return _ok({"ignored": True, "reason": "no matching run"})

    svc = get_fine_tune_service()
    run_id = await svc.register_run(
        org_id,
        provider="openai",
        base_model=parsed["base_model"],
        fine_tuned_model=parsed["fine_tuned_model"],
        # The webhook alone never carries the dataset lineage — that's
        # only known at manual registration time (POST /fine_tuning_runs).
        # register_run's ON CONFLICT upsert only touches status/eval_results
        # on an existing row, so this is a no-op for already-registered runs
        # and only matters for the (rare) job that finishes before Eden
        # ever saw a manual registration call.
        dataset_id=None,  # type: ignore[arg-type]
        training_params=parsed["training_params"],
        provider_fine_tune_id=parsed["fine_tune_id"],
        status=parsed["internal_status"],
        eval_results=parsed["eval_results"],
    )
    return _ok({"internal_status": parsed["internal_status"], "run_id": run_id})


__all__ = ["router", "webhook_router"]
