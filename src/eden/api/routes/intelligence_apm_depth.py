"""Intelligence Gap — APM Depth + Tracing Depth (Cat 22, v1.4) routes.

The v1.4 surface (OtelV141Enricher, StepJudgeStamper,
AgentMetricsCollector) is real and continues to work — see
:mod:`eden.apm_depth.otel_v141`, :mod:`eden.apm_depth.step_judges`,
:mod:`eden.apm_depth.metrics`.

ponytail: per upgradespec §D.1 (Phase 1 cut), the v1.4.1
in-process sampling / K8s / Pyroscope code was removed. The
tail-sampling + K8s attribute *routes* now expose the live
OTel Collector configuration from
``deploy/otel-collector-config.yaml`` (parsed or static
mirror). Pyroscope profile link routes remain deferred.

Mounted at ``/orgs/{org_id}/intelligence/apm-depth`` — same
prefix the previous v1.4 surface used so any deep-linked
portal pages continue to resolve to a 501 rather than a 404.

Gates:
* ``intelligence_gap_v0`` umbrella flag (still required)
* Org scoping via ``{org_id}`` path param
* ``get_current_user`` for auth
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_feature_flag
from eden.apm_depth import (
    AgentMetricsCollector,
    OtelV141Enricher,
    StepJudgeStamper,
)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/apm-depth",
    tags=["intelligence-apm-depth"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)

_enricher = OtelV141Enricher()
_stamper = StepJudgeStamper()
_metrics = AgentMetricsCollector()


# ─── Schemas ──────────────────────────────────────────────────────


class EnrichRequest(BaseModel):
    attributes: dict[str, Any]


class EnrichBatchRequest(BaseModel):
    spans: list[dict[str, Any]]


class StepStampRequest(BaseModel):
    attributes: dict[str, Any]
    step_index: int
    step_judges: dict[str, float] | None = None


# ─── Routes (v1.4 — 4 core, retained) ────────────────────────────


@router.post("/enrich")
async def enrich(
    org_id: str = Path(...),
    body: EnrichRequest = Body(...),
) -> dict[str, Any]:
    """Run the OTel v1.41 dual-emit enricher on a single span."""
    return _enricher.enrich(org_id, attributes=body.attributes)


@router.post("/enrich-batch")
async def enrich_batch(
    org_id: str = Path(...),
    body: EnrichBatchRequest = Body(...),
) -> dict[str, Any]:
    """Run the OTel v1.41 dual-emit enricher on a batch of spans."""
    return _enricher.enrich_batch(org_id, spans=body.spans)


@router.post("/steps/stamp")
async def stamp_step(
    org_id: str = Path(...),
    body: StepStampRequest = Body(...),
) -> dict[str, Any]:
    """Stamp ``step_index`` + ``step_judges`` onto a span's attributes."""
    return _stamper.stamp(
        org_id,
        attributes=body.attributes,
        step_index=body.step_index,
        step_judges=body.step_judges,
    )


