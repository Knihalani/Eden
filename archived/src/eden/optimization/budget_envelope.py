"""BudgetEnvelope — shared budget-status type for the F83 unify plan.

Both ``budget_service`` (PG-backed org enforcement) and ``CostTracker``
(Redis-backed per-request analytics) produce budget status, but in
different shapes.  This module provides a single ``BudgetEnvelope``
dataclass that either system can construct so call-sites, dashboards, and
tests share one vocabulary rather than two.

Full merge of ``budget_service`` and ``CostTracker`` is deferred (they
track different windows and storage backends — see F83 §6 gap note).
This type is the concrete ``BudgetEnvelope`` step that closes the
interface gap without breaking existing callers.

Usage from budget_service::

    from eden.optimization.budget_envelope import BudgetEnvelope
    cfg  = await budget_service.get_budget(org_id)
    cons = await budget_service.get_consumption(org_id)
    env  = BudgetEnvelope.from_budget_service(cfg, cons)

Usage from CostTracker::

    from eden.optimization.budget_envelope import BudgetEnvelope
    stats = tracker.get_stats()
    env   = BudgetEnvelope.from_cost_tracker(org_id, stats)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime


@dataclass
class BudgetEnvelope:
    """Normalised budget-status snapshot.

    Attributes:
        org_id: The organisation this envelope describes.
        window: Time window granularity (``monthly``, ``daily``, ``weekly``).
        cost_usd: Cost incurred in the current window (USD).
        soft_limit_usd: Warning threshold (USD). ``inf`` = no soft limit.
        hard_limit_usd: Enforcement threshold (USD). ``inf`` = no hard limit.
        utilisation_pct: ``cost_usd / hard_limit_usd * 100``, capped at 100.
        status: One of ``ok``, ``soft_limit``, ``hard_limit``.
        source: Which system produced this snapshot (``budget_service`` or
            ``cost_tracker``).
        snapshot_at: ISO-8601 timestamp of when the envelope was built.
    """

    org_id: str
    window: str
    cost_usd: float
    soft_limit_usd: float
    hard_limit_usd: float
    utilisation_pct: float
    status: str
    source: str
    snapshot_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )

    # Status constants (mirrors CostTracker.BudgetStatus)
    STATUS_OK = "ok"
    STATUS_SOFT = "soft_limit"
    STATUS_HARD = "hard_limit"

    @classmethod
    def from_budget_service(
        cls,
        cfg: dict,
        consumption: dict,
    ) -> BudgetEnvelope:
        """Construct from ``budget_service.get_budget`` + ``get_consumption`` dicts."""
        soft = float(cfg.get("cost_soft_limit_usd", float("inf")))
        hard = float(cfg.get("cost_hard_limit_usd", float("inf")))
        cost = float(consumption.get("cost_usd", 0.0))
        window = str(cfg.get("window", consumption.get("window", "monthly")))

        util = min(100.0, cost / hard * 100) if hard > 0 and hard != float("inf") else 0.0

        if cost >= hard:
            status = cls.STATUS_HARD
        elif cost >= soft:
            status = cls.STATUS_SOFT
        else:
            status = cls.STATUS_OK

        return cls(
            org_id=str(cfg.get("org_id", consumption.get("org_id", ""))),
            window=window,
            cost_usd=round(cost, 6),
            soft_limit_usd=soft,
            hard_limit_usd=hard,
            utilisation_pct=round(util, 2),
            status=status,
            source="budget_service",
        )

    @classmethod
    def from_cost_tracker(
        cls,
        org_id: str,
        stats: dict,
        *,
        window: str = "session",
        soft_limit_cents: float = float("inf"),
        hard_limit_cents: float = float("inf"),
    ) -> BudgetEnvelope:
        """Construct from ``CostTracker.get_stats()`` output.

        ``CostTracker`` accumulates in cents; this method converts to USD
        to produce a uniform ``BudgetEnvelope``.
        """
        cost_cents = float(stats.get("total_tracked_cents", 0.0))
        cost_usd = cost_cents / 100.0
        soft_usd = soft_limit_cents / 100.0
        hard_usd = hard_limit_cents / 100.0

        if hard_usd > 0 and hard_usd != float("inf"):
            util = min(100.0, cost_usd / hard_usd * 100)
        else:
            util = 0.0

        if cost_cents >= hard_limit_cents:
            status = cls.STATUS_HARD
        elif cost_cents >= soft_limit_cents:
            status = cls.STATUS_SOFT
        else:
            status = cls.STATUS_OK

        return cls(
            org_id=org_id,
            window=window,
            cost_usd=round(cost_usd, 6),
            soft_limit_usd=soft_usd,
            hard_limit_usd=hard_usd,
            utilisation_pct=round(util, 2),
            status=status,
            source="cost_tracker",
        )

    def is_over_soft(self) -> bool:
        return self.status in (self.STATUS_SOFT, self.STATUS_HARD)

    def is_over_hard(self) -> bool:
        return self.status == self.STATUS_HARD

    def as_dict(self) -> dict:
        return {
            "org_id": self.org_id,
            "window": self.window,
            "cost_usd": self.cost_usd,
            "soft_limit_usd": self.soft_limit_usd,
            "hard_limit_usd": self.hard_limit_usd,
            "utilisation_pct": self.utilisation_pct,
            "status": self.status,
            "source": self.source,
            "snapshot_at": self.snapshot_at,
        }
