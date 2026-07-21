"""Per-org improvement schedule settings (N23)."""

from __future__ import annotations

import json
import logging
from typing import Any

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

DEFAULT_SCHEDULE_CRON = "0 3 * * 0"
DEFAULT_MAX_PLANS_PER_SWEEP = 10
DEFAULT_MAX_CODE_PATCH_PER_SWEEP = 3
DEFAULT_MAX_ADVISORY_PER_SWEEP = 5
DEFAULT_MAX_GENERATES_PER_SWEEP = 3


async def get_settings(org_id: str) -> dict[str, Any]:
    """Read improvement settings from organizations.features."""
    stored = await _read_features(org_id)
    try:
        from eden.config import get_settings as get_global

        generates = int(
            getattr(get_global(), "patch_max_generates_per_sweep", 3) or 3
        )
    except Exception:
        generates = DEFAULT_MAX_GENERATES_PER_SWEEP
    return {
        "improvement_schedule_cron": stored.get(
            "improvement_schedule_cron", DEFAULT_SCHEDULE_CRON
        ),
        "improvement_max_plans_per_sweep": int(
            stored.get(
                "improvement_max_plans_per_sweep", DEFAULT_MAX_PLANS_PER_SWEEP
            )
        ),
        "improvement_max_code_patch_per_sweep": int(
            stored.get(
                "improvement_max_code_patch_per_sweep",
                DEFAULT_MAX_CODE_PATCH_PER_SWEEP,
            )
        ),
        "improvement_max_advisory_per_sweep": int(
            stored.get(
                "improvement_max_advisory_per_sweep",
                DEFAULT_MAX_ADVISORY_PER_SWEEP,
            )
        ),
        "improvement_max_generates_per_sweep": int(
            stored.get("improvement_max_generates_per_sweep", generates)
        ),
    }


async def update_settings(
    org_id: str,
    *,
    improvement_schedule_cron: str | None = None,
    improvement_max_plans_per_sweep: int | None = None,
) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    if improvement_schedule_cron is not None:
        patch["improvement_schedule_cron"] = improvement_schedule_cron
    if improvement_max_plans_per_sweep is not None:
        patch["improvement_max_plans_per_sweep"] = max(
            1, min(25, int(improvement_max_plans_per_sweep))
        )
    if patch:
        await _merge_features(org_id, patch)
    return await get_settings(org_id)


async def _read_features(org_id: str) -> dict[str, Any]:
    try:
        client = await get_postgres_client()
        if client is None:
            return {}
        row = await client.fetchrow(
            "SELECT features FROM organizations WHERE id = $1",
            org_id,
        )
        if row is None:
            return {}
        raw = row.get("features")
        if isinstance(raw, str):
            return json.loads(raw)
        if isinstance(raw, dict):
            return raw
        return {}
    except Exception as exc:
        logger.debug("improvement.settings read failed: %s", exc)
        return {}


async def _merge_features(org_id: str, patch: dict[str, Any]) -> bool:
    try:
        client = await get_postgres_client()
        if client is None:
            return False
        result = await client.execute(
            "UPDATE organizations SET features = "
            "COALESCE(features, '{}'::jsonb) || $1::jsonb "
            "WHERE id = $2",
            json.dumps(patch),
            org_id,
        )
        return result.endswith(" 1")
    except Exception as exc:
        logger.debug("improvement.settings write failed: %s", exc)
        return False
