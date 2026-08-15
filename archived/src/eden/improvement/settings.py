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
    """Read this org's improvement settings, falling back to the defaults."""
    stored = await _read_features(org_id)
    try:
        from eden.config import get_settings as get_global

        generates = int(getattr(get_global(), "patch_max_generates_per_sweep", 3) or 3)
    except Exception:
        generates = DEFAULT_MAX_GENERATES_PER_SWEEP
    return {
        "improvement_schedule_cron": stored.get("improvement_schedule_cron", DEFAULT_SCHEDULE_CRON),
        "improvement_max_plans_per_sweep": int(
            stored.get("improvement_max_plans_per_sweep", DEFAULT_MAX_PLANS_PER_SWEEP)
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


#: The JSONB column on ``organizations`` that holds per-org settings.
#:
#: This module read and wrote ``features``. ``organizations`` has no such
#: column — the JSONB blob is ``settings``. Both statements therefore raised
#: ``UndefinedColumn`` on every call, and both were wrapped in
#: ``except Exception: logger.debug(...)``: reads silently returned ``{}`` so
#: every org got the module defaults, and writes silently returned ``False``.
#: Per-org improvement scheduling has never taken effect.
_SETTINGS_COLUMN = "settings"


async def _read_features(org_id: str) -> dict[str, Any]:
    """Read the org's stored improvement settings.

    Absence — no configured client, no such org — returns ``{}`` so callers
    fall back to the module defaults. A *database* error is raised rather than
    folded into that same empty dict: conflating "this org has no overrides"
    with "the query is malformed" is precisely what hid the wrong column name
    for as long as it did.
    """
    client = await get_postgres_client()
    if client is None:
        return {}
    row = await client.fetchrow(
        f"SELECT {_SETTINGS_COLUMN} FROM organizations WHERE id = $1",
        org_id,
    )
    if row is None:
        return {}
    raw = row.get(_SETTINGS_COLUMN)
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning(
                "improvement.settings: organizations.%s for org %s is not "
                "valid JSON; falling back to defaults",
                _SETTINGS_COLUMN,
                org_id,
            )
            return {}
        return parsed if isinstance(parsed, dict) else {}
    if isinstance(raw, dict):
        return raw
    return {}


async def _merge_features(org_id: str, patch: dict[str, Any]) -> bool:
    """Merge ``patch`` into the org's settings blob.

    Returns False when there is no client or the org does not exist. A
    database error propagates — a settings write that fails silently reports
    success to the caller, which is how a broken column name survives.
    """
    client = await get_postgres_client()
    if client is None:
        return False
    result = await client.execute(
        f"UPDATE organizations SET {_SETTINGS_COLUMN} = "
        f"COALESCE({_SETTINGS_COLUMN}, '{{}}'::jsonb) || $1::jsonb "
        "WHERE id = $2",
        json.dumps(patch),
        org_id,
    )
    return result.endswith(" 1")
