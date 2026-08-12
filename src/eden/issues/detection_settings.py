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


# ── Wave 3 (3.2): per-agent threshold multiplier ──────────────────
#
# The org-level detection profile picks *which* detectors run. This
# picks *how sensitive* they are for one agent, driven by that agent's
# own confirm/dismiss history — so an agent whose issues operators keep
# dismissing (false positives) gets *less* sensitive detection, and an
# agent whose issues keep getting resolved (real problems) gets *more*.
# The same `rule.operator_confirms/dismisses` counters that
# ``evaluate_shadow_precision`` (soft_issue_review) consumes feed the
# multiplier, so shadow-detector feedback lands here too (3.3).

#: Min labelled decisions before the multiplier stops being neutral.
_AGENT_MIN_LABELS = 5
#: High dismiss-share → fewer detections (raise thresholds).
_AGENT_DISMISS_SHARE_HIGH = 0.6
#: High confirm-share → more detections (lower thresholds).
_AGENT_CONFIRM_SHARE_HIGH = 0.7
#: Clamp so one noisy agent can never fully silence (or flood) itself.
_AGENT_MULT_LOW = 0.7
_AGENT_MULT_HIGH = 1.5
#: Same TTL bucket as the org settings cache (one read per org per TTL).
_AGENT_CACHE_TTL_S = 30.0

# org_id -> {agent_id: (expires_at, multiplier)}
_agent_cache: dict[str, dict[str, tuple[float, float]]] = {}


async def resolve_agent_threshold_multiplier(
    org_id: str, agent_id: str | None
) -> float:
    """Return a per-agent detection sensitivity multiplier (default 1.0).

    <1.0 → more sensitive (confirm-heavy agent); >1.0 → less sensitive
    (dismiss-heavy agent). ``None`` agent (or no labels yet) → 1.0.
    """
    if not agent_id:
        return 1.0
    now = time.monotonic()
    per_agent = _agent_cache.setdefault(org_id, {})
    cached = per_agent.get(agent_id)
    if cached and cached[0] > now:
        return cached[1]

    multiplier = 1.0
    client = await _client()
    if client is not None:
        try:
            multiplier = await _compute_agent_multiplier(client, org_id, agent_id)
        except Exception as exc:
            logger.debug(
                "detection_settings: agent multiplier failed org=%s agent=%s: %s",
                org_id,
                agent_id,
                exc,
            )
    per_agent[agent_id] = (now + _AGENT_CACHE_TTL_S, multiplier)
    return multiplier


async def _compute_agent_multiplier(
    client: Any, org_id: str, agent_id: str
) -> float:
    """Confirm/dismiss rates from agent_issues + shadow-detector feedback."""
    row = await client.fetchrow(
        """
        SELECT
            COUNT(*) FILTER (WHERE status = 'resolved')   AS confirms,
            COUNT(*) FILTER (WHERE status = 'ignored')    AS dismisses
        FROM agent_issues
        WHERE org_id = $1 AND agent_id = $2
          AND last_seen >= now() - interval '30 days'
        """,
        org_id,
        agent_id,
    )
    confirms = int((row or {}).get("confirms") or 0)
    dismisses = int((row or {}).get("dismisses") or 0)

    # Shadow-detector operator feedback for this agent (3.3): the same
    # counters evaluate_shadow_precision reads, scoped to the agent via
    # the 168 agent_id column.
    try:
        shadow = await client.fetchrow(
            """
            SELECT
                COALESCE(SUM((rule->>'operator_confirms')::int), 0)   AS confirms,
                COALESCE(SUM((rule->>'operator_dismisses')::int), 0)  AS dismisses
            FROM nl_signals
            WHERE org_id = $1 AND agent_id = $2
              AND cluster_id LIKE 'auto:%'
            """,
            org_id,
            agent_id,
        )
        confirms += int((shadow or {}).get("confirms") or 0)
        dismisses += int((shadow or {}).get("dismisses") or 0)
    except Exception:
        # Column may not exist on a pre-168 schema — issues alone suffice.
        pass

    labelled = confirms + dismisses
    if labelled < _AGENT_MIN_LABELS:
        return 1.0
    if dismisses / labelled >= _AGENT_DISMISS_SHARE_HIGH:
        return _AGENT_MULT_HIGH
    if confirms / labelled >= _AGENT_CONFIRM_SHARE_HIGH:
        return _AGENT_MULT_LOW
    return 1.0


def invalidate_agent_multiplier(org_id: str, agent_id: str | None) -> None:
    """Drop the cached per-agent threshold multiplier for one agent.

    Public on purpose — shadow-detector feedback (soft_issue_review) and
    the weekly promote sweep call this after a confirm/dismiss or a
    promote/delete decision so the next trace scan for that agent reads
    the new rates instead of the stale cache.
    """
    if not agent_id:
        return
    per_agent = _agent_cache.get(org_id)
    if per_agent:
        per_agent.pop(agent_id, None)


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
    _agent_cache.clear()
