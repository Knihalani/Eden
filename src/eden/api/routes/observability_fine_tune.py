"""Fine-tune lineage routes — D.12.5 (§8.7, §C.8).

Routes (per spec §C.8):

* ``GET  /v1/fine_tuning_runs`` — list runs (org-member gated,
  filters: ``status``, ``provider``).
* ``POST /v1/fine_tuning_runs`` — register a run (org-admin
  gated; idempotent on ``(provider, provider_fine_tune_id)``).
* ``GET  /v1/fine_tuning_runs/{run_id}`` — get one run.
* ``GET  /v1/fine_tuning_runs/{run_id}/lineage`` — return the
  full lineage (backward: dataset → traces; forward: run →
  traces that used the fine-tuned model).
* ``POST /v1/fine_tuning_runs/{run_id}/dataset_traces`` —
  bulk-link traces to the run's dataset (org-member gated).
* ``POST /v1/fine_tuning_runs/{run_id}/trace_usage`` —
  record that a trace used the fine-tuned model (org-member
  gated; idempotent).
* ``POST /v1/fine_tuning_runs/{run_id}/drift_check`` — fire
  the data-drift detector (org-admin gated; the detector
  itself decides whether to fire the hook based on z-score).
* ``POST /v1/webhooks/openai/fine_tuning`` — provider webhook
  ingest (HMAC-verified, idempotent on ``(provider, provider_fine_tune_id)``
  per spec R-12).

The webhook handler accepts the OpenAI fine-tuning job events:

* ``fine_tuning.job.succeeded`` → ``status='succeeded'``,
  ``fine_tuned_model`` set.
* ``fine_tuning.job.failed`` → ``status='failed'``.
* ``fine_tuning.job.created`` / ``fine_tuning.job.running`` →
  ``status='pending'`` / ``'running'`` respectively.

The provider_fine_tune_id is ``data.id`` (``ftjob-xxx``).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_org_admin,
    require_org_member,
)
from eden.services.observability import (
    DEFAULT_DRIFT_WINDOW,
    DEFAULT_DRIFT_Z_THRESHOLD,
    STATUSES,
    get_fine_tune_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    tags=["observability-fine-tune"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)


class RegisterRunRequest(BaseModel):
    provider: str
    base_model: str
    fine_tuned_model: str
    dataset_id: str
    training_params: dict[str, Any] = Field(default_factory=dict)
    provider_fine_tune_id: str | None = None
    status: str = "pending"
    eval_results: dict[str, Any] | None = None


class LinkDatasetTracesRequest(BaseModel):
    trace_ids: list[str] = Field(default_factory=list)
    span_id_by_trace: dict[str, str] | None = None


class RecordUsageRequest(BaseModel):
    trace_id: str


# ── /v1/fine_tuning_runs (list + register) ───────────────────────────


@router.get("/v1/fine_tuning_runs")
async def list_fine_tuning_runs(
    org_id: str = Query(...),
    status: str | None = Query(None),
    provider: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """List fine-tuning runs for an org with optional filters
    (per spec §C.8).
    """
    if status is not None and status not in STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"unknown status: {status!r} (expected one of {list(STATUSES)})",
        )
    svc = get_fine_tune_service()
    rows = await svc.list_runs_for_org(
        org_id, status=status, provider=provider, limit=limit,
    )
    return {
        "status": "ok",
        "feature": "fine_tune_lineage",
        "live": True,
        "data": rows,
        "count": len(rows),
    }


@router.post("/v1/fine_tuning_runs")
async def register_fine_tuning_run(
    body: RegisterRunRequest = Body(...),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Register a fine-tuning run. Idempotent on
    ``(provider, provider_fine_tune_id)`` — re-running with
    the same provider_fine_tune_id updates the status +
    eval_results in place.
    """
    if body.status not in STATUSES:
        return {
            "status": "error",
            "feature": "fine_tune_lineage",
            "live": False,
            "message": (
                f"unknown status: {body.status!r} "
                f"(expected one of {list(STATUSES)})"
            ),
            "data": None,
        }
    # org_id is not in the body — the org_admin dep supplies it
    # via the request context. We pull it from the dep payload.
    org_id = _admin.get("org_id") or "unknown"
    svc = get_fine_tune_service()
    run_id = await svc.register_run(
        org_id,
        provider=body.provider,
        base_model=body.base_model,
        fine_tuned_model=body.fine_tuned_model,
        dataset_id=body.dataset_id,
        training_params=body.training_params,
        provider_fine_tune_id=body.provider_fine_tune_id,
        status=body.status,
        eval_results=body.eval_results,
    )
    return {
        "status": "ok" if run_id else "error",
        "feature": "fine_tune_lineage",
        "live": bool(run_id),
        "data": {"id": run_id},
    }


# ── /v1/fine_tuning_runs/{run_id} ────────────────────────────────────


