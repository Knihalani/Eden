"""Granular cost tracking, attribution, and budget enforcement.

Tracks every cost at 5 dimensions: tenant, user, job, model, pipeline node.
Provides real-time budget enforcement with soft/hard limits.
"""

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

from eden.config import get_settings
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)


@dataclass
class CostEvent:
    """A single cost event with full attribution."""

    tenant_id: str
    user_id: str | None
    job_id: str | None
    model: str
    pipeline_node: str
    cost_type: str  # llm_tokens | sandbox_compute | storage | api_call
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    input_cost_cents: float = 0.0
    output_cost_cents: float = 0.0
    total_cost_cents: float = 0.0
    cache_hit: bool = False
    model_tier: str = "unknown"
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    metadata: dict = field(default_factory=dict)


class BudgetStatus:
    """Budget status constants."""

    OK = "ok"
    SOFT_LIMIT = "soft_limit"
    HARD_LIMIT = "hard_limit"


class BudgetExceededError(Exception):
    """Raised when a hard budget limit is exceeded."""
    pass


class CostTracker:
    """Tracks costs per tenant/job/model and enforces budget limits."""

    def __init__(self) -> None:
        self.settings = get_settings()
        self._events: list[CostEvent] = []
        self._total_tracked_cents = 0.0

    async def track(self, event: CostEvent) -> None:
        """Record a cost event and update real-time aggregations in Redis."""
        self._events.append(event)
        self._total_tracked_cents += event.total_cost_cents

        # Update real-time counters in Redis (best-effort, non-blocking)
        client = await get_redis_client()
        if client is None:
            return

        try:
            now = datetime.now(UTC)
            day_key = now.strftime("%Y-%m-%d")
            hour_key = now.strftime("%Y-%m-%d-%H")

            # Daily counters per tenant
            await client.hincrbyfloat(
                f"eden:cost:{event.tenant_id}:day:{day_key}",
                "total_cents",
                float(event.total_cost_cents),
            )
            await client.hincrby(
                f"eden:cost:{event.tenant_id}:day:{day_key}",
                "tokens",
                event.total_tokens,
            )

            # Monthly counter per tenant (used by check_budget)
            month_key = now.strftime("%Y-%m")
            await client.hincrbyfloat(
                f"eden:cost:{event.tenant_id}:month:{month_key}",
                "total_cents",
                float(event.total_cost_cents),
            )
            await client.hincrby(
                f"eden:cost:{event.tenant_id}:month:{month_key}",
                "tokens",
                event.total_tokens,
            )

            # Hourly counters per model
            await client.hincrbyfloat(
                f"eden:cost:model:{event.model}:hour:{hour_key}",
                "total_cents",
                float(event.total_cost_cents),
            )

            # Pipeline node counters
            await client.hincrbyfloat(
                f"eden:cost:node:{event.pipeline_node}:day:{day_key}",
                "total_cents",
                float(event.total_cost_cents),
            )

            # Set TTL on counter keys (7 days)
            for key in [
                f"eden:cost:{event.tenant_id}:day:{day_key}",
                f"eden:cost:{event.tenant_id}:month:{month_key}",
                f"eden:cost:model:{event.model}:hour:{hour_key}",
                f"eden:cost:node:{event.pipeline_node}:day:{day_key}",
            ]:
                await client.expire(key, 7 * 24 * 3600)

        except Exception as e:
            logger.warning(f"Cost tracking Redis update failed: {e}")

    async def check_budget(
        self,
        tenant_id: str,
        estimated_cost_cents: float = 0.0,
    ) -> str:
        """Check budget status before incurring new costs.

        Returns:
            BudgetStatus.OK | SOFT_LIMIT | HARD_LIMIT

        Raises:
            BudgetExceededError: If hard limit would be exceeded.
        """
        client = await get_redis_client()
        if client is None:
            return BudgetStatus.OK

        try:
            # Get current month spend from Redis (with fallback to 0)
            now = datetime.now(UTC)
            month_key = now.strftime("%Y-%m")
            current_raw = await client.hget(
                f"eden:cost:{tenant_id}:month:{month_key}",
                "total_cents",
            )
            current_cents = float(current_raw or 0.0)

            # Get tenant limits from plan tier
            limits = await self._get_tenant_limits(tenant_id)
            soft_limit = limits.get("soft_limit_cents", float("inf"))
            hard_limit = limits.get("hard_limit_cents", float("inf"))

            projected = current_cents + estimated_cost_cents

            if projected > hard_limit:
                raise BudgetExceededError(
                    f"Hard budget limit reached: {current_cents:.2f}c / {hard_limit:.2f}c"
                )

            if projected > soft_limit:
                return BudgetStatus.SOFT_LIMIT

            return BudgetStatus.OK

        except BudgetExceededError:
            raise
        except Exception as e:
            logger.warning(f"Budget check failed: {e}")
            return BudgetStatus.OK

    async def _get_tenant_limits(self, tenant_id: str) -> dict:
        """Get budget limits for a tenant from org_plans."""
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            row = await client.fetchrow(
                """
                SELECT plan_name FROM org_plans
                WHERE org_id = $1 AND active = true
                """,
                tenant_id,
            )
            plan_name = row["plan_name"] if row else "free"

            plan_limits = {
                "free": {"soft_limit_cents": 500, "hard_limit_cents": 1000},
                "starter": {"soft_limit_cents": 5000, "hard_limit_cents": 10000},
                "pro": {"soft_limit_cents": 50000, "hard_limit_cents": 100000},
                "enterprise": {"soft_limit_cents": 500000, "hard_limit_cents": 1000000},
            }
            limits = plan_limits.get(plan_name, plan_limits["free"]).copy()
            limits["plan_name"] = plan_name
            return limits
        except Exception:
            return {"soft_limit_cents": float("inf"), "hard_limit_cents": float("inf"), "plan_name": "unknown"}

    def get_events(self, tenant_id: str | None = None) -> list[CostEvent]:
        """Get tracked events, optionally filtered by tenant."""
        if tenant_id is None:
            return list(self._events)
        return [e for e in self._events if e.tenant_id == tenant_id]

    def get_stats(self) -> dict:
        """Return aggregate cost statistics."""
        if not self._events:
            return {
                "total_tracked_cents": 0.0,
                "total_tracked_usd": 0.0,
                "total_tokens": 0,
                "events_count": 0,
            }

        total_tokens = sum(e.total_tokens for e in self._events)
        total_cents = sum(e.total_cost_cents for e in self._events)

        return {
            "total_tracked_cents": round(total_cents, 4),
            "total_tracked_usd": round(total_cents / 100, 4),
            "total_tokens": total_tokens,
            "events_count": len(self._events),
            "avg_cost_per_call_cents": round(total_cents / len(self._events), 4) if self._events else 0.0,
            "by_tier": self._aggregate_by("model_tier"),
            "by_node": self._aggregate_by("pipeline_node"),
            "by_model": self._aggregate_by("model"),
        }

    def _aggregate_by(self, field: str) -> dict:
        """Aggregate costs by a given field."""
        from collections import defaultdict
        agg: dict[str, float] = defaultdict(float)
        for e in self._events:
            key = getattr(e, field, "unknown")
            agg[key] += e.total_cost_cents
        return dict(sorted(agg.items(), key=lambda x: x[1], reverse=True))


