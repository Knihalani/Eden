"""Customer feature kill-switches — fail-closed for unknown actions (W7/W24)."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Defaults: customer LLM features ON unless explicitly killed.
_DEFAULT_ENABLED: dict[str, bool] = {
    "chat_sidebar": True,
    "triage": True,
    "evolution": True,
    "online_slm": True,
    "online_llm": True,
    "judges": True,
    "gateway": True,
    "patches": True,
    "embeddings": True,
    "nudge_author": True,
    "playground": True,
    # W24 — autonomy action classes (customer-visible FinOps kills).
    "rollback": True,
    "reweight": True,
    "cache_bust": True,
    "self_heal": True,
    "heal": True,
    "autonomy": True,
}

# Autonomy runtime heals — lookup errors fail-closed (deny execute).
_AUTONOMY_ACTION_DEFAULTS: dict[str, bool] = {
    "rollback": True,
    "reweight": True,
    "cache_bust": True,
    "self_heal": True,
    "heal": True,
    "propose_patch": True,
    "code_change": True,
    "patch": True,
}


async def is_feature_enabled(org_id: str, feature_key: str) -> bool:
    """Return whether a customer feature may spend LLM $.

    Unknown feature keys are **fail-closed** (disabled).
    """
    key = (feature_key or "").strip().lower()
    if key not in _DEFAULT_ENABLED:
        return False
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return _DEFAULT_ENABLED[key]
        row = await client.fetchrow(
            """
            SELECT enabled FROM feature_kill_switches
            WHERE org_id = $1 AND feature_key = $2
            """,
            org_id,
            key,
        )
        if row is None:
            return _DEFAULT_ENABLED[key]
        return bool(row["enabled"])
    except Exception as exc:
        logger.debug("feature_kills: is_enabled failed: %s", exc)
        return _DEFAULT_ENABLED.get(key, False)


async def is_autonomy_action_enabled(org_id: str, action_class: str) -> bool:
    """N22/W24 — per-action kill switch for autonomous heals/patches.

    Unknown action classes and DB/lookup failures are **fail-closed**
    (return False) so a broken kill-switch store cannot widen the envelope.
    """
    key = (action_class or "").strip().lower()
    if key not in _AUTONOMY_ACTION_DEFAULTS:
        return False
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return _AUTONOMY_ACTION_DEFAULTS[key]
        row = await client.fetchrow(
            """
            SELECT enabled FROM feature_kill_switches
            WHERE org_id = $1 AND feature_key = $2
            """,
            org_id,
            key,
        )
        if row is None:
            # Also honor umbrella ``autonomy`` / ``self_heal`` kills.
            for umbrella in ("autonomy", "self_heal"):
                if umbrella == key:
                    continue
                urow = await client.fetchrow(
                    """
                    SELECT enabled FROM feature_kill_switches
                    WHERE org_id = $1 AND feature_key = $2
                    """,
                    org_id,
                    umbrella,
                )
                if urow is not None and not bool(urow["enabled"]):
                    return False
            return _AUTONOMY_ACTION_DEFAULTS[key]
        return bool(row["enabled"])
    except Exception as exc:
        logger.debug("feature_kills: autonomy action check failed: %s", exc)
        return False


async def list_feature_kills(org_id: str) -> list[dict[str, Any]]:
    matrix: list[dict[str, Any]] = []
    overrides: dict[str, bool] = {}
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is not None:
            rows = await client.fetch(
                """
                SELECT feature_key, enabled, updated_at, updated_by
                FROM feature_kill_switches
                WHERE org_id = $1
                """,
                org_id,
            )
            for r in rows:
                overrides[str(r["feature_key"])] = bool(r["enabled"])
    except Exception as exc:
        logger.debug("feature_kills: list failed: %s", exc)

    for key, default in _DEFAULT_ENABLED.items():
        enabled = overrides.get(key, default)
        matrix.append(
            {
                "feature_key": key,
                "enabled": enabled,
                "source": "db" if key in overrides else "default",
            }
        )
    return matrix


async def set_feature_kill(
    org_id: str,
    feature_key: str,
    *,
    enabled: bool,
    updated_by: str = "",
) -> None:
    key = feature_key.strip().lower()
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO feature_kill_switches
                (org_id, feature_key, enabled, updated_at, updated_by)
            VALUES ($1, $2, $3, NOW(), $4)
            ON CONFLICT (org_id, feature_key) DO UPDATE SET
                enabled = EXCLUDED.enabled,
                updated_at = NOW(),
                updated_by = EXCLUDED.updated_by
            """,
            org_id,
            key,
            enabled,
            updated_by or None,
        )
    except Exception as exc:
        logger.debug("feature_kills: set failed: %s", exc)
