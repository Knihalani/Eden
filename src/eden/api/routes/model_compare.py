"""Model comparison + recommendation endpoints (Phase 7.6).

Routes
------
* ``POST /orgs/{org_id}/models/compare``   - side-by-side two models
* ``POST /orgs/{org_id}/models/recommend``  - pick best for the workload
* ``POST /orgs/{org_id}/models/project``    - project cost of a switch

Permissions
-----------
Read-only endpoints (``cost:read`` is the minimum). The comparator
honours per-tenant overrides so the projected bill is what the
customer actually pays, not the list price.

Statistical methodology
-----------------------
* **Multi-objective score** blends cost (50%), quality (30%),
  latency (10%), and reliability (10%) with a hard quality floor
  (default 0.80) so we never recommend a Haiku-tier model for an
  org whose Sonnet-4 traffic requires higher intelligence.
* **Cost projection** reads ``usage_events`` for the org's actual
  last 30 days of traffic on the *current* model, then projects
  the bill on each candidate using its real rate card
  (including cache-discount columns).
* **Cache savings** are computed against the candidate's
  no-cache bill so the UI can show "$X saved by cache" separately
  from "$Y saved by switching".
* **Empty history** (new agent, no traffic yet) falls back to a
  1K-in / 500-out default so the UI still renders something
  useful; the ``empty_history`` flag on the response tells the
  portal to render "based on a default workload" instead of a
  real number.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_path_org_access
from eden.llmops.cost_resolver import CostResolver
from eden.llmops.model_comparator import ModelComparator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/models", tags=["model-compare"])


# ─────────────────────────────────────────────────────────────────────
# Request / response models
# ─────────────────────────────────────────────────────────────────────


class ModelRef(BaseModel):
    """A ``(provider, model_id)`` tuple used in compare / recommend bodies."""
    provider: str = Field(..., description="Provider enum value")
    model_id: str = Field(..., min_length=1, max_length=128)


class CompareRequest(BaseModel):
    current: ModelRef
    candidate: ModelRef


class CompareResponse(BaseModel):
    current: dict[str, Any]
    candidate: dict[str, Any]
    delta_cost_per_1k_input: float
    delta_cost_per_1k_output: float
    delta_quality: float
    delta_latency_p95_ms: int
    delta_reliability: float
    cost_ratio: float


class RecommendRequest(BaseModel):
    """``mode=switch`` requires ``current``; ``mode=pick`` does not."""
    mode: str = Field("switch", description="switch | pick")
    current: ModelRef | None = None
    candidates: list[ModelRef] = Field(..., min_length=1, max_length=32)
    window_days: int = Field(30, ge=1, le=180)


class RunnerUp(BaseModel):
    provider: str
    model_id: str
    score: float
    rationale: str


class RecommendResponse(BaseModel):
    recommended_provider: str
    recommended_model_id: str
    score: float
    rationale: str
    monthly_savings_usd: float | None
    current_provider: str | None
    current_model_id: str | None
    runners_up: list[RunnerUp]
    empty_history: bool
    """``True`` when the org had no usage_events on the current
    model in the requested window; the projection used a default
    1K in / 500 out workload."""


class ProjectRequest(BaseModel):
    current: ModelRef
    candidate: ModelRef
    scale_factor: float = Field(1.0, ge=0.1, le=100.0)
    window_days: int = Field(30, ge=1, le=180)


class ProjectResponse(BaseModel):
    current_provider: str
    current_model_id: str
    candidate_provider: str
    candidate_model_id: str
    current_total_usd: float
    projected_total_usd: float
    savings_usd: float
    savings_pct: float
    per_request_savings_usd: float
    cache_savings_usd: float
    window_days: int
    requests_in_window: int


# ─────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────


def _spec_to_dict(spec: Any) -> dict[str, Any]:
    return {
        "provider": spec.provider,
        "model_id": spec.model_id,
        "quality": spec.quality,
        "latency_p95_ms": spec.latency_p95_ms,
        "reliability": spec.reliability,
        "context_window": spec.context_window,
        "cost_per_1k_input": spec.cost_per_1k_input,
        "cost_per_1k_output": spec.cost_per_1k_output,
        "cost_per_1k_cache_read": spec.cost_per_1k_cache_read,
        "cost_per_1k_cache_write": spec.cost_per_1k_cache_write,
        "source": spec.source,
    }


@router.post("/compare", response_model=CompareResponse)
async def compare_models(
    body: CompareRequest,
    org_id: str = Depends(require_path_org_access),
    _user: dict = Depends(get_current_user)
) -> CompareResponse:
    """Side-by-side compare two models. Honours per-tenant overrides."""
    resolver = CostResolver()
    comparator = ModelComparator(resolver=resolver)
    cmp = await comparator.compare(
        org_id=org_id,
        current=(body.current.provider, body.current.model_id),
        candidate=(body.candidate.provider, body.candidate.model_id),
    )
    return CompareResponse(
        current=_spec_to_dict(cmp.current),
        candidate=_spec_to_dict(cmp.candidate),
        delta_cost_per_1k_input=cmp.delta_cost_per_1k_input,
        delta_cost_per_1k_output=cmp.delta_cost_per_1k_output,
        delta_quality=cmp.delta_quality,
        delta_latency_p95_ms=cmp.delta_latency_p95_ms,
        delta_reliability=cmp.delta_reliability,
        cost_ratio=cmp.cost_ratio,
    )


@router.post("/recommend", response_model=RecommendResponse)
async def recommend_model(
    body: RecommendRequest,
    org_id: str = Depends(require_path_org_access),
    _user: dict = Depends(get_current_user),
) -> RecommendResponse:
    """Recommend the best model — either a fresh pick or a switch.

    ``mode=switch`` requires ``current``; projects cost savings
    on each candidate using the org's real ``usage_events`` for
    the last ``window_days``.

    ``mode=pick`` is a pure ranking — useful for new agents that
    haven't picked a model yet.
    """
    resolver = CostResolver()
    comparator = ModelComparator(resolver=resolver)
    candidates = [(c.provider, c.model_id) for c in body.candidates]

    if body.mode == "switch":
        if body.current is None:
            from fastapi import HTTPException
            raise HTTPException(
                status_code=422,
                detail="mode=switch requires 'current' in the request body",
            )
        rec = await comparator.recommend_switch(
            org_id=org_id,
            current=(body.current.provider, body.current.model_id),
            candidates=candidates,
            window_days=body.window_days,
        )
    else:
        rec = await comparator.recommend(
            org_id=org_id,
            candidates=candidates,
        )

    return RecommendResponse(
        recommended_provider=rec.recommended.provider,
        recommended_model_id=rec.recommended.model_id,
        score=rec.score,
        rationale=rec.rationale,
        monthly_savings_usd=rec.monthly_savings_usd,
        current_provider=rec.current.provider if rec.current else None,
        current_model_id=rec.current.model_id if rec.current else None,
        runners_up=[
            RunnerUp(
                provider=spec.provider,
                model_id=spec.model_id,
                score=score,
                rationale=rationale,
            )
            for (spec, score, rationale) in rec.runners_up
        ],
        # The comparator doesn't expose "empty history" directly;
        # infer it from the savings figure being near-zero on a
        # no-traffic new agent.
        empty_history=(
            rec.current is not None
            and rec.monthly_savings_usd is not None
            and abs(rec.monthly_savings_usd) < 1e-9
            and rec.recommended.model_id == rec.current.model_id
        ),
    )


@router.post("/project", response_model=ProjectResponse)
async def project_cost(
    body: ProjectRequest,
    org_id: str = Depends(require_path_org_access),
    _user: dict = Depends(get_current_user),
) -> ProjectResponse:
    """Project the cost of switching ``current`` to ``candidate``.

    ``scale_factor`` lets the caller ask "what if traffic
    doubles?" without writing custom code. Defaults to 1.0.
    """
    resolver = CostResolver()
    comparator = ModelComparator(resolver=resolver)
    proj = await comparator.project_cost_at_scale(
        org_id=org_id,
        current=(body.current.provider, body.current.model_id),
        candidate=(body.candidate.provider, body.candidate.model_id),
        scale_factor=body.scale_factor,
        window_days=body.window_days,
    )
    return ProjectResponse(
        current_provider=proj.current.provider,
        current_model_id=proj.current.model_id,
        candidate_provider=proj.candidate.provider,
        candidate_model_id=proj.candidate.model_id,
        current_total_usd=proj.current_total_usd,
        projected_total_usd=proj.projected_total_usd,
        savings_usd=proj.savings_usd,
        savings_pct=proj.savings_pct,
        per_request_savings_usd=proj.per_request_savings_usd,
        cache_savings_usd=proj.cache_savings_usd,
        window_days=proj.history.window_days,
        requests_in_window=proj.history.requests,
    )
