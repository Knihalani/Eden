"""Budget service — D.10 cost guardrails (upgradespec §6.3).

The service reads from the three D.10 tables
(``budgets``, ``budget_consumption``, ``budget_actions``)
introduced in migration 052:

* :meth:`get_budget` — the per-org config (or default
  free-tier values if no row exists).
* :meth:`get_consumption` — current window's cost rollup
  for the org (monthly by default).
* :meth:`record_usage` — increment the active window's
  cost + request counter (called by the gateway ingest
  hot path).
* :meth:`list_actions` — recent threshold/exceeded
  audit-log entries (portal ticker).
* :meth:`upsert_budget` — admin endpoint to update the
  config (org owner only).

The service degrades gracefully: every fetcher is best-
effort so an empty database returns the free-tier
defaults rather than 500ing. The actual enforcement is
done by the existing
:class:`QuotaEnforcementMiddleware` via
:class:`UsageService.get_budget_status`; this service
is the read surface for the portal admin + ticker UI.

See ``docs/spec/upgradespec-original-2026-06.md`` §D.10 /
§B.3 / §C.3 for the full data model + API contract.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)


# Free-tier defaults applied when no ``budgets`` row exists
# for the org. Mirrors the cost_hard_limit_usd seeded in the
# free-tier plan_tiers table.
FREE_TIER_DEFAULTS: dict[str, Any] = {
    "window": "monthly",
    "cost_soft_limit_usd": 0.80,
    "cost_hard_limit_usd": 1.00,
    "enforcement_enabled": False,
    "action_on_exceed": "throttle",
    "threshold_alert_pct": 80,
}


def _new_budget_id() -> str:
    """Deterministic-ish budget id (``bud_<16-hex>``)."""
    return f"bud_{uuid.uuid4().hex[:16]}"


def _window_start(window: str, now: datetime | None = None) -> datetime:
    """Return the start of the current budget window."""
    now = now or datetime.now(UTC)
    if window == "daily":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    if window == "weekly":
        start = now - timedelta(days=now.weekday())
        return start.replace(hour=0, minute=0, second=0, microsecond=0)
    # monthly (default)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def _get_client():
    """Lazily import the postgres client (deferred for testability)."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("budget_service: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("budget_service: get_postgres_client failed: %s", exc)
        return None


async def get_budget(org_id: str) -> dict[str, Any]:
    """Return the per-org budget config.

    Falls back to :data:`FREE_TIER_DEFAULTS` when no row
    exists (the common case for new orgs). Best-effort:
    any DB error returns the defaults.
    """
    client = await _get_client()
    if client is None:
        return {"org_id": org_id, **FREE_TIER_DEFAULTS, "source": "defaults"}
    try:
        row = await client.fetchrow(
            """
            SELECT id, org_id, window, cost_soft_limit_usd,
                   cost_hard_limit_usd, enforcement_enabled,
                   action_on_exceed, threshold_alert_pct
              FROM budgets
             WHERE org_id = $1
             ORDER BY updated_at DESC
             LIMIT 1
            """,
            org_id,
        )
    except Exception as exc:
        logger.debug("budget_service: get_budget failed: %s", exc)
        return {"org_id": org_id, **FREE_TIER_DEFAULTS, "source": "defaults"}
    if row is None:
        return {"org_id": org_id, **FREE_TIER_DEFAULTS, "source": "defaults"}
    d = dict(row)
    d["source"] = "db"
    return d


async def get_consumption(
    org_id: str,
    *,
    window: str = "monthly",
) -> dict[str, Any]:
    """Return the current window's cost rollup for the org.

    Falls back to zeros when no row exists. Best-effort.
    """
    client = await _get_client()
    if client is None:
        return {
            "org_id": org_id,
            "window": window,
            "cost_usd": 0.0,
            "requests_count": 0,
            "source": "defaults",
        }
    start = _window_start(window)
    try:
        row = await client.fetchrow(
            """
            SELECT cost_usd, requests_count, window_start, window_end
              FROM budget_consumption
             WHERE org_id = $1 AND window = $2 AND window_start = $3
             LIMIT 1
            """,
            org_id,
            window,
            start,
        )
    except Exception as exc:
        logger.debug("budget_service: get_consumption failed: %s", exc)
        return {
            "org_id": org_id,
            "window": window,
            "cost_usd": 0.0,
            "requests_count": 0,
            "source": "defaults",
        }
    if row is None:
        return {
            "org_id": org_id,
            "window": window,
            "window_start": start.isoformat(),
            "cost_usd": 0.0,
            "requests_count": 0,
            "source": "defaults",
        }
    return {
        "org_id": org_id,
        "window": window,
        "window_start": row["window_start"].isoformat(),
        "window_end": row["window_end"].isoformat(),
        "cost_usd": float(row["cost_usd"]),
        "requests_count": int(row["requests_count"]),
        "source": "db",
    }


