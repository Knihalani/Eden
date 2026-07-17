"""Feature gates for Artifacts + Ledger (GA defaults) and related previews."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

# GA surfaces: missing org feature key means enabled (settings default True).
_GA_DEFAULT_ON = frozenset({"artifacts_v1", "ledger_v1"})


async def _load_org_features(org_id: str) -> dict[str, Any]:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return {}
        row = await client.fetchrow(
            "SELECT features FROM organizations WHERE id = $1",
            org_id,
        )
        if not row:
            return {}
        features = row.get("features")
        return dict(features) if isinstance(features, dict) else {}
    except Exception as exc:
        logger.debug("preview gates: load org features failed: %s", exc)
        return {}


def _org_flag(features: dict[str, Any], key: str) -> bool:
    """Resolve an org feature flag.

    GA keys (``artifacts_v1``, ``ledger_v1``): missing → enabled.
    All other preview keys: missing → disabled (opt-in).
    Explicit ``False`` always wins (per-org kill switch).
    """
    if key not in features:
        return key in _GA_DEFAULT_ON
    return bool(features[key])


async def artifacts_enabled(org_id: str) -> bool:
    """Artifacts surface — GA. Explicit org False kills; else settings default."""
    from eden.config import get_settings

    features = await _load_org_features(org_id)
    if "artifacts_v1" in features:
        return bool(features["artifacts_v1"])
    return bool(get_settings().artifacts_v1)


async def ledger_enabled(org_id: str) -> bool:
    """Ledger surface — GA. Explicit org False kills; else settings default."""
    from eden.config import get_settings

    features = await _load_org_features(org_id)
    if "ledger_v1" in features:
        return bool(features["ledger_v1"])
    return bool(get_settings().ledger_v1)


async def artifacts_inrun_enabled(org_id: str) -> bool:
    from eden.config import get_settings

    settings = get_settings()
    if settings.artifacts_inrun_v1:
        return True
    features = await _load_org_features(org_id)
    return _org_flag(features, "artifacts_inrun_v1")


async def improvement_loop_preview_enabled(org_id: str) -> bool:
    from eden.config import get_settings

    settings = get_settings()
    if settings.improvement_loop_preview:
        return True
    features = await _load_org_features(org_id)
    return _org_flag(features, "improvement_loop_preview")


async def improvement_agent_enabled(org_id: str) -> bool:
    """N23 — per-org improvement agent (new-org default via features)."""
    from eden.config import get_settings

    settings = get_settings()
    if getattr(settings, "improvement_agent_v1", False):
        return True
    features = await _load_org_features(org_id)
    return _org_flag(features, "improvement_agent_v1")


async def improvement_schedule_enabled_for_org(org_id: str) -> bool:
    """Weekly sweep cron — global flag or per-org features row."""
    from eden.config import get_settings

    settings = get_settings()
    if getattr(settings, "improvement_schedule_enabled", False):
        return True
    features = await _load_org_features(org_id)
    return _org_flag(features, "improvement_schedule_enabled")


async def evolution_loop_enabled_for_org(org_id: str) -> bool:
    """N18 — prompt evolution loop enabled for org (new-org default)."""
    from eden.config import get_settings

    settings = get_settings()
    if getattr(settings, "evolution_loop_enabled", False):
        return True
    features = await _load_org_features(org_id)
    return _org_flag(features, "evolution_loop_enabled")


async def org_evolver_canary_pct(org_id: str) -> int:
    """Per-org canary traffic %; falls back to Settings.evolver_auto_canary_pct."""
    from eden.config import get_settings

    features = await _load_org_features(org_id)
    raw = features.get("evolver_auto_canary_pct")
    if raw is not None:
        try:
            return max(0, min(100, int(raw)))
        except (TypeError, ValueError):
            pass
    return int(getattr(get_settings(), "evolver_auto_canary_pct", 5))


def preview_disabled_envelope(feature: str) -> dict[str, Any]:
    return {
        "status": "preview_disabled",
        "feature": feature,
        "live": False,
        "timestamp": datetime.now(UTC).isoformat(),
        "data": {
            "message": (
                f"{feature} is disabled for this organization. "
                "Contact your admin if this is unexpected."
            ),
        },
    }


_ORG_FLAG_CACHE: dict[tuple[str, str], bool] = {}


def artifacts_enabled_sync(org_id: str) -> bool:
    """Sync hot-path gate — warmed org cache or GA settings default."""
    from eden.config import get_settings

    key = (org_id, "artifacts_v1")
    if key in _ORG_FLAG_CACHE:
        return _ORG_FLAG_CACHE[key]
    return bool(get_settings().artifacts_v1)


def ledger_enabled_sync(org_id: str) -> bool:
    from eden.config import get_settings

    key = (org_id, "ledger_v1")
    if key in _ORG_FLAG_CACHE:
        return _ORG_FLAG_CACHE[key]
    return bool(get_settings().ledger_v1)


async def warm_org_flags(org_id: str) -> None:
    """Populate sync cache for gateway hot path."""
    features = await _load_org_features(org_id)
    _ORG_FLAG_CACHE[(org_id, "artifacts_v1")] = _org_flag(features, "artifacts_v1")
    _ORG_FLAG_CACHE[(org_id, "ledger_v1")] = _org_flag(features, "ledger_v1")
    _ORG_FLAG_CACHE[(org_id, "artifacts_inrun_v1")] = _org_flag(
        features, "artifacts_inrun_v1"
    )