@router.get("/v1/fine_tuning_runs/{run_id}")
async def get_fine_tuning_run(
    run_id: str = Path(...),
) -> dict[str, Any]:
    """Return one run by id."""
    svc = get_fine_tune_service()
    row = await svc.get_run(run_id)
    if row is None:
        return {
            "status": "error",
            "feature": "fine_tune_lineage",
            "live": True,
            "message": f"run not found: {run_id}",
            "data": None,
        }
    return {
        "status": "ok",
        "feature": "fine_tune_lineage",
        "live": True,
        "data": row,
    }


# ── /v1/fine_tuning_runs/{run_id}/lineage ────────────────────────────


@router.get("/v1/fine_tuning_runs/{run_id}/lineage")
async def get_run_lineage(
    run_id: str = Path(...),
) -> dict[str, Any]:
    """Return the full lineage (backward + forward) for a run."""
    svc = get_fine_tune_service()
    lineage = await svc.get_lineage_for_run(run_id)
    if lineage is None:
        return {
            "status": "error",
            "feature": "fine_tune_lineage",
            "live": True,
            "message": f"run not found: {run_id}",
            "data": None,
        }
    return {
        "status": "ok",
        "feature": "fine_tune_lineage",
        "live": True,
        "data": lineage,
    }


# ── /v1/fine_tuning_runs/{run_id}/dataset_traces ─────────────────────


