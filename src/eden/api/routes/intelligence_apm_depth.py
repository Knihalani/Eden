"""Intelligence Gap — APM Depth + Tracing Depth (Cat 22, v1.4) routes.

Six core routes (the v1.4 ship) plus 5 v1.4.1 routes
(tail-sampling, K8s enrichment, Pyroscope) — total 11:

* ``POST /enrich``              — run the OTel v1.41 dual-emit
  enricher on a single span (returns the v1.36 + v1.41
  attribute set).
* ``POST /enrich-batch``        — same, for a batch of spans.
* ``POST /steps/stamp``         — stamp ``step_index`` +
  ``step_judges`` onto a span's attributes.
* ``GET  /steps/{trace_id}``    — list every step in a trace
  (in step-index order) with the judge scores.
* ``GET  /steps/{trace_id}/{step_index}`` — read the step
  judges for a specific step.
* ``GET  /metrics/agents``      — the 3-agent-metric dashboard
  (decision_path_depth, tool_call_success_rate, cost_per_step).

v1.4.1 add-ons (the 3 features that close out the v1.4 ship):

* ``POST /sampling/evaluate``   — preview the tail-sampling
  decision for a single trace (returns the verdict + rule).
* ``GET  /sampling/stats``      — the dropped/kept/evicted
  counters + memory estimate.
* ``POST /k8s/enrich``          — run the K8s enricher on a
  single span (returns the merged attributes + the K8s
  set + the sources used).
* ``POST /k8s/enrich-batch``    — same, for a batch of spans.
* ``GET  /k8s/detect``          — detect whether this process
  is running in K8s (returns the source list + missing
  attrs).
* ``GET  /profiles/{trace_id}/{step_index}`` — read the
  Pyroscope link for a (trace, step) tuple.
* ``GET  /profiles/{trace_id}`` — list every profile link
  for a trace.

Gates:
* ``intelligence_gap_v0`` umbrella flag
* Org scoping via ``{org_id}`` path param
* ``get_current_user`` for auth

See ``docs/eden-observability-gap-roadmap.md`` (Cat 22) and
``docs/observability-gap/22-apm-tracing-depth.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_feature_flag
from eden.apm_depth import (
    AgentMetricsCollector,
    OtelV141Enricher,
    StepJudgeStamper,
)

logger = logging.getLogger(__name__)

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
    resource_attributes: dict[str, Any] | None = None
    env: dict[str, str] | None = None


class EnrichBatchRequest(BaseModel):
    spans: list[dict[str, Any]]


class StepStampRequest(BaseModel):
    attributes: dict[str, Any]
    step_index: int
    step_judges: dict[str, float] | None = None


class SamplingEvaluateRequest(BaseModel):
    trace_id: str
    spans: list[dict[str, Any]]


class K8sEnrichRequest(BaseModel):
    attributes: dict[str, Any]
    resource_attributes: dict[str, Any] | None = None
    env: dict[str, str] | None = None


class K8sEnrichBatchRequest(BaseModel):
    spans: list[dict[str, Any]]


# ─── Routes (v1.4 — 6 core) ──────────────────────────────────────


@router.post("/enrich")
async def enrich(
    org_id: str = Path(...),
    body: EnrichRequest = Body(...),
) -> dict[str, Any]:
    """Run the v1.41 dual-emit enricher on a single span.

    The optional ``resource_attributes`` + ``env`` fields
    drive the v1.4.1 K8s path — when supplied, the
    enricher ALSO runs the K8s enricher (chained) and
    stamps the K8s attributes onto the returned span.
    """
    r = _enricher.enrich(org_id, attributes=body.attributes)
    if body.resource_attributes is not None or body.env is not None:
        # Chain through the K8s enricher
        from eden.apm_depth import K8sEnricher

        k8s_r = K8sEnricher().enrich(
            org_id,
            attributes=(r.get("data") or {}).get("attributes") or body.attributes,
            resource_attributes=body.resource_attributes,
            env=body.env,
        )
        k8s_data = k8s_r.get("data") or {}
        r.setdefault("data", {})
        r["data"]["attributes"] = k8s_data.get("attributes") or r["data"].get(
            "attributes"
        )
        r["data"]["k8s"] = k8s_data.get("k8s") or {}
        r["data"]["k8s_sources"] = k8s_data.get("sources") or []
    return r


@router.post("/enrich-batch")
async def enrich_batch(
    org_id: str = Path(...),
    body: EnrichBatchRequest = Body(...),
) -> dict[str, Any]:
    """Run the v1.41 dual-emit enricher on a batch of spans."""
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


# ─── Routes (v1.4.1 — tail-sampling + K8s + Pyroscope) ───────────


@router.post("/sampling/evaluate")
async def sampling_evaluate(
    org_id: str = Path(...),
    body: SamplingEvaluateRequest = Body(...),
) -> dict[str, Any]:
    """Preview the tail-sampling decision for a single trace.

    Returns the live ``ok`` envelope with the verdict
    (keep / drop) + the rule that fired (keep_if_error,
    keep_if_slow, keep_if_loop, keep_if_force_trace,
    probabilistic). The buffer is NOT touched.
    """
    from eden.apm_depth import get_tail_sampler

    sampler = get_tail_sampler()
    return sampler.evaluate_single(
        org_id, trace_id=body.trace_id, spans=body.spans
    )


@router.get("/sampling/stats")
async def sampling_stats() -> dict[str, Any]:
    """Return the dropped / kept / evicted counters + the
    memory estimate + the drop rate.

    The ``drop_rate`` is what the Cat 9 alert pipeline
    watches (> 1% means the buffer is undersized per
    the Drozd 2025 post-mortem).
    """
    from eden.apm_depth import get_sampling_stats

    return get_sampling_stats()


@router.post("/k8s/enrich")
async def k8s_enrich(
    org_id: str = Path(...),
    body: K8sEnrichRequest = Body(...),
) -> dict[str, Any]:
    """Run the K8s enricher on a single span's attributes.

    The ``resource_attributes`` field is the OTel
    Resource.attributes dict (authoritative — the
    gateway collector's OTel SDK stamps it). The
    ``env`` field is the process env (the Downward
    API fallback). The enricher merges all three
    sources and stamps the resolved K8s attributes
    onto ``attributes``.
    """
    from eden.apm_depth import K8sEnricher

    return K8sEnricher().enrich(
        org_id,
        attributes=body.attributes,
        resource_attributes=body.resource_attributes,
        env=body.env,
    )


@router.post("/k8s/enrich-batch")
async def k8s_enrich_batch(
    org_id: str = Path(...),
    body: K8sEnrichBatchRequest = Body(...),
) -> dict[str, Any]:
    """Run the K8s enricher on a batch of spans."""
    from eden.apm_depth import K8sEnricher

    return K8sEnricher().enrich_batch(org_id, spans=body.spans)


@router.get("/k8s/detect")
async def k8s_detect() -> dict[str, Any]:
    """Detect whether this process is running in K8s.

    Returns the live ``ok`` envelope with
    ``data.is_k8s`` (bool) + the list of K8s attrs the
    process has access to (``sources_present``) + the
    ones it doesn't (``missing_attrs``). The portal
    uses this to surface "K8s enrichment not active —
    install the OTel collector with the k8sattributes
    processor" hints.
    """
    from eden.apm_depth import K8sEnricher

    return K8sEnricher().detect()


@router.get("/profiles/{trace_id}")
async def list_profile_links(
    org_id: str = Path(...),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    """List every persisted Pyroscope link for a trace.

    Returns the live ``ok`` envelope with the
    ``data.links`` list (one entry per step that was
    sampled + persisted).
    """
    from eden.apm_depth import ProfilingClient

    return await ProfilingClient().list_trace_links(org_id, trace_id=trace_id)


@router.get("/profiles/{trace_id}/{step_index}")
async def get_profile_link(
    org_id: str = Path(...),
    trace_id: str = Path(...),
    step_index: int = Path(...),
) -> dict[str, Any]:
    """Read (and lazily create) the Pyroscope link for a
    (trace, step) tuple.

    The first call persists the link (sampled at 1%);
    subsequent calls return the persisted row. The
    portal renders the ``pyroscope_url`` as a "Click
    for flame graph" link.
    """
    from eden.apm_depth import ProfilingClient

    client = ProfilingClient()
    return await client.link_step(
        org_id, trace_id=trace_id, step_index=step_index
    )
