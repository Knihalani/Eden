"""Cost optimization and monitoring routes for Eden API (Phase 6.1).

Provides real-time visibility into:
- Model routing decisions and tier statistics
- Multi-layer cache performance (L1 exact-match, L2 semantic)
- Granular cost tracking by tenant/user/job/model/node
- Budget status with soft/hard limit enforcement
- Token optimization savings
"""

import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from eden.api.deps import (  # noqa: F401  (monkeypatched by tests)
    get_current_user,
    require_org_permission,
    require_org_permission_dep,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.optimization import (
    BudgetExceededError,
    BudgetStatus,
    CostTracker,
    ExactMatchCache,
    ModelRouter,
    SemanticCache,
)
from eden.optimization.cost_tracker import CostEvent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/optimization", tags=["optimization"], dependencies=[Depends(require_path_org_access)])


# ============================================================================
# Pydantic Models
# ============================================================================

class RoutingStatsResponse(BaseModel):
    """Model routing statistics."""
    calls_by_tier: dict[str, int]
    total_calls: int
    fallbacks: int
    validation_failures: int
    tokens_saved: int
    fallback_rate: float
    heuristic_hits: int
    llm_classifications: int
    heuristic_rate: float


class CacheStatsResponse(BaseModel):
    """Cache performance statistics."""
    l1_hits: int
    l1_misses: int
    l1_hit_rate: float
    l1_ttl_seconds: int
    l2_hits: int
    l2_misses: int
    l2_hit_rate: float
    l2_threshold: float


class CostBreakdownResponse(BaseModel):
    """Cost breakdown by dimension."""
    period_days: int
    period_start: str
    period_end: str
    total_cost_cents: float
    total_cost_usd: float
    total_tokens: int
    events_count: int
    avg_cost_per_call_cents: float
    by_tier: dict[str, float]
    by_node: dict[str, float]
    by_model: dict[str, float]


class BudgetStatusResponse(BaseModel):
    """Real-time budget status."""
    org_id: str
    plan_name: str
    status: str  # ok | soft_limit | hard_limit
    current_month_spend_cents: float
    soft_limit_cents: float
    hard_limit_cents: float
    utilization_pct: float


class TokenSavingsResponse(BaseModel):
    """Token optimization savings.

    ``compression_ratio`` and ``coalesced_requests`` are ``None``
    when the underlying stat is not tracked. Data-integrity audit
    2026-08: neither prompt compression nor per-org coalescing
    counters exist yet (the gateway coalescer keeps no totals), so
    these must never be filled with placeholder numbers.
    """
    tokens_saved: int
    estimated_cost_saved_cents: float
    compression_ratio: float | None = None  # None = not tracked
    coalesced_requests: int | None = None  # None = not tracked


class OptimizationOverviewResponse(BaseModel):
    """Combined optimization overview for the dashboard."""
    routing: RoutingStatsResponse
    cache: CacheStatsResponse
    costs: CostBreakdownResponse
    budget: BudgetStatusResponse
    savings: TokenSavingsResponse


class CostEventPayload(BaseModel):
    """Payload for recording a cost event."""
    model: str
    pipeline_node: str
    cost_type: str = "llm_tokens"
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    input_cost_cents: float = 0.0
    output_cost_cents: float = 0.0
    total_cost_cents: float = 0.0
    cache_hit: bool = False
    model_tier: str = "unknown"
    metadata: dict = {}


class CacheInvalidateRequest(BaseModel):
    """Request to invalidate cache entries."""
    pattern: str = "*"
    cache_type: str = "l1"  # l1 | l2 | all


class CacheInvalidateResponse(BaseModel):
    """Response from cache invalidation."""
    cache_type: str
    invalidated_count: int


# ============================================================================
# Module-level singletons (stateful across requests for real-time stats)
# ============================================================================

_model_router: ModelRouter | None = None
_exact_cache: ExactMatchCache | None = None
_semantic_cache: SemanticCache | None = None
_cost_tracker: CostTracker | None = None


def _get_model_router() -> ModelRouter:
    global _model_router
    if _model_router is None:
        _model_router = ModelRouter()
    return _model_router


def _get_exact_cache() -> ExactMatchCache:
    global _exact_cache
    if _exact_cache is None:
        _exact_cache = ExactMatchCache()
    return _exact_cache


def _get_semantic_cache() -> SemanticCache:
    global _semantic_cache
    if _semantic_cache is None:
        _semantic_cache = SemanticCache()
    return _semantic_cache


def _get_cost_tracker() -> CostTracker:
    global _cost_tracker
    if _cost_tracker is None:
        _cost_tracker = CostTracker()
    return _cost_tracker


# ============================================================================
# Routes — Overview
# ============================================================================

@router.get("/overview", response_model=OptimizationOverviewResponse)
async def get_optimization_overview(
    org_id: str = Depends(require_path_org_access),
    days: int = Query(default=30, ge=1, le=365),
    user: dict = Depends(get_current_user),
        _check_billing_view: dict = Depends(require_org_permission_dep('billing:view'))
):
    """Get a combined optimization overview for the dashboard.

    Returns routing stats, cache performance, cost breakdown, budget status,
    and token savings in a single call.

    Defensive: a Redis blip or transient Postgres failure on any
    sub-call should not 500 the entire overview tile — the user
    would see a red "Failed to load" banner on the dashboard for
    one missing sub-component. The previous version had a partial
    try/except on the Redis hget only; everything else could still
    raise. June 2026 fix wraps the whole function in a fall-through
    that returns a structurally-valid response with all counters
    zeroed so the dashboard renders cleanly.
    """
    try:
        return await _build_optimization_overview(org_id, days)
    except Exception as exc:
        # Last-resort fallback. Log the error for ops but return a
        # well-formed empty response so the dashboard doesn't go red.
        import logging
        logging.getLogger(__name__).warning(
            "optimization overview fallback for org=%s days=%s: %s", org_id, days, exc
        )
        return _empty_optimization_overview(org_id, days)


async def _build_optimization_overview(org_id: str, days: int):
    """Body of the overview route — split out so the outer
    function can wrap it in a try/except without losing the
    docstring on the public endpoint."""

    router_inst = _get_model_router()
    exact = _get_exact_cache()
    semantic = _get_semantic_cache()
    tracker = _get_cost_tracker()

    # Routing stats
    routing_stats = router_inst.get_stats()
    classifier_stats = routing_stats.pop("classifier_stats", {})
    routing = RoutingStatsResponse(
        calls_by_tier=routing_stats.get("calls_by_tier", {}),
        total_calls=routing_stats.get("total_calls", 0),
        fallbacks=routing_stats.get("fallbacks", 0),
        validation_failures=routing_stats.get("validation_failures", 0),
        tokens_saved=routing_stats.get("tokens_saved", 0),
        fallback_rate=routing_stats.get("fallback_rate", 0.0),
        heuristic_hits=classifier_stats.get("heuristic_hits", 0),
        llm_classifications=classifier_stats.get("llm_classifications", 0),
        heuristic_rate=classifier_stats.get("heuristic_rate", 0.0),
    )

    # Cache stats
    exact_stats = exact.get_stats()
    semantic_stats = semantic.get_stats()
    cache = CacheStatsResponse(
        l1_hits=exact_stats.get("hits", 0),
        l1_misses=exact_stats.get("misses", 0),
        l1_hit_rate=exact_stats.get("hit_rate", 0.0),
        l1_ttl_seconds=exact_stats.get("ttl_seconds", 3600),
        l2_hits=semantic_stats.get("hits", 0),
        l2_misses=semantic_stats.get("misses", 0),
        l2_hit_rate=semantic_stats.get("hit_rate", 0.0),
        l2_threshold=semantic_stats.get("threshold", 0.95),
    )

    # Cost breakdown (from in-memory tracker, filtered by tenant)
    now = datetime.now(UTC)
    start = now - timedelta(days=days)
    events = tracker.get_events(tenant_id=org_id)
    filtered = [e for e in events if datetime.fromisoformat(e.timestamp) >= start]

    total_cents = sum(e.total_cost_cents for e in filtered)
    total_tokens = sum(e.total_tokens for e in filtered)

    by_tier: dict[str, float] = {}
    by_node: dict[str, float] = {}
    by_model: dict[str, float] = {}
    for e in filtered:
        by_tier[e.model_tier] = by_tier.get(e.model_tier, 0.0) + e.total_cost_cents
        by_node[e.pipeline_node] = by_node.get(e.pipeline_node, 0.0) + e.total_cost_cents
        by_model[e.model] = by_model.get(e.model, 0.0) + e.total_cost_cents

    costs = CostBreakdownResponse(
        period_days=days,
        period_start=start.isoformat(),
        period_end=now.isoformat(),
        total_cost_cents=round(total_cents, 4),
        total_cost_usd=round(total_cents / 100, 4),
        total_tokens=total_tokens,
        events_count=len(filtered),
        avg_cost_per_call_cents=round(total_cents / len(filtered), 4) if filtered else 0.0,
        by_tier=by_tier,
        by_node=by_node,
        by_model=by_model,
    )

    # Budget status
    try:
        budget_status = await tracker.check_budget(org_id)
    except BudgetExceededError:
        budget_status = BudgetStatus.HARD_LIMIT

    # Get tenant limits for context
    limits = await tracker._get_tenant_limits(org_id)
    soft_limit = limits.get("soft_limit_cents", float("inf"))
    hard_limit = limits.get("hard_limit_cents", float("inf"))

    # Get current month spend from Redis for accurate real-time data
    from eden.storage.redis import get_redis_client
    redis = await get_redis_client()
    current_spend = 0.0
    if redis:
        month_key = now.strftime("%Y-%m")
        try:
            raw = await redis.hget(f"eden:cost:{org_id}:month:{month_key}", "total_cents")
            current_spend = float(raw or 0.0)
        except Exception as exc:
            # Redis blip shouldn't 500 the entire overview tile —
            # Postgres fallback will pick up the spend, and the
            # utilization % just renders blank. June 2026 hardening.
            # F70 — defensive redaction. ``org_id`` and
            # ``month_key`` are internal IDs (not PII), but the
            # ``exc`` could theoretically include user data in a
            # future refactor. ``redact_all`` is a no-op on
            # typical Python exceptions (no email/credential
            # patterns) but defends against the long tail.
            logger.warning(
                "redis hget failed for org=%s month=%s: %s",
                org_id, month_key, redact_all(str(exc)),
            )
            current_spend = 0.0

    utilization = round((current_spend / hard_limit) * 100, 2) if hard_limit != float("inf") and hard_limit > 0 else 0.0

    budget = BudgetStatusResponse(
        org_id=org_id,
        plan_name=limits.get("plan_name", "free"),
        status=budget_status,
        current_month_spend_cents=round(current_spend, 4),
        soft_limit_cents=soft_limit if soft_limit != float("inf") else -1,
        hard_limit_cents=hard_limit if hard_limit != float("inf") else -1,
        utilization_pct=utilization,
    )

    # Savings (estimated from tokens saved by cheaper tier routing)
    tokens_saved = routing_stats.get("tokens_saved", 0)
    # Rough estimate: T1 costs ~$0.0015/1K tokens, T3 costs ~$0.09/1K tokens
    # Savings per token = ($0.09 - $0.0015) / 1000 = $0.0000885/token = 0.00885 cents/token
    estimated_savings = tokens_saved * 0.00885

    savings = TokenSavingsResponse(
        tokens_saved=tokens_saved,
        estimated_cost_saved_cents=round(estimated_savings, 4),
        # Not tracked: no before/after token counts and no
        # coalescer totals exist. None, never a placeholder.
        compression_ratio=None,
        coalesced_requests=None,
    )

    return OptimizationOverviewResponse(
        routing=routing,
        cache=cache,
        costs=costs,
        budget=budget,
        savings=savings,
    )


def _empty_optimization_overview(org_id: str, days: int) -> OptimizationOverviewResponse:
    """Return a well-formed empty overview for the fallback path.

    All counters zeroed; costs/budget/utilization blank. The
    dashboard renders "—" / "0" for empty stats, which is the
    right user experience when the optimization pipeline is
    down. June 2026 hardening.
    """
    return OptimizationOverviewResponse(
        routing=RoutingStatsResponse(
            calls_by_tier={},
            total_calls=0,
            fallbacks=0,
            validation_failures=0,
            tokens_saved=0,
            fallback_rate=0.0,
            heuristic_hits=0,
            llm_classifications=0,
            heuristic_rate=0.0,
        ),
        cache=CacheStatsResponse(
            l1_hits=0, l1_misses=0, l1_hit_rate=0.0, l1_ttl_seconds=3600,
            l2_hits=0, l2_misses=0, l2_hit_rate=0.0, l2_threshold=0.95,
        ),
        costs=CostBreakdownResponse(
            period_days=days,
            period_start="",
            period_end="",
            total_cost_cents=0.0,
            total_cost_usd=0.0,
            total_tokens=0,
            events_count=0,
            avg_cost_per_call_cents=0.0,
            by_tier={}, by_node={}, by_model={},
        ),
        budget=BudgetStatusResponse(
            org_id=org_id,
            plan_name="free",
            status="ok",
            current_month_spend_cents=0.0,
            soft_limit_cents=-1,
            hard_limit_cents=-1,
            utilization_pct=0.0,
        ),
        savings=TokenSavingsResponse(
            tokens_saved=0,
            estimated_cost_saved_cents=0.0,
            compression_ratio=None,
            coalesced_requests=None,
        ),
    )


# ============================================================================
# Routes — Routing Stats
# ============================================================================

@router.get("/routing", response_model=RoutingStatsResponse)
async def get_routing_stats(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
        _check_billing_view: dict = Depends(require_org_permission_dep('billing:view')),
):
    """Get model routing statistics.

    Shows how many calls were routed to each tier, how many fallbacks
    occurred, and the classifier hit rate.
    """

    stats = _get_model_router().get_stats()
    classifier = stats.pop("classifier_stats", {})
    return RoutingStatsResponse(
        calls_by_tier=stats.get("calls_by_tier", {}),
        total_calls=stats.get("total_calls", 0),
        fallbacks=stats.get("fallbacks", 0),
        validation_failures=stats.get("validation_failures", 0),
        tokens_saved=stats.get("tokens_saved", 0),
        fallback_rate=stats.get("fallback_rate", 0.0),
        heuristic_hits=classifier.get("heuristic_hits", 0),
        llm_classifications=classifier.get("llm_classifications", 0),
        heuristic_rate=classifier.get("heuristic_rate", 0.0),
    )


# ============================================================================
# Routes — Cache Management
# ============================================================================

@router.get("/cache", response_model=CacheStatsResponse)
async def get_cache_stats(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
        _check_billing_view: dict = Depends(require_org_permission_dep('billing:view')),
):
    """Get cache performance statistics."""

    exact = _get_exact_cache()
    semantic = _get_semantic_cache()
    exact_stats = exact.get_stats()
    semantic_stats = semantic.get_stats()

    return CacheStatsResponse(
        l1_hits=exact_stats.get("hits", 0),
        l1_misses=exact_stats.get("misses", 0),
        l1_hit_rate=exact_stats.get("hit_rate", 0.0),
        l1_ttl_seconds=exact_stats.get("ttl_seconds", 3600),
        l2_hits=semantic_stats.get("hits", 0),
        l2_misses=semantic_stats.get("misses", 0),
        l2_hit_rate=semantic_stats.get("hit_rate", 0.0),
        l2_threshold=semantic_stats.get("threshold", 0.95),
    )


@router.post("/cache/invalidate", response_model=CacheInvalidateResponse)
async def invalidate_cache(
    request: CacheInvalidateRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
        _check_billing_edit: dict = Depends(require_org_permission_dep('billing:edit')),
):
    """Invalidate cache entries.

    Requires billing:edit permission. Use with caution — invalidating L2
    (semantic) cache may be expensive as it requires vector DB operations.
    """

    count = 0
    if request.cache_type in ("l1", "all"):
        exact = _get_exact_cache()
        count += await exact.invalidate(request.pattern)

    if request.cache_type in ("l2", "all"):
        # Semantic cache doesn't support pattern-based invalidation yet
        # In a production system, this would delete Qdrant points by filter
        logger.info(f"Semantic cache invalidation requested for org {org_id} with pattern {request.pattern}")

    return CacheInvalidateResponse(
        cache_type=request.cache_type,
        invalidated_count=count,
    )


# ============================================================================
# Routes — Cost Tracking
# ============================================================================

@router.get("/costs", response_model=CostBreakdownResponse)
async def get_cost_breakdown(
    org_id: str = Depends(require_path_org_access),
    days: int = Query(default=30, ge=1, le=365),
    user: dict = Depends(get_current_user),
        _check_billing_view: dict = Depends(require_org_permission_dep('billing:view')),
):
    """Get detailed cost breakdown by tier, pipeline node, and model."""

    tracker = _get_cost_tracker()
    now = datetime.now(UTC)
    start = now - timedelta(days=days)
    events = tracker.get_events(tenant_id=org_id)
    filtered = [e for e in events if datetime.fromisoformat(e.timestamp) >= start]

    total_cents = sum(e.total_cost_cents for e in filtered)
    total_tokens = sum(e.total_tokens for e in filtered)

    by_tier: dict[str, float] = {}
    by_node: dict[str, float] = {}
    by_model: dict[str, float] = {}
    for e in filtered:
        by_tier[e.model_tier] = by_tier.get(e.model_tier, 0.0) + e.total_cost_cents
        by_node[e.pipeline_node] = by_node.get(e.pipeline_node, 0.0) + e.total_cost_cents
        by_model[e.model] = by_model.get(e.model, 0.0) + e.total_cost_cents

    return CostBreakdownResponse(
        period_days=days,
        period_start=start.isoformat(),
        period_end=now.isoformat(),
        total_cost_cents=round(total_cents, 4),
        total_cost_usd=round(total_cents / 100, 4),
        total_tokens=total_tokens,
        events_count=len(filtered),
        avg_cost_per_call_cents=round(total_cents / len(filtered), 4) if filtered else 0.0,
        by_tier=by_tier,
        by_node=by_node,
        by_model=by_model,
    )


@router.post("/costs/track")
async def track_cost_event(
    payload: CostEventPayload,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
        _check_billing_edit: dict = Depends(require_org_permission_dep('billing:edit')),
):
    """Record a cost event for granular tracking.

    This endpoint is typically called internally by the pipeline, but is
    exposed for external integrations and debugging.
    """

    tracker = _get_cost_tracker()
    event = CostEvent(
        tenant_id=org_id,
        user_id=user.get("id"),
        job_id=payload.metadata.get("job_id"),
        model=payload.model,
        pipeline_node=payload.pipeline_node,
        cost_type=payload.cost_type,
        input_tokens=payload.input_tokens,
        output_tokens=payload.output_tokens,
        total_tokens=payload.total_tokens,
        input_cost_cents=payload.input_cost_cents,
        output_cost_cents=payload.output_cost_cents,
        total_cost_cents=payload.total_cost_cents,
        cache_hit=payload.cache_hit,
        model_tier=payload.model_tier,
        metadata=payload.metadata,
    )
    await tracker.track(event)
    return {"tracked": True, "event_id": id(event)}


# ============================================================================
# Routes — Budget
# ============================================================================

@router.get("/budget", response_model=BudgetStatusResponse)
async def get_budget_status(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
        _check_billing_view: dict = Depends(require_org_permission_dep('billing:view')),
):
    """Get real-time budget status with soft/hard limit information."""

    tracker = _get_cost_tracker()

    try:
        status = await tracker.check_budget(org_id)
    except BudgetExceededError:
        status = BudgetStatus.HARD_LIMIT

    limits = await tracker._get_tenant_limits(org_id)
    soft_limit = limits.get("soft_limit_cents", float("inf"))
    hard_limit = limits.get("hard_limit_cents", float("inf"))

    from eden.storage.redis import get_redis_client
    redis = await get_redis_client()
    current_spend = 0.0
    if redis:
        now = datetime.now(UTC)
        month_key = now.strftime("%Y-%m")
        raw = await redis.hget(f"eden:cost:{org_id}:month:{month_key}", "total_cents")
        current_spend = float(raw or 0.0)

    utilization = round((current_spend / hard_limit) * 100, 2) if hard_limit != float("inf") and hard_limit > 0 else 0.0

    return BudgetStatusResponse(
        org_id=org_id,
        plan_name=limits.get("plan_name", "free"),
        status=status,
        current_month_spend_cents=round(current_spend, 4),
        soft_limit_cents=soft_limit if soft_limit != float("inf") else -1,
        hard_limit_cents=hard_limit if hard_limit != float("inf") else -1,
        utilization_pct=utilization,
    )


@router.post("/budget/check")
async def check_budget_before_call(
    org_id: str = Depends(require_path_org_access),
    estimated_cost_cents: float = Query(default=0.0, ge=0.0),
    user: dict = Depends(get_current_user),
        _check_billing_view: dict = Depends(require_org_permission_dep('billing:view')),
):
    """Check if a call would exceed budget before incurring costs.

    Returns the budget status and whether the call is allowed.
    This is used by the pipeline to gate LLM calls proactively.
    """

    tracker = _get_cost_tracker()
    try:
        status = await tracker.check_budget(org_id, estimated_cost_cents)
        return {
            "allowed": status != BudgetStatus.HARD_LIMIT,
            "status": status,
            "estimated_cost_cents": estimated_cost_cents,
        }
    except BudgetExceededError:
        return {
            "allowed": False,
            "status": BudgetStatus.HARD_LIMIT,
            "estimated_cost_cents": estimated_cost_cents,
        }


# ============================================================================
# Routes — Savings
# ============================================================================

@router.get("/savings", response_model=TokenSavingsResponse)
async def get_token_savings(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
        _check_billing_view: dict = Depends(require_org_permission_dep('billing:view')),
):
    """Get estimated token and cost savings from optimization.

    Shows tokens saved by routing to cheaper tiers and estimated
    cost savings. ``compression_ratio`` and ``coalesced_requests``
    are ``None`` — those stats are not tracked yet.
    """

    router_stats = _get_model_router().get_stats()
    tokens_saved = router_stats.get("tokens_saved", 0)
    estimated_savings = tokens_saved * 0.00885  # See overview route for calculation

    return TokenSavingsResponse(
        tokens_saved=tokens_saved,
        estimated_cost_saved_cents=round(estimated_savings, 4),
        # Not tracked: no before/after token counts and no
        # coalescer totals exist. None, never a placeholder.
        compression_ratio=None,
        coalesced_requests=None,
    )


# ───────────────────────────────────────────────────────────────────
# Phase A.1 — /optimization/cost-per-trace
# Joins usage_events (per-call cost) with telemetry_events (per-trace
# latency) on correlation_id so the portal can plot cost vs latency
# scatter for the most expensive traces.
# ────────────────────────────────────────────────────────────────────

@router.get("/cost-per-trace", response_model=dict)
async def cost_per_trace(
    org_id: str = Depends(require_path_org_access),
    days: int = Query(default=30, ge=1, le=365),
    _user: dict = Depends(get_current_user),
):
    """Top 100 traces by total LLM cost in the window."""
    from datetime import datetime, timedelta  # local import to avoid touching module-level

    from eden.storage import postgres as _pg_module
    start = datetime.now(UTC) - timedelta(days=days)
    client = await _pg_module.get_postgres_client()
    rows = await client.fetch(
        """
        SELECT u.correlation_id   AS trace_id,
               u.model           AS model,
               u.cost_usd        AS cost_usd,
               u.quantity        AS tokens,
               COALESCE(t.duration_ms, 0) AS latency_ms
        FROM usage_events u
        LEFT JOIN telemetry_events t
          ON t.trace_id = u.correlation_id
         AND t.tenant_id = u.org_id
        WHERE u.org_id = $1
          AND u.event_type = 'llm_call'
          AND u.correlation_id IS NOT NULL
          AND u.created_at >= $2
        ORDER BY u.cost_usd DESC
        LIMIT 100
        """,
        org_id, start,
    )
    return {
        "points": [
            {"trace_id": r["trace_id"],
             "model": r["model"] or "unknown",
             "cost_usd": float(r["cost_usd"] or 0.0),
             "tokens": int(r["tokens"] or 0),
             "latency_ms": float(r["latency_ms"] or 0.0)}
            for r in rows
        ]
    }


# NOTE: ``/orgs/{org}/cost/comparison`` lives in ``routes/cost.py``
# so the path matches the portal expectation. Mounted in ``app.py``.