@router.post("/v1/fine_tuning_runs/{run_id}/dataset_traces")
async def link_dataset_traces(
    run_id: str = Path(...),
    body: LinkDatasetTracesRequest = Body(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Bulk-link the run's dataset to the traces that built it.
    Idempotent on ``(dataset_id, trace_id)``.
    """
    svc = get_fine_tune_service()
    run = await svc.get_run(run_id)
    if run is None:
        return {
            "status": "error",
            "feature": "fine_tune_lineage",
            "live": True,
            "message": f"run not found: {run_id}",
            "data": None,
        }
    inserted = await svc.link_dataset_to_traces(
        run["dataset_id"],
        trace_ids=body.trace_ids,
        span_id_by_trace=body.span_id_by_trace,
    )
    return {
        "status": "ok",
        "feature": "fine_tune_lineage",
        "live": True,
        "data": {
            "run_id": run_id,
            "dataset_id": run["dataset_id"],
            "linked": inserted,
            "requested": len(body.trace_ids),
        },
    }


# ── /v1/fine_tuning_runs/{run_id}/trace_usage ───────────────────────


@router.post("/v1/fine_tuning_runs/{run_id}/trace_usage")
async def record_trace_usage(
    run_id: str = Path(...),
    body: RecordUsageRequest = Body(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Record that a trace used the fine-tuned model.
    Idempotent on ``(run_id, trace_id)``.
    """
    svc = get_fine_tune_service()
    ok = await svc.record_trace_usage(run_id, trace_id=body.trace_id)
    return {
        "status": "ok" if ok else "error",
        "feature": "fine_tune_lineage",
        "live": ok,
        "data": {"run_id": run_id, "trace_id": body.trace_id, "recorded": ok},
    }


# ── /v1/fine_tuning_runs/{run_id}/drift_check ───────────────────────


@router.post("/v1/fine_tuning_runs/{run_id}/drift_check")
async def run_drift_check(
    run_id: str = Path(...),
    window: int = Query(DEFAULT_DRIFT_WINDOW, ge=2, le=100),
    z_threshold: float = Query(
        DEFAULT_DRIFT_Z_THRESHOLD, ge=0.1, le=10.0,
    ),
    fire_hook: bool = Query(True),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Run the data-drift detector for a run. Returns the
    drift summary when z-score magnitude crosses threshold
    (and fires the ``on_fine_tune_data_drift`` hook).
    """
    svc = get_fine_tune_service()
    summary = await svc.detect_data_drift(
        run_id, window=window, z_threshold=z_threshold, fire_hook=fire_hook,
    )
    if summary is None:
        return {
            "status": "ok",
            "feature": "fine_tune_drift",
            "live": True,
            "data": {
                "run_id": run_id,
                "drift": False,
                "window": int(window),
                "z_threshold": float(z_threshold),
            },
        }
    return {
        "status": "ok",
        "feature": "fine_tune_drift",
        "live": True,
        "data": summary,
    }


# ── /v1/webhooks/openai/fine_tuning ──────────────────────────────────


def _verify_openai_webhook(
    *, body: bytes, signature_header: str, secret: str
) -> bool:
    """Verify the OpenAI webhook signature.

    The header is ``t=<unix_ts>,v1=<sig>`` and the HMAC
    is computed over ``<unix_ts>.<raw_body>`` using
    HMAC-SHA256 with the shared secret. We accept events
    whose timestamp is within ±5 minutes of server time
    (replay defense).
    """
    if not secret or not signature_header:
        return False
    parts = dict(p.split("=", 1) for p in signature_header.split(",") if "=" in p)
    ts = parts.get("t")
    sig = parts.get("v1")
    if not ts or not sig:
        return False
    try:
        ts_int = int(ts)
    except ValueError:
        return False
    if abs(int(time.time()) - ts_int) > 300:
        return False
    expected = hmac.new(
        secret.encode("utf-8"),
        f"{ts}.".encode() + body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, sig)


@router.post("/v1/webhooks/openai/fine_tuning")
async def openai_fine_tuning_webhook(
    request: Request,
    openai_webhook_signature: str | None = Header(default=None),
) -> dict[str, Any]:
    """Receive OpenAI fine-tuning job events.

    Idempotent on ``(provider, provider_fine_tune_id)``
    (per spec R-12). The shared secret is read from
    ``OPENAI_FINE_TUNE_WEBHOOK_SECRET`` env var; when
    unset the route returns 503 (a misconfigured
    receiver should NOT silently accept events).
    """
    secret = os.getenv("OPENAI_FINE_TUNE_WEBHOOK_SECRET", "")
    if not secret:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_FINE_TUNE_WEBHOOK_SECRET is not configured.",
        )
    body = await request.body()
    if not _verify_openai_webhook(
        body=body,
        signature_header=openai_webhook_signature or "",
        secret=secret,
    ):
        raise HTTPException(status_code=401, detail="Invalid webhook signature.")
    try:
        payload = json.loads(body) if body else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}") from exc
    event_type = payload.get("type") or ""
    data = payload.get("data") or {}
    fine_tune_id = data.get("id")
    if not fine_tune_id:
        raise HTTPException(
            status_code=400,
            detail="Missing data.id (provider fine_tune_id).",
        )
    # Map the event type to our internal status + fine_tuned_model.
    status_map = {
        "fine_tuning.job.created": "pending",
        "fine_tuning.job.running": "running",
        "fine_tuning.job.succeeded": "succeeded",
        "fine_tuning.job.failed": "failed",
        "fine_tuning.job.cancelled": "failed",
    }
    internal_status = status_map.get(event_type)
    if internal_status is None:
        # Unknown event — accept and ignore (idempotent).
        return {
            "status": "ok",
            "feature": "fine_tune_lineage",
            "live": True,
            "ignored": True,
            "event_type": event_type,
        }
    # The OpenAI webhook doesn't carry org_id (the customer's
    # account is identified by their API key + our org-to-key
    # mapping). For the v0 ship we look it up via a service
    # method that maps ``provider_fine_tune_id`` back to
    # the org that created the job. If no mapping exists, we
    # accept the event and create a row with ``org_id='unknown'``
    # so the operator can re-assign it via the admin UI.
    svc = get_fine_tune_service()
    org_id = await _lookup_org_for_fine_tune(fine_tune_id) or "unknown"
    fine_tuned_model = data.get("fine_tuned_model") or f"unknown_{fine_tune_id}"
    base_model = data.get("model") or "unknown"
    dataset_id = data.get("training_file") or "00000000-0000-0000-0000-000000000000"
    # eval_results is the optional metrics block on a succeeded
    # event. We surface ``mean_score`` for the drift detector.
    eval_results = data.get("eval_results")
    if (
        isinstance(eval_results, dict)
        and "mean_score" not in eval_results
        and "trained_tokens" in data
    ):
        # If a ``trained_tokens`` is present, surface it.
        eval_results = {
            **eval_results,
            "trained_tokens": data["trained_tokens"],
        }
    run_id = await svc.register_run(
        org_id,
        provider="openai",
        base_model=base_model,
        fine_tuned_model=fine_tuned_model,
        dataset_id=dataset_id,
        training_params={
            "hyperparameters": data.get("hyperparameters") or {},
            "trained_tokens": data.get("trained_tokens"),
        },
        provider_fine_tune_id=fine_tune_id,
        status=internal_status,
        eval_results=eval_results,
    )
    return {
        "status": "ok" if run_id else "error",
        "feature": "fine_tune_lineage",
        "live": bool(run_id),
        "data": {
            "id": run_id,
            "provider_fine_tune_id": fine_tune_id,
            "internal_status": internal_status,
        },
    }


async def _lookup_org_for_fine_tune(fine_tune_id: str) -> str | None:
    """Map a provider fine_tune_id back to the Eden org that created the job.

    Queries ``fine_tuning_runs`` for the most recent row whose
    ``provider_fine_tune_id`` matches. Returns ``None`` when no
    match is found or when the stored ``org_id`` is the sentinel
    ``'unknown'``. Best-effort: any DB error returns ``None`` so
    the caller falls back to the ``'unknown'`` sentinel.
    """
    if not fine_tune_id or not str(fine_tune_id).strip():
        return None
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception as exc:
        logger.debug("fine_tune webhook: postgres import failed: %s", exc)
        return None
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT org_id FROM fine_tuning_runs
             WHERE provider_fine_tune_id = $1
             ORDER BY created_at DESC
             LIMIT 1
            """,
            str(fine_tune_id).strip(),
        )
    except Exception as exc:
        logger.debug(
            "fine_tune webhook: org lookup failed for %s: %s", fine_tune_id, exc
        )
        return None
    if row is None:
        return None
    try:
        raw = row["org_id"] if hasattr(row, "__getitem__") else getattr(row, "org_id", None)
    except (KeyError, TypeError, IndexError):
        return None
    org_id = str(raw or "").strip()
    return org_id if org_id and org_id != "unknown" else None
