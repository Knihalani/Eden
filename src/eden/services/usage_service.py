"""Usage tracking, aggregation, and cost attribution service.

Provides high-level APIs for:
- Recording granular usage events (tokens, jobs, storage, sandbox)
- Aggregating usage by resource, time period, user, job, or model
- Computing real-time spend and budget status against plan limits
- Syncing quota counters from usage_events to org_resource_limits

Primary free-tier meter is **credits** (100 credits = $1 Eden COGS).
USD mirrors remain for FinOps. Spend is the sum of ``usage_events``
(customer telemetry) and ``customer_cost_events`` (platform LLM).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.services.plan_tiers import (
    get_plan_tier,
    usd_to_credits,
)
from eden.storage.postgres import get_postgres_client
from eden.util.jsonx import dumps as _jsonx_dumps

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
        user_id: str | None = None,
        model: str | None = None,
        cost_usd: float | None = None,
        metadata: dict | None = None,
        correlation_id: str | None = None,
    ) -> str | None:
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

    async def track_events_batch(self, events: list[dict[str, Any]]) -> int:
        """Record many usage events in one round trip via ``executemany``.

        Phase 3 (ingest hot-path batching): ``_emit_billing_events`` used to
        call :meth:`track_event` once per billable event in the batch, each
        opening its own single-row INSERT. This collects the whole batch
        into one ``executemany`` — the same pattern
        :mod:`eden.data_platform.bronze_sink` already uses for its
        higher-volume Bronze-layer buffer (``client.acquire()`` +
        ``conn.executemany`` because asyncpg's ``executemany`` needs a
        ``Connection``, not a ``Pool``).

        Each ``events`` entry accepts the same keys as :meth:`track_event`'s
        keyword arguments (``org_id``, ``event_type``, ``resource``,
        ``quantity``, ``unit`` are required; the rest default the same way).
        Unlike :meth:`track_event`, this does not return per-row ids — no
        caller of the batch path (billing roll-up) uses them, and fetching
        ids back would cost a ``RETURNING`` per row anyway, defeating the
        point of batching.

        Returns the number of events accepted for the write attempt (not
        confirmed committed rows) so the caller can log a count; on failure
        this logs and returns 0 rather than raising, matching
        :meth:`track_event`'s fail-open contract (usage tracking must never
        break ingest).
        """
        if not events:
            return 0
        rows = [
            (
                e["org_id"],
                e.get("user_id"),
                e["event_type"],
                e["resource"],
                e["quantity"],
                e["unit"],
                e.get("model"),
                e.get("cost_usd"),
                _jsonx_dumps(e.get("metadata") or {}),
                e.get("correlation_id"),
            )
            for e in events
        ]
        query = """
            INSERT INTO usage_events (
                org_id, user_id, event_type, resource, quantity, unit,
                model, cost_usd, metadata, correlation_id, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        """
        try:
            client = await get_postgres_client()
            # asyncpg executemany requires a Connection, not a Pool.
            async with client.acquire() as conn:
                await conn.executemany(query, rows)
            return len(rows)
        except Exception as e:
            logger.warning(f"Failed to track usage events batch ({len(rows)} events): {e}")
            return 0

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
        """Return total spend for the current billing period.

        Combines customer telemetry (``usage_events``) with Eden platform
        LLM COGS (``customer_cost_events``) so free-tier credits track
        both ingest-attributed cost and OpenRouter / gateway spend.
        """
        now = datetime.now(UTC)
        start = self._period_start(now, period)

        client = await get_postgres_client()
        total_cost_usd = await self._sum_org_cost_usd(client, org_id, start)
        query = """
            SELECT
                COALESCE(SUM(quantity) FILTER (WHERE event_type = 'llm_call'), 0) as total_tokens,
                COALESCE(SUM(quantity) FILTER (WHERE event_type = 'job_start'), 0) as total_jobs,
                COALESCE(SUM(quantity) FILTER (WHERE resource = 'storage_mb'), 0) as total_storage_mb,
                COUNT(*) as total_events
            FROM usage_events
            WHERE org_id = $1
              AND created_at >= $2
        """
        row = await client.fetchrow(query, org_id, start)
        credits_used = usd_to_credits(total_cost_usd)
        return {
            "period": period,
            "period_start": start.isoformat(),
            "period_end": now.isoformat(),
            "total_cost_usd": total_cost_usd,
            "credits_used": credits_used,
            "total_tokens": float(row["total_tokens"]) if row else 0.0,
            "total_jobs": float(row["total_jobs"]) if row else 0.0,
            "total_storage_mb": float(row["total_storage_mb"]) if row else 0.0,
            "total_events": row["total_events"] if row else 0,
        }

    @staticmethod
    async def _sum_org_cost_usd(client: Any, org_id: str, start: datetime) -> float:
        """Sum monthly Eden COGS for credits enforcement.

        Sources (best-effort; missing tables → 0):

        - ``usage_events`` — customer telemetry / ingest-priced calls
        - ``customer_cost_events`` — platform LLM via the cost ledger
          (judges, Improve, chat, OpenRouter paths, …)
        - ``budget_consumption`` (monthly window) — gateway + CostTracker
          and any path that only mirrors into the budget service

        OpenRouter / cost_ledger dual-writes ``customer_cost_events`` *and*
        ``budget_consumption``, so we take ``max(events_sum, budget)``
        instead of adding them — otherwise the same dollars would count
        twice against the free-tier credit cap.
        """
        usage = 0.0
        platform = 0.0
        budget = 0.0
        try:
            row = await client.fetchrow(
                """
                SELECT COALESCE(SUM(cost_usd), 0) AS total
                FROM usage_events
                WHERE org_id = $1 AND created_at >= $2
                """,
                org_id,
                start,
            )
            usage = float(row["total"]) if row else 0.0
        except Exception as exc:
            logger.debug("usage_events cost sum failed: %s", exc)
        try:
            row = await client.fetchrow(
                """
                SELECT COALESCE(SUM(cost_usd), 0) AS total
                FROM customer_cost_events
                WHERE org_id = $1 AND recorded_at >= $2
                """,
                org_id,
                start,
            )
            platform = float(row["total"]) if row else 0.0
        except Exception as exc:
            logger.debug("customer_cost_events cost sum failed: %s", exc)
        try:
            # Monthly window_start aligns with plan-tier month boundaries
            # (UTC first-of-month). Daily/weekly rows are ignored here —
            # credits are a monthly free-tier cap.
            row = await client.fetchrow(
                """
                SELECT COALESCE(SUM(cost_usd), 0) AS total
                FROM budget_consumption
                WHERE org_id = $1
                  AND "window" = 'monthly'
                  AND window_start >= $2
                """,
                org_id,
                start,
            )
            budget = float(row["total"]) if row else 0.0
        except Exception as exc:
            logger.debug("budget_consumption cost sum failed: %s", exc)
        events_sum = usage + platform
        return round(max(events_sum, budget), 6)

    async def get_budget_status(self, org_id: str) -> dict:
        """Return current usage vs plan limits with soft/hard limit flags.

        Queries real-time aggregates from usage_events and compares them
        against the org's active resource limits.
        """
        client = await get_postgres_client()

        # Get the active resource limits row
        limits = await client.get_org_resource_limits(org_id)
        if not limits:
            # No limits configured — create a default free-tier record.
            # Ponytail: empty limits row would deny everything via 0/0,
            # so write the ``org_free`` row inline. The migration
            # ``046_free_only_default_plan`` backfills old orgs at
            # upgrade time, so this branch fires only for genuinely
            # new orgs that race the create_org inserts.
            logger.warning(f"No resource limits found for org {org_id}; creating org_free defaults")
            await client.set_org_resource_limits(org_id, plan_name="org_free")
            limits = await client.get_org_resource_limits(org_id)

        plan_name = limits.get("plan_name", "org_free") if limits else "org_free"
        tier = get_plan_tier(plan_name)

        now = datetime.now(UTC)
        month_start = self._period_start(now, "month")

        # Aggregate actual usage from usage_events for the current month
        # (jobs feature removed June 2026 — no longer tracked)
        usage_query = """
            SELECT
                COALESCE(SUM(quantity) FILTER (WHERE event_type = 'llm_call'), 0) as tokens_used,
                COALESCE(SUM(quantity) FILTER (WHERE resource = 'storage_mb'), 0) as storage_mb_used,
                COALESCE(SUM(quantity) FILTER (WHERE resource = 'sandbox_seconds'), 0) as sandbox_seconds_used
            FROM usage_events
            WHERE org_id = $1
              AND created_at >= $2
        """
        usage_row = await client.fetchrow(usage_query, org_id, month_start)
        total_cost_usd = await self._sum_org_cost_usd(client, org_id, month_start)

        tokens_used = float(usage_row["tokens_used"]) if usage_row else 0.0
        storage_mb_used = float(usage_row["storage_mb_used"]) if usage_row else 0.0
        sandbox_seconds_used = float(usage_row["sandbox_seconds_used"]) if usage_row else 0.0
        credits_used = usd_to_credits(total_cost_usd)

        def _limit(val, fallback):
            return int(val) if val and int(val) > 0 else fallback

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
            "cost_usd": {
                # USD mirror of credits — kept for FinOps / legacy headers.
                "used": round(total_cost_usd, 4),
                "soft_limit": round(float(limits.get("cost_soft_limit_usd") or tier.cost_soft_limit_usd), 4),
                "hard_limit": round(float(limits.get("cost_hard_limit_usd") or tier.cost_hard_limit_usd), 4),
                "percentage": _pct(total_cost_usd, float(limits.get("cost_hard_limit_usd") or tier.cost_hard_limit_usd)),
                "status": _status(
                    total_cost_usd,
                    float(limits.get("cost_soft_limit_usd") or tier.cost_soft_limit_usd),
                    float(limits.get("cost_hard_limit_usd") or tier.cost_hard_limit_usd),
                ),
            },
            "credits": {
                # PRIMARY free-tier enforcement lever (100 credits = $1).
                "used": credits_used,
                "soft_limit": int(getattr(tier, "credits_soft_limit", 0) or 0),
                "hard_limit": int(getattr(tier, "credits_hard_limit", 0) or 0),
                "percentage": _pct(
                    credits_used,
                    float(getattr(tier, "credits_hard_limit", 0) or 0),
                ),
                "status": _status(
                    credits_used,
                    float(getattr(tier, "credits_soft_limit", 0) or 0),
                    float(getattr(tier, "credits_hard_limit", 0) or 0),
                ),
            },
            "total_cost_usd": round(total_cost_usd, 4),
            "credits_used": credits_used,
        }

    async def get_daily_usage_series(
        self,
        org_id: str,
        days: int = 30,
    ) -> list[dict]:
        """Return a daily time-series of usage for dashboard charts."""
        now = datetime.now(UTC)
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
_usage_service: UsageService | None = None


async def get_usage_service() -> UsageService:
    """Get the singleton UsageService instance."""
    global _usage_service
    if _usage_service is None:
        _usage_service = UsageService()
    return _usage_service
