"""Intelligence Gap — APM Depth + Tracing Depth (Cat 22, v1.4) routes.

The v1.4 surface (OtelV141Enricher, StepJudgeStamper,
AgentMetricsCollector) is real and continues to work — see
:mod:`eden.apm_depth.otel_v141`, :mod:`eden.apm_depth.step_judges`,
:mod:`eden.apm_depth.metrics`.

ponytail: per upgradespec §D.1 (Phase 1 cut), the v1.4.1
add-on routes (tail-sampling, K8s enrichment, Pyroscope) are
removed and return 501 with a pointer to the OTel Collector
config. The OTel Collector ``tail_sampling`` +
``k8sattributes`` processors are the replacement; see
``deploy/otel-collector-config.yaml`` for the config.

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


# ─── Routes (v1.4.1 — removed per §D.1) ──────────────────────────


def _deferred(message: str) -> dict[str, Any]:
    """Stable 501-shape envelope for endpoints cut per upgradespec §D.1.

    Mirrors the ``_not_implemented_envelope`` pattern used by the
    Cat 23 STUB surface so the portal renders a uniform "deferred"
    badge. The ``config_hint`` field names the OTel Collector
    config the customer should install.
    """
    return {
        "status": "not_implemented",
        "feature": "apm_depth_v141",
        "live": False,
        "message": message,
        "data": {
            "config_hint": (
                "Deploy the OTel Collector with the tail_sampling + "
                "k8sattributes processors (see "
                "deploy/otel-collector-config.yaml). The in-process "
                "sampling/k8s/profiling stack was removed per "
                "upgradespec §D.1."
            ),
        },
    }


@router.post("/sampling/evaluate")
async def sampling_evaluate(org_id: str = Path(...)) -> dict[str, Any]:
    """Removed per §D.1 — see OTel Collector ``tail_sampling`` processor."""
    return _deferred("Tail-sampling preview removed; use OTel Collector.")


@router.get("/sampling/stats")
async def sampling_stats() -> dict[str, Any]:
    """Removed per §D.1 — read drop-rate from the OTel Collector metrics."""
    return _deferred("Sampling stats removed; OTel Collector exports these.")


@router.post("/k8s/enrich")
async def k8s_enrich(org_id: str = Path(...)) -> dict[str, Any]:
    """Removed per §D.1 — see OTel Collector ``k8sattributes`` processor."""
    return _deferred("In-process K8s enricher removed; use OTel Collector.")


@router.post("/k8s/enrich-batch")
async def k8s_enrich_batch(org_id: str = Path(...)) -> dict[str, Any]:
    """Removed per §D.1."""
    return _deferred("In-process K8s enricher removed; use OTel Collector.")


@router.get("/k8s/detect")
async def k8s_detect() -> dict[str, Any]:
    """Removed per §D.1 — OTel Collector handles K8s detection natively."""
    return _deferred("K8s detect removed; OTel Collector handles this.")


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
