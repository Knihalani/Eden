"""EvolutionSpendBudget — Eden ops $ cap for background authoring.

OOM W3-5: LaneDailyBudget — system-wide per-lane daily LLM caps enforced at
every internal-LLM chokepoint (annotator, soft_issue, clusterer, judges,
evolution, investigation).  Redis-backed atomic daily totals; **fail-open**
(allow the call through + log a WARNING) when Redis is unavailable so a cache
outage never silently stops observability lanes.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime
from typing import Any

logger = logging.getLogger(__name__)

# ── OOM W3-5 — per-lane Redis-backed daily spend gate ────────────────────────

_LANE_BUDGET_PREFIX = "llm_budget:"


def _today_str() -> str:
    return date.today().isoformat()


async def _get_redis() -> Any | None:
    """Return the Redis client or None if unavailable (fail-open)."""
    try:
        from eden.storage.redis import get_redis_client

        return await get_redis_client()
    except Exception:
        return None


def _lane_cap_usd(lane: str) -> float:
    """Read per-lane daily cap from Settings; 0.0 means unlimited."""
    # OOM W3-5 — map lane name → settings field
    _LANE_FIELD: dict[str, str] = {
        "annotator": "annotator_daily_budget_usd",
        "soft_issue": "soft_issue_daily_budget_usd",
        "clusterer": "clusterer_daily_budget_usd",
        "judges": "judges_daily_budget_usd",
        "evolution": "evolution_daily_budget_usd",
        "investigation": "investigation_daily_budget_usd",
    }
    field = _LANE_FIELD.get(lane)
    if not field:
        return 0.0  # unknown lane → unlimited
    try:
        from eden.config import get_settings

        return max(0.0, float(getattr(get_settings(), field, 0.0) or 0.0))
    except Exception:
        return 0.0


class LaneDailyBudget:
    """System-wide per-lane daily LLM spend gate.  OOM W3-5.

    Tracks real-time spend in Redis using ``INCRBYFLOAT`` with a 25-hour TTL
    (covers the full UTC day plus one hour for clock skew).  Each call to
    :meth:`check` returns ``(allowed, spent_usd, cap_usd)``.

    **Fail-open contract**: if Redis is unavailable the check returns
    ``(True, 0.0, cap)`` and logs a WARNING so the lane continues rather
    than blocking observability on a cache outage.  Only when the budget is
    positively known to be exceeded does the gate return ``False``.

    **Per-lane isolation**: lanes share the same Redis cluster but use
    separate keys, so overrunning the annotator budget has no effect on the
    evolution lane.
    """

    def __init__(self, lane: str) -> None:
        self.lane = lane

    def _redis_key(self) -> str:
        return f"{_LANE_BUDGET_PREFIX}{self.lane}:{_today_str()}"

    def cap_usd(self) -> float:
        return _lane_cap_usd(self.lane)

    async def spent_today_usd(self) -> float | None:
        """Return today's accumulated spend, or ``None`` when Redis is down."""
        redis = await _get_redis()
        if redis is None:
            return None
        try:
            raw = await redis.get(self._redis_key())
            return float(raw) if raw else 0.0
        except Exception as exc:
            logger.debug("lane_budget[%s]: spent_today_usd failed: %s", self.lane, exc)
            return None

    async def check(self, estimated_usd: float = 0.0) -> tuple[bool, float, float]:
        """Return ``(allowed, spent_usd, cap_usd)``.

        Fail-open: when Redis is unavailable, allowed is ``True`` and spent is
        reported as 0.0 so callers can log it and continue.
        """
        cap = self.cap_usd()
        if cap <= 0.0:
            # Unlimited — skip Redis round-trip entirely.
            return True, 0.0, cap

        spent = await self.spent_today_usd()
        if spent is None:
            # Redis down → fail open.
            logger.warning(
                "lane_budget[%s]: Redis unavailable — allowing LLM call (fail-open)",
                self.lane,
            )
            return True, 0.0, cap

        allowed = (spent + estimated_usd) <= cap
        return allowed, spent, cap

    async def record(self, cost_usd: float) -> None:
        """Increment today's Redis counter by ``cost_usd``.

        Uses ``INCRBYFLOAT`` (atomic) and sets a 25-hour TTL on first write.
        Failures are logged at DEBUG and never raised — budget tracking must
        not interrupt the LLM call path.
        """
        if cost_usd <= 0.0:
            return
        redis = await _get_redis()
        if redis is None:
            return
        key = self._redis_key()
        try:
            await redis.incrbyfloat(key, cost_usd)
            # 25 h TTL covers the full UTC day plus one hour for clock skew.
            await redis.expire(key, 90_000)
        except Exception as exc:
            logger.debug("lane_budget[%s]: record failed: %s", self.lane, exc)

    async def status(self) -> dict[str, Any]:
        cap = self.cap_usd()
        spent_or_none = await self.spent_today_usd()
        spent = spent_or_none if spent_or_none is not None else 0.0
        return {
            "lane": self.lane,
            "cap_usd": cap,
            "spent_usd": spent,
            "remaining_usd": max(0.0, cap - spent) if cap > 0.0 else None,
        }


class EvolutionSpendBudget:
    """Track and gate Eden ops spend per org per day via budget_service."""

    def __init__(self, org_id: str) -> None:
        self.org_id = org_id

    async def daily_cap_usd(self) -> float:
        from eden.config import get_settings

        return float(get_settings().max_evolution_ops_usd_per_org_day)

    async def spent_today_usd(self) -> float:
        """Sum today's ledgered OpenRouter spend for evolution-adjacent features."""
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return 0.0
            day_start = datetime.now(UTC).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            val = await client.fetchval(
                """
                SELECT COALESCE(SUM(cost_usd), 0)
                FROM customer_cost_events
                WHERE org_id = $1
                  AND feature = ANY($2::text[])
                  AND recorded_at >= $3
                """,
                self.org_id,
                ["evolution", "nudge_author"],
                day_start,
            )
            return float(val or 0.0)
        except Exception as exc:
            logger.debug("evolution_spend: spent_today failed: %s", exc)
            return 0.0

    async def may_spend(self, estimated_usd: float = 0.0) -> bool:
        cap = await self.daily_cap_usd()
        spent = await self.spent_today_usd()
        return (spent + estimated_usd) <= cap

    async def record(self, cost_usd: float, *, kind: str, ref_id: str = "") -> None:
        """Insert into evolution_ops_spend only (no customer CostEvent)."""
        if cost_usd <= 0:
            return
        try:
            from uuid import uuid4

            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return
            await client.execute(
                """
                INSERT INTO evolution_ops_spend
                    (id, org_id, kind, ref_id, cost_usd, recorded_at)
                VALUES ($1, $2, $3, $4, $5, now())
                """,
                uuid4(),
                self.org_id,
                kind,
                ref_id,
                cost_usd,
            )
        except Exception as exc:
            logger.debug("evolution_spend: record failed: %s", exc)

    async def status(self) -> dict[str, Any]:
        cap = await self.daily_cap_usd()
        spent = await self.spent_today_usd()
        return {
            "cap_usd": cap,
            "spent_usd": spent,
            "remaining_usd": max(0.0, cap - spent),
        }
