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
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# At most one full alert eval / org / window — cost events otherwise
# re-run get_budget + get_consumption + list_actions on every LLM $.
_ALERT_EVAL_DEBOUNCE_S = 45.0
_alert_eval_at: dict[str, float] = {}

_HTTPX: httpx.AsyncClient | None = None


def _shared_httpx(timeout: float) -> httpx.AsyncClient:
    """Process-wide httpx client — never ``async with`` this instance."""
    global _HTTPX
    if _HTTPX is None or _HTTPX.is_closed:
        _HTTPX = httpx.AsyncClient(timeout=timeout)
    return _HTTPX


# Free-tier defaults applied when no ``budgets`` row exists
# for the org. Mirrors the cost_hard_limit_usd seeded in the
# free-tier plan_tiers table.
DEFAULT_ALERT_THRESHOLDS: list[int] = [50, 80, 100]

FREE_TIER_DEFAULTS: dict[str, Any] = {
    "window": "monthly",
    "cost_soft_limit_usd": 3.2,    # ≈ 320 credits
    "cost_hard_limit_usd": 4.0,    # ≈ 400 credits (~$4 free beta MAX)
    "enforcement_enabled": True,    # hard-stop aligns with quota middleware
    "action_on_exceed": "throttle",
    "threshold_alert_pct": 80,
    "alert_thresholds": list(DEFAULT_ALERT_THRESHOLDS),
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


def _as_datetime(value: Any) -> datetime | None:
    """Coerce driver/JSON datetime shapes to aware UTC, or ``None``.

    Postgres async drivers may return ``datetime`` objects; JSON round-trips
    and mocked consumption rows usually return ISO-8601 strings (with or
    without a trailing ``Z``, with or without an offset). Unusable values
    return ``None`` without raising so alert dedup can fail safe.
    """
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


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

    Missing-row defaults always include
    ``enforcement_enabled=True`` (Wave 4) — never return a synthetic
    ``False`` that would disable hard caps for orgs without a row.
    """
    client = await _get_client()
    if client is None:
        return {"org_id": org_id, **FREE_TIER_DEFAULTS, "source": "defaults"}
    try:
        row = await client.fetchrow(
            """
            SELECT id, org_id, "window", cost_soft_limit_usd,
                   cost_hard_limit_usd, enforcement_enabled,
                   action_on_exceed, threshold_alert_pct,
                   alert_thresholds
              FROM budgets
             WHERE org_id = $1
             ORDER BY updated_at DESC
             LIMIT 1
            """,
            org_id,
        )
    except Exception as exc:
        # alert_thresholds may be missing pre-migration 107
        logger.debug("budget_service: get_budget failed: %s", exc)
        try:
            row = await client.fetchrow(
                """
                SELECT id, org_id, "window", cost_soft_limit_usd,
                       cost_hard_limit_usd, enforcement_enabled,
                       action_on_exceed, threshold_alert_pct
                  FROM budgets
                 WHERE org_id = $1
                 ORDER BY updated_at DESC
                 LIMIT 1
                """,
                org_id,
            )
        except Exception as exc2:
            logger.debug("budget_service: get_budget fallback failed: %s", exc2)
            return {"org_id": org_id, **FREE_TIER_DEFAULTS, "source": "defaults"}
    if row is None:
        return {"org_id": org_id, **FREE_TIER_DEFAULTS, "source": "defaults"}
    d = dict(row)
    d["source"] = "db"
    d["alert_thresholds"] = _normalize_thresholds(d.get("alert_thresholds"))
    # Defensive: treat NULL enforcement_enabled as True (Wave 4 free-tier).
    if d.get("enforcement_enabled") is None:
        d["enforcement_enabled"] = True
    return d


def _normalize_thresholds(raw: Any) -> list[int]:
    if raw is None:
        return list(DEFAULT_ALERT_THRESHOLDS)
    if isinstance(raw, str):
        import json

        try:
            raw = json.loads(raw)
        except Exception:
            return list(DEFAULT_ALERT_THRESHOLDS)
    if not isinstance(raw, (list, tuple)):
        return list(DEFAULT_ALERT_THRESHOLDS)
    out: list[int] = []
    for v in raw:
        try:
            iv = int(v)
        except (TypeError, ValueError):
            continue
        if 0 <= iv <= 100 and iv not in out:
            out.append(iv)
    return sorted(out) if out else list(DEFAULT_ALERT_THRESHOLDS)


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
             WHERE org_id = $1 AND "window" = $2 AND window_start = $3
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
    window: str | None = None,
) -> bool:
    """Increment the active window's cost + request counter.

    Called by the gateway ingest hot path on every successful
    request. Uses a single upsert so concurrent calls don't
    race. Best-effort: any DB error returns ``False`` and
    logs — the gateway should still serve the request.

    When ``window`` is omitted, uses the org budget config
    (via :func:`get_budget`) so consumption lands in the same
    window enforcement reads.

    Returns ``True`` when the row was written, ``False``
    otherwise.
    """
    if cost_usd <= 0:
        return False
    client = await _get_client()
    if client is None:
        return False
    if window is None:
        try:
            budget = await get_budget(org_id)
            window = str(budget.get("window") or "monthly")
        except Exception:
            window = "monthly"
    if window not in ("daily", "weekly", "monthly"):
        window = "monthly"
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
                id, org_id, "window", window_start, window_end,
                cost_usd, requests_count, last_request_at,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, 1, NOW(), NOW(), NOW()
            )
            -- No WHERE on the ON CONFLICT: the unique index
            -- ``idx_budget_consumption_active (org_id, window,
            -- window_start)`` is a FULL unique index, not a
            -- partial one. Postgres requires the WHERE clause
            -- in ON CONFLICT to match a partial index's
            -- predicate (or omit it for a full index).
            -- The previous ``WHERE window_end > NOW()`` had no
            -- matching partial index → Postgres raised
            -- ``there is no unique or exclusion constraint
            -- matching the ON CONFLICT specification`` and
            -- record_usage silently logged the failure at
            -- DEBUG, meaning every gateway-ingest hot-path
            -- call was a no-op. Removing the WHERE is safe:
            -- ``window_start`` is part of the unique key, so
            -- a new-month row never conflicts with the prior
            -- month's row anyway.
            ON CONFLICT (org_id, "window", window_start) DO UPDATE SET
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


async def evaluate_budget_alerts(org_id: str) -> list[int]:
    """Emit budget_actions for newly crossed 50/80/100% thresholds.

    Returns the list of threshold percents that fired this call.
    Idempotent per (org, window_start, threshold) via action log scan.

    Debounced per org (~45s) so the LLM/gateway cost hot path does not
    re-query budgets + actions on every dollar of spend. Threshold
    crossings still fire within one debounce window of first crossing.
    """
    now = time.monotonic()
    last = _alert_eval_at.get(org_id)
    if last is not None and (now - last) < _ALERT_EVAL_DEBOUNCE_S:
        return []
    _alert_eval_at[org_id] = now
    if len(_alert_eval_at) > 8192:
        stale = [
            k for k, t in _alert_eval_at.items()
            if (now - t) > _ALERT_EVAL_DEBOUNCE_S * 4
        ]
        for k in stale:
            _alert_eval_at.pop(k, None)

    budget = await get_budget(org_id)
    hard = float(budget.get("cost_hard_limit_usd") or 0.0)
    if hard <= 0:
        return []
    consumption = await get_consumption(org_id, window=budget.get("window", "monthly"))
    used = float(consumption.get("cost_usd") or 0.0)
    pct = (used / hard) * 100.0
    thresholds = _normalize_thresholds(budget.get("alert_thresholds"))
    # Always include legacy single threshold_alert_pct
    legacy = int(budget.get("threshold_alert_pct") or 80)
    if legacy not in thresholds:
        thresholds = sorted({*thresholds, legacy})

    fired: list[int] = []
    recent = await list_actions(org_id, limit=100)
    # ``record_action`` does not write ``window_start``; scope dedup by
    # ``created_at`` against the consumption window so alerts re-arm when
    # the billing window rolls.
    window_start = _as_datetime(consumption.get("window_start")) or _window_start(
        str(budget.get("window") or "monthly")
    )
    already: set[int] = set()
    for action in recent:
        if action.get("action_type") not in ("threshold_breached", "budget_alert"):
            continue
        created = _as_datetime(action.get("created_at"))
        # Fail safe: unreadable timestamps count as current-window so we
        # cannot duplicate-alert on corrupt audit rows.
        if created is None or created >= window_start:
            already.add(int(action.get("threshold_pct") or 0))

    for t in thresholds:
        if pct < float(t):
            continue
        if t in already:
            continue
        severity = "info" if t < 80 else ("warning" if t < 100 else "critical")
        ok = await record_action(
            org_id,
            action_type="budget_alert",
            severity=severity,
            cost_at_action=used,
            threshold_pct=t,
            action_taken=f"alert_at_{t}pct",
            budget_id=str(budget.get("id") or ""),
        )
        if ok:
            fired.append(t)
            try:
                await _notify_budget_alert(org_id, t, used, hard)
            except Exception as exc:
                logger.debug("budget_service: notify failed: %s", exc)
    return fired


async def _notify_budget_alert(
    org_id: str, threshold_pct: int, used: float, hard: float
) -> None:
    """Best-effort in-app notification + sparse email on hard (100%) breach."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is not None:
            await client.execute(
                """
                INSERT INTO notifications (
                    id, org_id, kind, title, body, created_at
                ) VALUES (
                    $1, $2, 'budget_alert', $3, $4, NOW()
                )
                ON CONFLICT DO NOTHING
                """,
                __import__("uuid").uuid4(),
                org_id,
                f"Budget {threshold_pct}% reached",
                (
                    f"Org spend ${used:.4f} is {threshold_pct}% of "
                    f"hard limit ${hard:.4f}."
                ),
            )
    except Exception as exc:
        logger.debug("budget_service: in-app notify skipped: %s", exc)

    # Sparse email: only hard-limit (100%). Soft 80% stays in-app only.
    if int(threshold_pct) >= 100:
        try:
            from eden.services.alert_email import send_budget_hard_limit_email

            await send_budget_hard_limit_email(org_id=org_id, used=used, hard=hard)
        except Exception as exc:  # noqa: BLE001
            logger.debug("budget_service: alert email skipped: %s", exc)


async def upsert_budget(
    org_id: str,
    *,
    cost_soft_limit_usd: float,
    cost_hard_limit_usd: float,
    enforcement_enabled: bool,
    window: str = "monthly",
    action_on_exceed: str = "throttle",
    threshold_alert_pct: int = 80,
    alert_thresholds: list[int] | None = None,
) -> dict[str, Any]:
    """Admin endpoint: upsert the per-org budget config.

    Org-owner gated. Returns the persisted row. Creates
    a new row if no budget exists for the org.
    """
    client = await _get_client()
    budget_id = _new_budget_id()
    thresholds = _normalize_thresholds(
        alert_thresholds if alert_thresholds is not None else DEFAULT_ALERT_THRESHOLDS
    )
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
            "alert_thresholds": thresholds,
            "source": "dry_run",
        }
    try:
        import json

        await client.execute(
            """
            INSERT INTO budgets (
                id, org_id, window, cost_soft_limit_usd,
                cost_hard_limit_usd, enforcement_enabled,
                action_on_exceed, threshold_alert_pct,
                alert_thresholds,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW()
            )
            ON CONFLICT (org_id, window) WHERE enforcement_enabled = TRUE
            DO UPDATE SET
                cost_soft_limit_usd = EXCLUDED.cost_soft_limit_usd,
                cost_hard_limit_usd = EXCLUDED.cost_hard_limit_usd,
                enforcement_enabled = EXCLUDED.enforcement_enabled,
                action_on_exceed = EXCLUDED.action_on_exceed,
                threshold_alert_pct = EXCLUDED.threshold_alert_pct,
                alert_thresholds = EXCLUDED.alert_thresholds,
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
            json.dumps(thresholds),
        )
    except Exception as exc:
        logger.debug("budget_service: upsert_budget failed: %s", exc)
        # Pre-migration 107: retry without alert_thresholds
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
        except Exception as exc2:
            logger.debug("budget_service: upsert_budget fallback failed: %s", exc2)
    return await get_budget(org_id)


__all__ = [
    "DEFAULT_ALERT_THRESHOLDS",
    "FREE_TIER_DEFAULTS",
    "evaluate_budget_alerts",
    "get_budget",
    "get_consumption",
    "list_actions",
    "record_action",
    "record_usage",
    "upsert_budget",
]
