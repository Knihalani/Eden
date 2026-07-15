"""Per-org detection settings (F20).

Persists the org's ``detection_profile`` (``minimal`` / ``standard`` /
``advanced``) plus an optional SLM flag in ``organizations.settings->
'detection'``. The ``trace.finalized`` consumer resolves the profile
per trace through :func:`resolve_profile`, which is TTL-cached so the
hot path takes at most one DB read per org per ``_CACHE_TTL_S``.

Default posture: new orgs run ``standard``; a missing detection block
resolves to ``standard`` so dogfood keeps its current behaviour, while
an operator can PATCH an org down to ``minimal`` (or up to ``advanced``).
"""

from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

VALID_PROFILES = ("minimal", "standard", "advanced")
_DEFAULT_PROFILE = "standard"
_CACHE_TTL_S = 30.0

# org_id -> (expires_at, settings dict)
_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _defaults() -> dict[str, Any]:
    return {"detection_profile": _DEFAULT_PROFILE, "slm_enabled": False}


async def _client() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("detection_settings: pg client failed: %s", exc)
        return None


async def get_detection_settings(org_id: str) -> dict[str, Any]:
    """Return the resolved detection settings for an org (cached)."""
    now = time.monotonic()
    cached = _cache.get(org_id)
    if cached and cached[0] > now:
        return dict(cached[1])

    resolved = _defaults()
    client = await _client()
    if client is not None:
        try:
            row = await client.fetchrow(
                "SELECT settings FROM organizations WHERE id = $1", org_id
            )
            settings = _coerce_json((row or {}).get("settings")) if row else {}
            block = settings.get("detection") if isinstance(settings, dict) else None
            if isinstance(block, dict):
                profile = str(block.get("detection_profile") or "").lower()
                if profile in VALID_PROFILES:
                    resolved["detection_profile"] = profile
                resolved["slm_enabled"] = bool(block.get("slm_enabled", False))
        except Exception as exc:
            logger.debug("detection_settings: read failed org=%s: %s", org_id, exc)

    _cache[org_id] = (now + _CACHE_TTL_S, dict(resolved))
    return dict(resolved)


async def set_detection_settings(
    org_id: str,
    *,
    detection_profile: str | None = None,
    slm_enabled: bool | None = None,
) -> dict[str, Any]:
    """Persist a partial detection-settings update; returns the new state."""
    current = await get_detection_settings(org_id)
    if detection_profile is not None:
        profile = str(detection_profile).lower()
        if profile not in VALID_PROFILES:
            raise ValueError(
                f"invalid detection_profile {detection_profile!r}; "
                f"expected one of {VALID_PROFILES}"
            )
        current["detection_profile"] = profile
    if slm_enabled is not None:
        current["slm_enabled"] = bool(slm_enabled)

    client = await _client()
    if client is not None:
        try:
            row = await client.fetchrow(
                "SELECT settings FROM organizations WHERE id = $1", org_id
            )
            settings = _coerce_json((row or {}).get("settings")) if row else {}
            if not isinstance(settings, dict):
                settings = {}
            settings["detection"] = current
            import json

            await client.execute(
                "UPDATE organizations SET settings = $1::jsonb WHERE id = $2",
                json.dumps(settings, default=str),
                org_id,
            )
        except Exception as exc:
            logger.warning("detection_settings: write failed org=%s: %s", org_id, exc)

    _cache[org_id] = (time.monotonic() + _CACHE_TTL_S, dict(current))
    return dict(current)


async def resolve_profile(org_id: str) -> str:
    """Return the org's detection profile (``standard`` default)."""
    return (await get_detection_settings(org_id)).get(
        "detection_profile", _DEFAULT_PROFILE
    )


def _coerce_json(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    try:
        import json

        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def _clear_cache() -> None:  # test helper
    _cache.clear()
