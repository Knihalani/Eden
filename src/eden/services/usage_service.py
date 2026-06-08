"""Usage tracking, aggregation, and cost attribution service.

Provides high-level APIs for:
- Recording granular usage events (tokens, jobs, storage, sandbox)
- Aggregating usage by resource, time period, user, job, or model
- Computing real-time spend and budget status against plan limits
- Syncing quota counters from usage_events to org_resource_limits

All monetary values are in USD (float dollars) for API convenience.
Database stores cost_usd as NUMERIC(18,6) cents-compatible.
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from eden.storage.postgres import get_postgres_client
from eden.services.plan_tiers import get_plan_tier

logger = logging.getLogger(__name__)


class UsageService:
    """High-level usage and billing aggregation service."""

    # ──────────────────────────────────────────────────────────────────────
    # Event tracking
    # ──────────────────────────────────────────────────────────────────────

    async def track_event(
        self,
        org_id: str,
        event_type: str,
        resource: str,
        quantity: float,
        unit: str,
        user_id: Optional[str] = None,
        model: Optional[str] = None,
        cost_usd: Optional[float] = None,
        metadata: Optional[dict] = None,
        correlation_id: Optional[str] = None,
    ) -> Optional[str]:
        """Record a single usage event. Returns the event UUID."""
        client = await get_postgres_client()
        try:
            event_id = await client.insert_usage_event(
                org_id=org_id,
                event_type=event_type,
                resource=resource,
                quantity=quantity,
                unit=unit,
                user_id=user_id,
                model=model,
                cost_usd=cost_usd,
                metadata=metadata,
                correlation_id=correlation_id,
            )
            return str(event_id) if event_id else None
        except Exception as e:
            logger.warning(f"Failed to track usage event: {e}")
            return None

    # ──────────────────────────────────────────────────────────────────────
    # Aggregation queries
    # ──────────────────────────────────────────────────────────────────────

    async def get_usage_summary(
        self,
        org_id: str,
        start: datetime,
        end: datetime,
    ) -> list[dict]:
        """Aggregate usage by event_type and resource for a time window."""
        client = await get_postgres_client()
        query = """
            SELECT
                event_type,
                resource,
                unit,
                COALESCE(SUM(quantity), 0) as total_quantity,
                COALESCE(SUM(cost_usd), 0) as total_cost_usd,
                COUNT(*) as event_count
            FROM usage_events
            WHERE org_id = $1
              AND created_at >= $2
              AND created_at < $3
            GROUP BY event_type, resource, unit
            ORDER BY total_cost_usd DESC
        """
        rows = await client.fetch(query, org_id, start, end)
        return [
            {
                "event_type": r["event_type"],
                "resource": r["resource"],
                "unit": r["unit"],
                "total_quantity": float(r["total_quantity"]),
                "total_cost_usd": float(r["total_cost_usd"]),
                "event_count": r["event_count"],
            }
            for r in rows
        ]

    async def get_cost_attribution(
        self,
        org_id: str,
        start: datetime,
        end: datetime,
        group_by: str = "user",  # "user" | "job" | "model" | "resource" | "endpoint" | "time"
    ) -> list[dict]:
        """Break down costs by user, job, model, resource, endpoint, or time bucket.

        group_by options:
            user     -> aggregates by user_id
            job      -> aggregates by metadata->>'job_id'
            model    -> aggregates by model name
            resource -> aggregates by resource type
            endpoint -> aggregates by metadata->>'endpoint' (e.g. /v1/jobs, /v1/environments)
            time     -> aggregates by day bucket (date_trunc('day', created_at))
        """
        client = await get_postgres_client()

        group_columns = {
            "user": "user_id",
            "job": "metadata->>'job_id'",
            "model": "COALESCE(model, 'unknown')",
            "resource": "resource",
            "endpoint": "COALESCE(metadata->>'endpoint', 'unknown')",
            "time": "date_trunc('day', created_at)",
        }

        if group_by not in group_columns:
            raise ValueError(f"Invalid group_by: {group_by}. Choose from {list(group_columns.keys())}")

        col = group_columns[group_by]
        query = f"""
            SELECT
                {col} as group_key,
                COALESCE(SUM(quantity), 0) as total_quantity,
                COALESCE(SUM(cost_usd), 0) as total_cost_usd,
                COUNT(*) as event_count
            FROM usage_events
            WHERE org_id = $1
              AND created_at >= $2
              AND created_at < $3
            GROUP BY {col}
            ORDER BY total_cost_usd DESC
            LIMIT 100
        """
        rows = await client.fetch(query, org_id, start, end)
        return [
            {
                "group_key": r["group_key"] or "unknown",
                "total_quantity": float(r["total_quantity"]),
                "total_cost_usd": float(r["total_cost_usd"]),
                "event_count": r["event_count"],
            }
            for r in rows
        ]

    async def get_current_spend(
        self,
        org_id: str,
        period: str = "month",  # "day" | "week" | "month" | "year"
    ) -> dict:
        """Return total spend for the current billing period."""
        now = datetime.now(timezone.utc)
        start = self._period_start(now, period)

        client = await get_postgres_client()
        query = """
            SELECT
                COALESCE(SUM(cost_usd), 0) as total_cost_usd,
                COALESCE(SUM(quantity) FILTER (WHERE event_type = 'llm_call'), 0) as total_tokens,
                COALESCE(SUM(quantity) FILTER (WHERE event_type = 'job_start'), 0) as total_jobs,
                COALESCE(SUM(quantity) FILTER (WHERE resource = 'storage_mb'), 0) as total_storage_mb,
                COUNT(*) as total_events
            FROM usage_events
            WHERE org_id = $1
              AND created_at >= $2
        """
        row = await client.fetchrow(query, org_id, start)
        return {
            "period": period,
            "period_start": start.isoformat(),
            "period_end": now.isoformat(),
            "total_cost_usd": float(row["total_cost_usd"]) if row else 0.0,
            "total_tokens": float(row["total_tokens"]) if row else 0.0,
            "total_jobs": float(row["total_jobs"]) if row else 0.0,
            "total_storage_mb": float(row["total_storage_mb"]) if row else 0.0,
            "total_events": row["total_events"] if row else 0,
        }

    async def get_budget_status(self, org_id: str) -> dict:
        """Return current usage vs plan limits with soft/hard limit flags.

        Queries real-time aggregates from usage_events and compares them
        against the org's active resource limits.
        """
        client = await get_postgres_client()

        # Get the active resource limits row
        limits = await client.get_org_resource_limits(org_id)
        if not limits:
            # No limits configured — create a default free-tier record
            logger.warning(f"No resource limits found for org {org_id}; creating free tier defaults")
            await client.set_org_resource_limits(org_id, plan_name="free")
            limits = await client.get_org_resource_limits(org_id)

        plan_name = limits.get("plan_name", "free") if limits else "free"
        tier = get_plan_tier(plan_name)

        now = datetime.now(timezone.utc)
        month_start = self._period_start(now, "month")

        # Aggregate actual usage from usage_events for the current month
        usage_query = """
            SELECT
                COALESCE(SUM(quantity) FILTER (WHERE event_type = 'llm_call'), 0) as tokens_used,
                COALESCE(SUM(quantity) FILTER (WHERE event_type = 'job_start'), 0) as jobs_used,
                COALESCE(SUM(quantity) FILTER (WHERE resource = 'storage_mb'), 0) as storage_mb_used,
                COALESCE(SUM(quantity) FILTER (WHERE resource = 'sandbox_seconds'), 0) as sandbox_seconds_used,
                COALESCE(SUM(cost_usd), 0) as total_cost_usd
            FROM usage_events
            WHERE org_id = $1
              AND created_at >= $2
        """
        usage_row = await client.fetchrow(usage_query, org_id, month_start)

        tokens_used = float(usage_row["tokens_used"]) if usage_row else 0.0
        jobs_used = float(usage_row["jobs_used"]) if usage_row else 0.0
        storage_mb_used = float(usage_row["storage_mb_used"]) if usage_row else 0.0
        sandbox_seconds_used = float(usage_row["sandbox_seconds_used"]) if usage_row else 0.0
        total_cost_usd = float(usage_row["total_cost_usd"]) if usage_row else 0.0

        # Use tier limits as the effective limits if the DB row has zeros or is missing values
        def _limit(val, fallback):
            return int(val) if val and int(val) > 0 else fallback

        jobs_soft = _limit(limits.get("jobs_soft_limit"), tier.jobs_soft_limit)
        jobs_hard = _limit(limits.get("jobs_hard_limit"), tier.jobs_hard_limit)
        tokens_soft = _limit(limits.get("tokens_soft_limit"), tier.tokens_soft_limit)
        tokens_hard = _limit(limits.get("tokens_hard_limit"), tier.tokens_hard_limit)
        storage_soft = _limit(limits.get("storage_mb_soft_limit"), tier.storage_mb_soft_limit)
        storage_hard = _limit(limits.get("storage_mb_hard_limit"), tier.storage_mb_hard_limit)
        sandbox_soft = _limit(limits.get("sandbox_seconds_soft_limit"), tier.sandbox_seconds_soft_limit)
        sandbox_hard = _limit(limits.get("sandbox_seconds_hard_limit"), tier.sandbox_seconds_hard_limit)

        def _pct(used, limit):
            return round((used / limit) * 100, 1) if limit > 0 else 0.0

        def _status(used, soft, hard):
            if hard > 0 and used >= hard:
                return "hard_exceeded"
            if soft > 0 and used >= soft:
                return "soft_exceeded"
            return "ok"

        # Fetch seats and references usage from org_plans
        seats_used = int(limits.get("seats_used", 0)) if limits else 0
        references_used = int(limits.get("references_used", 0)) if limits else 0
        seats_soft = _limit(limits.get("seats_limit"), tier.seats_limit) if tier.seats_limit > 0 else 0
        seats_hard = seats_soft
        refs_soft = _limit(limits.get("references_limit"), tier.references_limit) if tier.references_limit > 0 else 0
        refs_hard = refs_soft

        return {
            "org_id": org_id,
            "plan_name": plan_name,
            "period": "month",
            "period_start": month_start.isoformat(),
            "jobs": {
                "used": jobs_used,
                "soft_limit": jobs_soft,
                "hard_limit": jobs_hard,
                "percentage": _pct(jobs_used, jobs_hard),
                "status": _status(jobs_used, jobs_soft, jobs_hard),
            },
            "tokens": {
                "used": tokens_used,
                "soft_limit": tokens_soft,
                "hard_limit": tokens_hard,
                "percentage": _pct(tokens_used, tokens_hard),
                "status": _status(tokens_used, tokens_soft, tokens_hard),
            },
            "storage_mb": {
                "used": storage_mb_used,
                "soft_limit": storage_soft,
                "hard_limit": storage_hard,
                "percentage": _pct(storage_mb_used, storage_hard),
                "status": _status(storage_mb_used, storage_soft, storage_hard),
            },
            "sandbox_seconds": {
                "used": sandbox_seconds_used,
                "soft_limit": sandbox_soft,
                "hard_limit": sandbox_hard,
                "percentage": _pct(sandbox_seconds_used, sandbox_hard),
                "status": _status(sandbox_seconds_used, sandbox_soft, sandbox_hard),
            },
            "seats": {
                "used": seats_used,
                "soft_limit": seats_soft,
                "hard_limit": seats_hard,
                "percentage": _pct(seats_used, seats_hard),
                "status": _status(seats_used, seats_soft, seats_hard),
            },
            "references": {
                "used": references_used,
                "soft_limit": refs_soft,
                "hard_limit": refs_hard,
                "percentage": _pct(references_used, refs_hard),
                "status": _status(references_used, refs_soft, refs_hard),
            },
            "total_cost_usd": round(total_cost_usd, 4),
        }

    async def get_daily_usage_series(
        self,
        org_id: str,
        days: int = 30,
    ) -> list[dict]:
        """Return a daily time-series of usage for dashboard charts."""
        now = datetime.now(timezone.utc)
        start = now - timedelta(days=days)

        client = await get_postgres_client()
        query = """
            SELECT
                DATE(created_at) as day,
                event_type,
                resource,
                COALESCE(SUM(quantity), 0) as total_quantity,
                COALESCE(SUM(cost_usd), 0) as total_cost_usd
            FROM usage_events
            WHERE org_id = $1
              AND created_at >= $2
            GROUP BY DATE(created_at), event_type, resource
            ORDER BY day ASC, event_type, resource
        """
        rows = await client.fetch(query, org_id, start)
        return [
            {
                "day": r["day"].isoformat() if r.get("day") else None,
                "event_type": r["event_type"],
                "resource": r["resource"],
                "total_quantity": float(r["total_quantity"]),
                "total_cost_usd": float(r["total_cost_usd"]),
            }
            for r in rows
        ]

    # ──────────────────────────────────────────────────────────────────────
    # Helpers
    # ──────────────────────────────────────────────────────────────────────

    @staticmethod
    def _period_start(now: datetime, period: str) -> datetime:
        """Compute the start of the current billing period."""
        if period == "day":
            return now.replace(hour=0, minute=0, second=0, microsecond=0)
        elif period == "week":
            start = now - timedelta(days=now.weekday())
            return start.replace(hour=0, minute=0, second=0, microsecond=0)
        elif period == "month":
            return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        elif period == "year":
            return now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        else:
            return now - timedelta(days=30)


# Singleton convenience instance
_usage_service: Optional[UsageService] = None


async def get_usage_service() -> UsageService:
    """Get the singleton UsageService instance."""
    global _usage_service
    if _usage_service is None:
        _usage_service = UsageService()
    return _usage_service
