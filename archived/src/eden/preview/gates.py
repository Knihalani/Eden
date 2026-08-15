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
        # Prod has ``organizations.settings`` JSONB; ``features`` was never
        # migrated onto organizations (007 added features on org_plans only).
        row = await client.fetchrow(
            "SELECT settings FROM organizations WHERE id = $1",
            org_id,
        )
        if not row:
            return {}
        features = row.get("settings")
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
    """N23 — per-org improvement agent.

    Explicit org ``False`` is a kill-switch even when the global setting is ON.
    Missing org key falls back to ``Settings.improvement_agent_v1``.
    """
    from eden.config import get_settings

    features = await _load_org_features(org_id)
    if "improvement_agent_v1" in features:
        return bool(features["improvement_agent_v1"])
    return bool(getattr(get_settings(), "improvement_agent_v1", False))


async def replay_verify_enabled_for_org(org_id: str) -> bool:
    """M7 (spec §10.2) — replay-before-PR verify, org-overridable.

    Explicit org ``False`` is a kill-switch even when the global setting
    (default True) is ON. Missing org key falls back to
    ``Settings.replay_verify_enabled``.
    """
    from eden.config import get_settings

    features = await _load_org_features(org_id)
    if "replay_verify_enabled" in features:
        return bool(features["replay_verify_enabled"])
    return bool(getattr(get_settings(), "replay_verify_enabled", True))


async def test_gate_enabled_for_org(org_id: str) -> bool:
    """M8 (spec §4.2) — sandbox test gate, org-overridable.

    Explicit org ``False`` is a kill-switch even when the global setting
    (default True) is ON. Missing org key falls back to
    ``Settings.test_gate_enabled``.
    """
    from eden.config import get_settings

    features = await _load_org_features(org_id)
    if "test_gate_enabled" in features:
        return bool(features["test_gate_enabled"])
    return bool(getattr(get_settings(), "test_gate_enabled", True))


async def test_gate_synthesis_enabled_for_org(org_id: str) -> bool:
    """M8 (spec §4.2) — LLM test synthesis, default OFF, org opt-in.

    Explicit org key wins in both directions; missing key falls back to
    ``Settings.test_gate_synthesis_v1`` (default False — trust +
    injection risk before dogfood measurement, spec §4.2/§7.3).
    """
    from eden.config import get_settings

    features = await _load_org_features(org_id)
    if "test_gate_synthesis_v1" in features:
        return bool(features["test_gate_synthesis_v1"])
    return bool(getattr(get_settings(), "test_gate_synthesis_v1", False))


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


# M14 (§8.3): valid sampling_profile_override values. Unknown → ignore
# (keep global default). Never silently invent a droppier profile.
_SAMPLING_PROFILES = frozenset({"full", "balanced", "aggressive"})
_ORG_SAMPLING_CACHE: dict[str, str | None] = {}


async def sampling_profile_for_org(org_id: str) -> str:
    """M14 (§8.3): resolve sampling profile with per-org opt-in override.

    Global ``Settings.sampling_profile`` stays ``full``. An org may set
    ``organizations.settings.sampling_profile_override`` to ``balanced``
    (or ``aggressive``) for non-error traffic. Fleet-wide promotion from
    ``full`` → ``balanced`` waits on M13 §6.5 shadow-detector
    precision/recall measurement — never flip the global default first.
    """
    from eden.config import get_settings

    features = await _load_org_features(org_id)
    raw = features.get("sampling_profile_override")
    if isinstance(raw, str):
        profile = raw.strip().lower()
        if profile in _SAMPLING_PROFILES:
            _ORG_SAMPLING_CACHE[org_id] = profile
            return profile
    global_profile = getattr(get_settings(), "sampling_profile", "full") or "full"
    if global_profile not in _SAMPLING_PROFILES:
        global_profile = "full"
    _ORG_SAMPLING_CACHE[org_id] = None  # no override — use process default
    return global_profile


def sampling_profile_override_sync(org_id: str) -> str | None:
    """Hot-path: return warmed org override, or None → process default.

    Populated by :func:`sampling_profile_for_org` / :func:`warm_org_flags`.
    Missing cache entry means "no override known yet" (fail-open to
    process-wide policy).
    """
    if not org_id:
        return None
    return _ORG_SAMPLING_CACHE.get(org_id)


async def ensure_org_sampling_warmed(org_id: str) -> None:
    """M14 (§8.3): warm sampling override cache on first ingest for org.

    Mirrors other org-flag warming (``warm_org_flags``): one DB read per
    org, then sync hot path. No-op when already cached (including explicit
    ``None`` = no override → keep global ``full``).
    """
    if not org_id or org_id in _ORG_SAMPLING_CACHE:
        return
    await sampling_profile_for_org(org_id)


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
    # M14 (§8.3): warm sampling override for ingest hot path.
    raw = features.get("sampling_profile_override")
    if isinstance(raw, str) and raw.strip().lower() in _SAMPLING_PROFILES:
        _ORG_SAMPLING_CACHE[org_id] = raw.strip().lower()
    else:
        _ORG_SAMPLING_CACHE[org_id] = None
