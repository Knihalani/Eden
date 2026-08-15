"""Fine-tune lineage SDK — D.12.5 (§8.7).

Lightweight wrapper for the fine-tuning lineage surface.
Two top-level surfaces:

* :func:`register_run` — async helper. Persists a run to
  ``fine_tuning_runs`` via
  :class:`FineTuneLineageService.register_run`. Best-effort.
* :func:`parse_openai_webhook_payload` — pure helper.
  Returns the ``(event_type, fine_tune_id, internal_status,
  base_model, fine_tuned_model, training_params, eval_results)``
  tuple extracted from a raw OpenAI webhook body. Used by
  the gateway ingest path when it sees an OpenAI fine-tuning
  event in the call stack / pubsub feed.

The customer wires their own polling loop against the
OpenAI ``fine_tuning.jobs`` API and calls
:func:`register_run` with the status transitions. The
SDK never raises — DB or import errors are swallowed and
logged at debug.

Usage::

    from eden.sdk.fine_tune import register_run

    await register_run(
        org_id="org-1",
        provider="openai",
        base_model="gpt-4o-mini-2024-07-18",
        fine_tuned_model="ft:gpt-4o-mini:org::custom",
        dataset_id="...",
        provider_fine_tune_id="ftjob-xxx",
        status="succeeded",
        eval_results={"mean_score": 0.92},
    )
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


# 4 spec'd statuses (mirrors services.observability.STATUSES).
# Ponytail: duplicated as a tiny tuple so the SDK doesn't
# depend on the service module (faster import + safer for
# gateway auto-extract).
_STATUSES: tuple[str, ...] = (
    "pending", "running", "succeeded", "failed",
)

# Map from the OpenAI webhook event_type to our internal status.
# Mirrors the route's status_map. Kept here for callers that
# want to ingest the webhook before the route layer is hit.
_OPENAI_EVENT_STATUS: dict[str, str] = {
    "fine_tuning.job.created": "pending",
    "fine_tuning.job.running": "running",
    "fine_tuning.job.succeeded": "succeeded",
    "fine_tuning.job.failed": "failed",
    "fine_tuning.job.cancelled": "failed",
}


async def register_run(
    org_id: str,
    *,
    provider: str,
    base_model: str,
    fine_tuned_model: str,
    dataset_id: str,
    provider_fine_tune_id: str | None = None,
    training_params: dict[str, Any] | None = None,
    status: str = "pending",
    eval_results: dict[str, Any] | None = None,
) -> str | None:
    """Persist a fine-tuning run. Best-effort.

    Idempotent on ``(provider, provider_fine_tune_id)`` —
    re-registering the same provider_fine_tune_id updates
    the status + eval_results in place. Returns the run
    id (or ``None`` on substrate error / unknown status).
    """
    if status not in _STATUSES:
        logger.debug("fine_tune SDK: unknown status %r", status)
        return None
    try:
        from eden.services.observability import get_fine_tune_service
        svc = get_fine_tune_service()
        return await svc.register_run(
            org_id,
            provider=provider,
            base_model=base_model,
            fine_tuned_model=fine_tuned_model,
            dataset_id=dataset_id,
            provider_fine_tune_id=provider_fine_tune_id,
            training_params=training_params or {},
            status=status,
            eval_results=eval_results,
        )
    except Exception as exc:
        logger.debug("fine_tune SDK: register_run failed: %s", exc)
        return None


def parse_openai_webhook_payload(
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Pure helper. Returns the extracted fields from a raw
    OpenAI fine-tuning webhook payload. The shape is::

        {
            "event_type": "...",          # the OpenAI event_type
            "fine_tune_id": "...",        # data.id
            "internal_status": "...",     # mapped from event_type
            "base_model": "...",          # data.model
            "fine_tuned_model": "...",    # data.fine_tuned_model
            "training_params": {...},     # data.hyperparameters + trained_tokens
            "eval_results": {...} | None, # data.eval_results (succeeded only)
            "ignored": True,              # set when the event_type is unknown
        }

    The route layer still does the HMAC verification + DB
    persist; this helper is the pure-parsing side.
    """
    event_type = (payload or {}).get("type") or ""
    data = (payload or {}).get("data") or {}
    internal_status = _OPENAI_EVENT_STATUS.get(event_type)
    return {
        "event_type": event_type,
        "fine_tune_id": data.get("id"),
        "internal_status": internal_status,
        "base_model": data.get("model") or "unknown",
        "fine_tuned_model": data.get("fine_tuned_model") or "",
        "training_params": {
            "hyperparameters": data.get("hyperparameters") or {},
            "trained_tokens": data.get("trained_tokens"),
        },
        "eval_results": data.get("eval_results"),
        "ignored": internal_status is None,
    }


def build_fine_tune_attributes(
    *,
    run_id: str,
    provider: str,
    base_model: str,
    fine_tuned_model: str,
    status: str,
    dataset_id: str | None = None,
    eval_results: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Pure helper. Returns the ``fine_tune.*`` sub-document
    the caller should set on their span's ``attributes``.
    Used by the gateway auto-extractor when it sees a
    fine-tuning call in the trace.
    """
    return {
        "fine_tune": {
            "run_id": run_id,
            "provider": provider,
            "base_model": base_model,
            "fine_tuned_model": fine_tuned_model,
            "status": status,
            "dataset_id": dataset_id,
            "eval_results": eval_results,
        },
    }


__all__ = [
    "build_fine_tune_attributes",
    "parse_openai_webhook_payload",
    "register_run",
]