@dataclass
class MonthlyCostReport:
    """Per-tenant monthly cost breakdown (§9.2.1)."""
    tenant_id: str
    year_month: str            # "2026-06"
    total_cents: float
    total_tokens: int
    by_model: dict[str, float]
    by_node: dict[str, float]
    generated_at: str


# Track this is appended to the existing CostTracker class via a
# method. See the generate_monthly_report method on CostTracker
# below.


# §9.2.1 — Monthly cost report generation
def generate_monthly_report(
    tenant_id: str,
    year_month: str,
    cost_events: list | None = None,
) -> MonthlyCostReport:
    """Compute a per-tenant monthly cost breakdown.

    ``cost_events`` is a list of ``CostEvent`` instances; in
    production this is read from ClickHouse. For the §9.2.1
    in-memory engine we accept the list as a parameter so tests
    and the ``scripts/generate_cost_report.py`` script can supply
    it without going through Redis.

    The breakdown is:
      - by_model: cents per model
      - by_node:  cents per pipeline node
    """
    from collections import defaultdict
    from datetime import datetime

    by_model: dict[str, float] = defaultdict(float)
    by_node: dict[str, float] = defaultdict(float)
    total_cents = 0.0
    total_tokens = 0

    for ev in cost_events or []:
        # ``CostEvent`` has ``tenant_id``, ``cost_cents``, ``tokens``,
        # ``model``, ``node``.
        if getattr(ev, "tenant_id", None) != tenant_id:
            continue
        # Filter by year-month. If the event has a timestamp, use it;
        # otherwise include in the running total (no time filter).
        ts = getattr(ev, "timestamp", None)
        if (
            ts is not None
            and hasattr(ts, "strftime")
            and ts.strftime("%Y-%m") != year_month
        ):
            continue
        cost = float(getattr(ev, "cost_cents", 0) or 0)
        total_cents += cost
        total_tokens += int(getattr(ev, "tokens", 0) or 0)
        by_model[getattr(ev, "model", "unknown")] += cost
        by_node[getattr(ev, "node", "unknown")] += cost

    return MonthlyCostReport(
        tenant_id=tenant_id,
        year_month=year_month,
        total_cents=round(total_cents, 4),
        total_tokens=total_tokens,
        by_model=dict(by_model),
        by_node=dict(by_node),
        generated_at=datetime.now(UTC).isoformat(),
    )