@router.get("/steps/{trace_id}")
async def list_trace_steps(
    org_id: str = Path(...),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    """List every step in a trace, in step-index order."""
    return await _stamper.get_trace_steps(org_id, trace_id=trace_id)


@router.get("/steps/{trace_id}/{step_index}")
async def get_step_judges(
    org_id: str = Path(...),
    trace_id: str = Path(...),
    step_index: int = Path(...),
) -> dict[str, Any]:
    """Read the step judges for a specific trace + step."""
    return await _stamper.get_step_judges(
        org_id, trace_id=trace_id, step_index=step_index
    )


@router.get("/metrics/agents")
async def agent_metrics(
    org_id: str = Path(...),
    window_hours: int = Query(24, ge=1, le=24 * 30),
) -> dict[str, Any]:
    """The 3-agent-metric dashboard rollup."""
    return await _metrics.aggregate(org_id, window_hours=window_hours)


# ─── Routes (v1.4.1 — live OTel Collector configuration surface) ─


def _deferred(message: str) -> dict[str, Any]:
    """Stable 501-shape envelope for endpoints still deferred (profiles).

    Pyroscope / Phlare correlation remains out of process; sampling
    and K8s enrichment now expose the deployed collector config.
    """
    return {
        "status": "not_implemented",
        "feature": "apm_depth_v141",
        "live": False,
        "message": message,
        "data": {
            "config_hint": (
                "Use Grafana Phlare / Pyroscope directly for continuous "
                "profiling. Tail sampling + K8s attributes are live via "
                "deploy/otel-collector-config.yaml (see /sampling/* and "
                "/k8s/* routes)."
            ),
        },
    }


class SamplingEvaluateRequest(BaseModel):
    attributes: dict[str, Any] = {}


@router.post("/sampling/evaluate")
async def sampling_evaluate(
    org_id: str = Path(...),
    body: SamplingEvaluateRequest | None = Body(None),
) -> dict[str, Any]:
    """Preview which OTel Collector ``tail_sampling`` policy would keep a span.

    Live configuration surface — decisions are enforced by the
    collector; this endpoint returns the deployed policy set plus a
    best-effort match preview for the supplied attributes.
    """
    from eden.apm_depth.otel_collector_config import evaluate_sampling_preview

    attrs = (body.attributes if body is not None else {}) or {}
    result = evaluate_sampling_preview(attributes=attrs)
    result["data"]["org_id"] = org_id
    return result


@router.get("/sampling/stats")
async def sampling_stats() -> dict[str, Any]:
    """Return the deployed OTel Collector ``tail_sampling`` configuration."""
    from eden.apm_depth.otel_collector_config import tail_sampling_config

    result = tail_sampling_config()
    policies = list((result["data"]["config"] or {}).get("policies") or [])
    probabilistic = next(
        (
            p for p in policies
            if str(p.get("type") or "") == "probabilistic"
        ),
        None,
    )
    result["data"]["stats"] = {
        "policy_count": len(policies),
        "keep_policy_names": [
            p.get("name") for p in policies
            if str(p.get("type") or "") != "probabilistic"
        ],
        "fallback_sampling_percentage": (
            (probabilistic or {}).get("probabilistic") or {}
        ).get("sampling_percentage", 15),
        "note": (
            "Drop-rate metrics are exported by the OTel Collector; "
            "this endpoint surfaces the live policy configuration."
        ),
    }
    return result


@router.post("/k8s/enrich")
async def k8s_enrich(
    org_id: str = Path(...),
    body: EnrichRequest | None = Body(None),
) -> dict[str, Any]:
    """Return the deployed ``k8sattributes`` processor configuration.

    In-process enrichment was removed per §D.1; this is the live
    configuration surface reflecting ``deploy/otel-collector-config.yaml``.
    """
    from eden.apm_depth.otel_collector_config import k8s_attributes_config

    result = k8s_attributes_config()
    result["data"]["org_id"] = org_id
    if body is not None:
        result["data"]["input_attributes"] = body.attributes
        result["data"]["note"] = (
            "Attributes are enriched by the OTel Collector "
            "k8sattributes processor at collect time; this endpoint "
            "does not mutate spans in-process."
        )
    return result


@router.post("/k8s/enrich-batch")
async def k8s_enrich_batch(
    org_id: str = Path(...),
    body: EnrichBatchRequest | None = Body(None),
) -> dict[str, Any]:
    """Batch variant of ``/k8s/enrich`` — returns live collector config."""
    from eden.apm_depth.otel_collector_config import k8s_attributes_config

    result = k8s_attributes_config()
    result["data"]["org_id"] = org_id
    result["data"]["span_count"] = len(body.spans) if body is not None else 0
    return result


@router.get("/k8s/detect")
async def k8s_detect() -> dict[str, Any]:
    """Describe how the collector detects K8s metadata."""
    from eden.apm_depth.otel_collector_config import k8s_attributes_config

    result = k8s_attributes_config()
    cfg = result["data"]["config"] or {}
    result["data"]["detection"] = {
        "auth_type": cfg.get("auth_type", "serviceAccount"),
        "passthrough": cfg.get("passthrough", False),
        "metadata": (cfg.get("extract") or {}).get("metadata", []),
        "env_fallbacks": cfg.get("extract_from_env", []),
        "detector": "otel_collector_k8sattributes",
    }
    return result


@router.get("/profiles/{trace_id}")
async def list_profile_links(
    org_id: str = Path(...), trace_id: str = Path(...)
) -> dict[str, Any]:
    """Removed per §D.1 — use Grafana Phlare directly."""
    return _deferred("Pyroscope link list removed; use Grafana Phlare.")


@router.get("/profiles/{trace_id}/{step_index}")
async def get_profile_link(
    org_id: str = Path(...),
    trace_id: str = Path(...),
    step_index: int = Path(...),
) -> dict[str, Any]:
    """Removed per §D.1 — use Grafana Phlare directly."""
    return _deferred("Pyroscope link removed; use Grafana Phlare.")
