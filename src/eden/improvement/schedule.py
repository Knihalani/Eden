"""Per-org cron due-check for N23 improvement sweeps."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.improvement import runs_repo
from eden.improvement import settings as imp_settings
from eden.improvement.agent import ImprovementAgent
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


def _parse_cron_field(field: str, value: int, *, sunday_zero: bool = False) -> bool:
    """Match a single cron field against a value."""
    field = field.strip()
    if field == "*":
        return True
    if field.startswith("*/"):
        try:
            step = int(field[2:])
            return value % step == 0
        except ValueError:
            return False
    for part in field.split(","):
        part = part.strip()
        if "-" in part:
            lo_s, hi_s = part.split("-", 1)
            try:
                lo, hi = int(lo_s), int(hi_s)
                if sunday_zero and lo == 7:
                    lo = 0
                if lo <= value <= hi:
                    return True
            except ValueError:
                continue
        else:
            try:
                n = int(part)
                if sunday_zero and n == 7:
                    n = 0
                if n == value:
                    return True
            except ValueError:
                continue
    return False


def cron_matches(
    expr: str,
    when: datetime,
    *,
    minute_window: int = 10,
) -> bool:
    """Return True when ``when`` falls in the cron firing window."""
    parts = expr.split()
    if len(parts) != 5:
        return False
    minute_f, hour_f, dom_f, month_f, dow_f = parts
    if when.minute >= minute_window:
        return False
    # Python weekday: Mon=0; cron DOW: Sun=0 or 7
    cron_dow = (when.weekday() + 1) % 7
    return (
        _parse_cron_field(minute_f, when.minute)
        and _parse_cron_field(hour_f, when.hour)
        and _parse_cron_field(dom_f, when.day)
        and _parse_cron_field(month_f, when.month)
        and _parse_cron_field(dow_f, cron_dow, sunday_zero=True)
    )


def next_run_at(expr: str, *, after: datetime | None = None) -> datetime | None:
    """Forward-search the next cron match (5-minute steps, 366 days max)."""
    after = after or datetime.now(UTC)
    if after.tzinfo is None:
        after = after.replace(tzinfo=UTC)
    probe = after.replace(second=0, microsecond=0)
    for _ in range(366 * 24 * 12):
        if cron_matches(expr, probe, minute_window=60):
            if probe > after:
                return probe
        probe += timedelta(minutes=5)
    return None


async def is_due(
    org_id: str,
    *,
    now: datetime | None = None,
    minute_window: int = 10,
) -> bool:
    cfg = await imp_settings.get_settings(org_id)
    expr = cfg.get("improvement_schedule_cron") or imp_settings.DEFAULT_SCHEDULE_CRON
    now = now or datetime.now(UTC)
    if not cron_matches(expr, now, minute_window=minute_window):
        return False
    watermark = await runs_repo.get_watermark(org_id)
    # Suppress duplicate fire in same hour
    if watermark and (now - watermark).total_seconds() < 3600:
        return False
    return True


async def resolved_schedule(org_id: str) -> dict[str, Any]:
    cfg = await imp_settings.get_settings(org_id)
    expr = cfg["improvement_schedule_cron"]
    watermark = await runs_repo.get_watermark(org_id)
    nxt = next_run_at(expr)
    return {
        **cfg,
        "last_run_at": watermark.isoformat() if watermark else None,
        "next_run_at": nxt.isoformat() if nxt else None,
    }


async def _list_orgs() -> list[str]:
    client = await get_postgres_client()
    if client is None:
        return []
    try:
        rows = await client.fetch("SELECT id FROM organizations LIMIT 500")
        return [str(r["id"]) for r in rows]
    except Exception as exc:
        logger.debug("improvement.schedule: list orgs failed: %s", exc)
        return []


async def run_due_sweeps(*, dry_run: bool = False) -> dict[str, Any]:
    """Cron entry: sweep every org whose schedule is due."""
    now = datetime.now(UTC)
    out: dict[str, Any] = {"tick_at": now.isoformat(), "orgs": []}
    if dry_run:
        out["dry_run"] = True
        return out

    agent = ImprovementAgent()
    for org_id in await _list_orgs():
        try:
            from eden.preview.gates import (
                improvement_agent_enabled,
                improvement_schedule_enabled_for_org,
            )

            if not await improvement_schedule_enabled_for_org(org_id):
                continue
            if not await improvement_agent_enabled(org_id):
                continue
            if not await is_due(org_id, now=now):
                continue
            result = await agent.sweep(org_id)
            out["orgs"].append({"org_id": org_id, **result})
        except Exception as exc:
            logger.warning("improvement.schedule: sweep failed org=%s: %s", org_id, exc)
            out["orgs"].append({"org_id": org_id, "error": str(exc)})
    return out