async def record_usage(
    org_id: str,
    cost_usd: float,
    *,
    window: str = "monthly",
) -> bool:
    """Increment the active window's cost + request counter.

    Called by the gateway ingest hot path on every successful
    request. Uses a single upsert so concurrent calls don't
    race. Best-effort: any DB error returns ``False`` and
    logs — the gateway should still serve the request.

    Returns ``True`` when the row was written, ``False``
    otherwise.
    """
    if cost_usd <= 0:
        return False
    client = await _get_client()
    if client is None:
        return False
    start = _window_start(window)
    if window == "daily":
        end = start + timedelta(days=1)
    elif window == "weekly":
        end = start + timedelta(days=7)
    else:
        # monthly: next month start
        if start.month == 12:
            end = start.replace(year=start.year + 1, month=1)
        else:
            end = start.replace(month=start.month + 1)
    try:
        await client.execute(
            """
            INSERT INTO budget_consumption (
                id, org_id, window, window_start, window_end,
                cost_usd, requests_count, last_request_at,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, 1, NOW(), NOW(), NOW()
            )
            ON CONFLICT (org_id, window, window_start)
            WHERE window_end > NOW()
            DO UPDATE SET
                cost_usd = budget_consumption.cost_usd + EXCLUDED.cost_usd,
                requests_count = budget_consumption.requests_count + 1,
                last_request_at = NOW(),
                updated_at = NOW()
            """,
            uuid.uuid4(),
            org_id,
            window,
            start,
            end,
            cost_usd,
        )
        return True
    except Exception as exc:
        logger.debug("budget_service: record_usage failed: %s", exc)
        return False


async def list_actions(
    org_id: str,
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return recent threshold/exceeded audit-log entries."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, org_id, budget_id, action_type, severity,
                   cost_at_action, threshold_pct, action_taken,
                   request_id, hook_event_id, created_at
              FROM budget_actions
             WHERE org_id = $1
             ORDER BY created_at DESC
             LIMIT $2
            """,
            org_id,
            int(limit),
        )
    except Exception as exc:
        logger.debug("budget_service: list_actions failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        d = dict(row)
        if isinstance(d.get("created_at"), datetime):
            d["created_at"] = d["created_at"].isoformat()
        out.append(d)
    return out


async def record_action(
    org_id: str,
    *,
    budget_id: str,
    action_type: str,
    severity: str,
    cost_at_action: float,
    threshold_pct: int,
    action_taken: str,
    request_id: str | None = None,
    hook_event_id: str | None = None,
) -> bool:
    """Append a row to ``budget_actions`` (the audit log).

    Called by the closed-loop
    :class:`BudgetHook.on_threshold_breached` /
    :class:`BudgetHook.on_exceeded` callbacks. Returns
    ``True`` when the row was written.
    """
    client = await _get_client()
    if client is None:
        return False
    try:
        await client.execute(
            """
            INSERT INTO budget_actions (
                id, org_id, budget_id, action_type, severity,
                cost_at_action, threshold_pct, action_taken,
                request_id, hook_event_id, created_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()
            )
            """,
            uuid.uuid4(),
            org_id,
            budget_id,
            action_type,
            severity,
            cost_at_action,
            int(threshold_pct),
            action_taken,
            request_id,
            hook_event_id,
        )
        return True
    except Exception as exc:
        logger.debug("budget_service: record_action failed: %s", exc)
        return False


async def upsert_budget(
    org_id: str,
    *,
    cost_soft_limit_usd: float,
    cost_hard_limit_usd: float,
    enforcement_enabled: bool,
    window: str = "monthly",
    action_on_exceed: str = "throttle",
    threshold_alert_pct: int = 80,
) -> dict[str, Any]:
    """Admin endpoint: upsert the per-org budget config.

    Org-owner gated. Returns the persisted row. Creates
    a new row if no budget exists for the org.
    """
    client = await _get_client()
    budget_id = _new_budget_id()
    if client is None:
        return {
            "id": budget_id,
            "org_id": org_id,
            "window": window,
            "cost_soft_limit_usd": cost_soft_limit_usd,
            "cost_hard_limit_usd": cost_hard_limit_usd,
            "enforcement_enabled": enforcement_enabled,
            "action_on_exceed": action_on_exceed,
            "threshold_alert_pct": threshold_alert_pct,
            "source": "dry_run",
        }
    try:
        await client.execute(
            """
            INSERT INTO budgets (
                id, org_id, window, cost_soft_limit_usd,
                cost_hard_limit_usd, enforcement_enabled,
                action_on_exceed, threshold_alert_pct,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW()
            )
            ON CONFLICT (org_id, window) WHERE enforcement_enabled = TRUE
            DO UPDATE SET
                cost_soft_limit_usd = EXCLUDED.cost_soft_limit_usd,
                cost_hard_limit_usd = EXCLUDED.cost_hard_limit_usd,
                enforcement_enabled = EXCLUDED.enforcement_enabled,
                action_on_exceed = EXCLUDED.action_on_exceed,
                threshold_alert_pct = EXCLUDED.threshold_alert_pct,
                updated_at = NOW()
            """,
            budget_id,
            org_id,
            window,
            float(cost_soft_limit_usd),
            float(cost_hard_limit_usd),
            bool(enforcement_enabled),
            action_on_exceed,
            int(threshold_alert_pct),
        )
    except Exception as exc:
        logger.debug("budget_service: upsert_budget failed: %s", exc)
    return await get_budget(org_id)

__all__ = [
    "get_budget",
    "get_consumption",
    "record_usage",
    "list_actions",
    "record_action",
    "upsert_budget",
    "FREE_TIER_DEFAULTS",
]
