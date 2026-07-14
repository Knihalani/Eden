"""Intelligence Gap — Custom-Metric Studio (Cat 21) routes.

Real implementations (2026-06-11):
* ``GET  /templates``               — list the curated rubric
  template catalog (optionally filtered by ``?domain=``)
* ``POST /from-examples``           — synthesise a rubric from
  2-5 user-labelled examples via the existing
  :class:`OpenRouterClient`
* ``POST /metrics``                 — register a metric from an
  approved rubric; wraps the rubric as a runtime
  :class:`RubricJudge` in the global :class:`JudgeRegistry`
* ``GET  /metrics``                 — list the org's custom
  metrics with 30-day score stats
  (``n_scores_30d`` + ``median_score``)
* ``POST /metrics/{metric_id}/approve`` — admin-only;
  promote a draft metric to ``production`` and fire the
  closed-loop :func:`MetricStudioHook.on_metric_promotion`
  hook

Gates:
* ``intelligence_gap_v0`` umbrella flag
* Org scoping via ``{org_id}`` path param
* ``get_current_user`` for auth
* ``require_org_admin`` for the destructive
  ``/metrics/{metric_id}/approve`` route

See ``docs/observability-gap/21-custom-metric-studio.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_org_admin,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/metric-studio",
    tags=["intelligence-metric-studio"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)


# ─── Schemas ────────────────────────────────────────────────────────


class ExampleSpec(BaseModel):
    """One labelled example for the synthesis prompt.

    ``label`` is constrained to ``"pass"`` or ``"fail"`` at
    the service layer (not the Pydantic layer) so the
    service can return the same stub-fallback envelope shape
    the rest of the Cat 21 surface uses.
    """

    input: str = Field(..., description="The user / task input the LLM saw")
    output: str = Field(..., description="The LLM's response that was rated")
    label: str = Field(..., description='"pass" or "fail"')
    rationale: str | None = Field(
        None, description="The human's free-text reason for the label"
    )


class FromExamplesRequest(BaseModel):
    name: str = Field(..., description="The proposed metric name (e.g. 'Brand Voice v1')")
    domain: str = Field("general", description="safety | compliance | marketing | legal | factual | tone | general")
    examples: list[ExampleSpec] = Field(
        ..., description="2-5 labelled examples for the synthesis"
    )


class RegisterMetricRequest(BaseModel):
    name: str = Field(..., description="The metric name (e.g. 'Brand Voice v1')")
    rubric_id: str = Field(..., description="The rubric_id returned from /from-examples")
    version: str = Field("1.0", description="The metric version (semver-ish)")
    status: str = Field("draft", description='draft | production | deprecated')
    domain: str | None = Field(None, description="Override the domain from the synthesis")


class ApproveMetricRequest(BaseModel):
    approved_by: str = Field(..., description="The email / id of the approving admin")


class RunMetricRequest(BaseModel):
    """Manual runtime judge execution (bypasses auto-judge opt-in)."""

    input_text: str | None = Field(
        None, description="Task / input text to evaluate"
    )
    output_text: str | None = Field(
        None, description="Model output to score against the rubric"
    )
    trace_id: str | None = Field(
        None,
        description="Optional trace_id — used when input/output are omitted",
    )
    bypass_opt_in: bool = Field(
        True,
        description="Manual runs bypass the auto-judge opt-in gate by default",
    )


# ─── Routes ─────────────────────────────────────────────────────────


@router.get("/templates")
async def list_templates(
    org_id: str = Path(...),
    domain: str | None = Query(None, description="Filter by domain"),
) -> dict[str, Any]:
    """List the curated rubric template catalog.

    Static, in-process — no I/O, no LLM call. The response
    shape matches the per-template dict shape
    :class:`RubricTemplateLibrary.list` returns.
    """
    from eden.metric_studio import RubricTemplateLibrary

    templates = RubricTemplateLibrary().list(domain=domain)
    return {
        "status": "ok",
        "feature": "rubric_template_library",
        "live": True,
        "data": {
            "templates": templates,
            "count": len(templates),
            "filter": {"domain": domain},
        },
    }


@router.post("/from-examples")
async def synthesise_rubric(
    org_id: str = Path(...),
    body: FromExamplesRequest = Body(...),
) -> dict[str, Any]:
    """Synthesise a rubric prompt from 2-5 user-labelled examples.

    The synthesis is non-deterministic (LLM-driven) and gated
    on a human-in-the-loop approval — the returned
    ``rubric_id`` is the audit-log row id; the
    ``approval_required: true`` flag tells the portal to
    show a "review and approve" panel before the customer
    can register a metric from the rubric.
    """
    from eden.metric_studio import RubricSynthesiser

    examples_payload = [ex.model_dump() for ex in body.examples]
    return await RubricSynthesiser().from_examples(
        org_id,
        name=body.name,
        examples=examples_payload,
        domain=body.domain,
    )


@router.post("/metrics")
async def register_metric(
    org_id: str = Path(...),
    body: RegisterMetricRequest = Body(...),
) -> dict[str, Any]:
    """Register a custom metric from an approved rubric.

    Wraps the synthesised rubric as a
    :class:`RubricJudge` in the global
    :class:`JudgeRegistry` and stores the metric in
    ``organizations.features.custom_metrics``. The metric
    starts in ``draft`` status — production promotion is a
    separate admin-only step.
    """
    from eden.metric_studio import CustomMetricRegistry

    return await CustomMetricRegistry().register(
        org_id,
        name=body.name,
        rubric_id=body.rubric_id,
        version=body.version,
        status=body.status,
        domain=body.domain,
    )


@router.get("/metrics")
async def list_metrics(
    org_id: str = Path(...),
) -> dict[str, Any]:
    """List the org's custom metrics with 30-day score stats.

    Each entry includes ``n_scores_30d`` and ``median_score``
    computed on the fly from the ``custom_metric_runs`` table
    so the metric store stays a thin CRUD list.
    """
    from eden.metric_studio import CustomMetricRegistry

    return await CustomMetricRegistry().list(org_id)


@router.get("/metrics/{metric_id}")
async def get_metric(
    org_id: str = Path(...),
    metric_id: str = Path(...),
) -> dict[str, Any]:
    """Return a single metric entry (no score stats)."""
    from eden.metric_studio import CustomMetricRegistry

    return await CustomMetricRegistry().get(org_id, metric_id)


@router.post("/metrics/{metric_id}/run")
async def run_metric(
    org_id: str = Path(...),
    metric_id: str = Path(...),
    body: RunMetricRequest = Body(...),
) -> dict[str, Any]:
    """Manually execute a custom metric judge and persist the score.

    Writes one ``custom_metric_runs`` row with ``status="scored"``.
    Manual triggers bypass the auto-judge opt-in gate by default.
    """
    from eden.metric_studio import JudgeFactory

    return await JudgeFactory().execute(
        org_id,
        metric_id=metric_id,
        input_text=body.input_text,
        output_text=body.output_text,
        trace_id=body.trace_id,
        bypass_opt_in=body.bypass_opt_in,
    )


@router.post("/metrics/{metric_id}/approve")
async def approve_metric(
    org_id: str = Path(...),
    metric_id: str = Path(...),
    body: ApproveMetricRequest = Body(...),
    # DESTRUCTIVE — admin only. A non-admin calling this
    # route gets 403 (handled by ``require_org_admin``).
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Promote a custom metric from ``draft`` to ``production``.

    Admin-only — the ``require_org_admin`` dependency gates
    the destructive operation. The closed-loop
    :func:`MetricStudioHook.on_metric_promotion` hook fires
    after the status flip so a Cat 3 judge regression can
    auto-roll-back a promoted custom metric.
    """
    from eden.metric_studio import CustomMetricRegistry

    return await CustomMetricRegistry().approve(
        org_id,
        metric_id,
        approved_by=body.approved_by,
    )
