"""Persistence for Slack installs + per-agent channel bindings.

Tables (migration 131):

* ``org_slack_installs`` — one row per (org, Slack workspace). Bot token
  is Fernet-encrypted at rest via :mod:`eden.api.utils.encryption`,
  same as export-destination credentials.
* ``agent_slack_channels`` — one row per (org, agent). ``agent_id`` NULL
  is the org-wide default channel, mirroring how ``autonomy_policies``
  uses a NULL agent row for the org default.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from eden.api.utils.encryption import decrypt_value, encrypt_value

logger = logging.getLogger(__name__)


async def _pg() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception:
        return None


# ── org_slack_installs ──────────────────────────────────────────────


async def upsert_install(
    org_id: str,
    *,
    team_id: str,
    team_name: str,
    bot_token: str,
    bot_user_id: str = "",
    installed_by_user_id: str | None = None,
) -> dict[str, Any] | None:
    """Persist a Slack workspace install. Token is encrypted at rest."""
    client = await _pg()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            INSERT INTO org_slack_installs
                (id, org_id, team_id, team_name, bot_token_enc,
                 bot_user_id, installed_by_user_id)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (org_id, team_id) DO UPDATE SET
                team_name = EXCLUDED.team_name,
                bot_token_enc = EXCLUDED.bot_token_enc,
                bot_user_id = EXCLUDED.bot_user_id,
                revoked_at = NULL,
                updated_at = NOW()
            RETURNING id, org_id, team_id, team_name, bot_user_id,
                      installed_at, revoked_at
            """,
            str(uuid.uuid4()),
            org_id,
            team_id,
            team_name,
            encrypt_value(bot_token),
            bot_user_id,
            installed_by_user_id,
        )
        return dict(row) if row else None
    except Exception as exc:
        logger.warning("slack_store: upsert_install failed: %s", exc)
        return None


async def get_install(org_id: str) -> dict[str, Any] | None:
    """Return the org's active install (without the token), else None."""
    client = await _pg()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT id, org_id, team_id, team_name, bot_user_id,
                   installed_at, revoked_at
            FROM org_slack_installs
            WHERE org_id = $1 AND revoked_at IS NULL
            ORDER BY installed_at DESC
            LIMIT 1
            """,
            org_id,
        )
        return dict(row) if row else None
    except Exception as exc:
        logger.debug("slack_store: get_install failed: %s", exc)
        return None


async def get_bot_token(org_id: str) -> str | None:
    """Decrypt + return the org's bot token. Falls back to the
    single-workspace ``SLACK_BOT_TOKEN`` env var when no install row
    exists (dev / single-tenant path)."""
    client = await _pg()
    if client is not None:
        try:
            enc = await client.fetchval(
                """
                SELECT bot_token_enc FROM org_slack_installs
                WHERE org_id = $1 AND revoked_at IS NULL
                ORDER BY installed_at DESC
                LIMIT 1
                """,
                org_id,
            )
            if enc:
                token = decrypt_value(str(enc))
                if token:
                    return token
        except Exception as exc:
            logger.debug("slack_store: token decrypt failed: %s", exc)
    # Dev / single-tenant fallback.
    try:
        from eden.config import get_settings

        fallback = (getattr(get_settings(), "slack_bot_token", "") or "").strip()
        if fallback.startswith("xoxb-"):
            return fallback
    except Exception:
        pass
    return None


async def revoke_install(org_id: str, *, team_id: str | None = None) -> bool:
    """Soft-revoke an install (sets revoked_at). Keeps the row for audit."""
    client = await _pg()
    if client is None:
        return False
    try:
        if team_id:
            await client.execute(
                "UPDATE org_slack_installs SET revoked_at = NOW(), updated_at = NOW() "
                "WHERE org_id = $1 AND team_id = $2",
                org_id,
                team_id,
            )
        else:
            await client.execute(
                "UPDATE org_slack_installs SET revoked_at = NOW(), updated_at = NOW() "
                "WHERE org_id = $1 AND revoked_at IS NULL",
                org_id,
            )
        return True
    except Exception as exc:
        logger.debug("slack_store: revoke failed: %s", exc)
        return False


# ── agent_slack_channels ────────────────────────────────────────────


async def set_channel(
    org_id: str,
    *,
    agent_id: str | None,
    channel_id: str,
    channel_name: str = "",
    set_by_user_id: str | None = None,
) -> bool:
    """Bind an agent (or the org default, agent_id=None) to a channel."""
    client = await _pg()
    if client is None:
        return False
    try:
        await client.execute(
            """
            INSERT INTO agent_slack_channels
                (id, org_id, agent_id, channel_id, channel_name, set_by_user_id)
            VALUES ($1::uuid, $2, $3, $4, $5, $6)
            ON CONFLICT (org_id, (COALESCE(agent_id, ''))) DO UPDATE SET
                channel_id = EXCLUDED.channel_id,
                channel_name = EXCLUDED.channel_name,
                set_by_user_id = EXCLUDED.set_by_user_id,
                updated_at = NOW()
            """,
            str(uuid.uuid4()),
            org_id,
            agent_id,
            channel_id,
            channel_name,
            set_by_user_id,
        )
        return True
    except Exception as exc:
        logger.warning("slack_store: set_channel failed: %s", exc)
        return False


async def get_channel(org_id: str, *, agent_id: str | None = None) -> dict[str, Any] | None:
    """Resolve the channel for an agent: agent row beats the org default
    (agent_id IS NULL). Returns ``{channel_id, channel_name}`` or None."""
    client = await _pg()
    if client is None:
        return None
    try:
        if agent_id:
            row = await client.fetchrow(
                """
                SELECT channel_id, channel_name FROM agent_slack_channels
                WHERE org_id = $1 AND agent_id = $2
                """,
                org_id,
                agent_id,
            )
            if row:
                return dict(row)
        row = await client.fetchrow(
            """
            SELECT channel_id, channel_name FROM agent_slack_channels
            WHERE org_id = $1 AND agent_id IS NULL
            """,
            org_id,
        )
        return dict(row) if row else None
    except Exception as exc:
        logger.debug("slack_store: get_channel failed: %s", exc)
        return None


async def list_channels(org_id: str) -> list[dict[str, Any]]:
    """All channel bindings for the org (agent + default rows)."""
    client = await _pg()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT agent_id, channel_id, channel_name, updated_at
            FROM agent_slack_channels
            WHERE org_id = $1
            ORDER BY updated_at DESC
            """,
            org_id,
        )
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.debug("slack_store: list_channels failed: %s", exc)
        return []


async def clear_channel(org_id: str, *, agent_id: str | None = None) -> bool:
    """Remove a binding. agent_id=None clears the org default."""
    client = await _pg()
    if client is None:
        return False
    try:
        if agent_id:
            await client.execute(
                "DELETE FROM agent_slack_channels WHERE org_id = $1 AND agent_id = $2",
                org_id,
                agent_id,
            )
        else:
            await client.execute(
                "DELETE FROM agent_slack_channels WHERE org_id = $1 AND agent_id IS NULL",
                org_id,
            )
        return True
    except Exception as exc:
        logger.debug("slack_store: clear_channel failed: %s", exc)
        return False


__all__ = [
    "clear_channel",
    "get_bot_token",
    "get_channel",
    "get_install",
    "list_channels",
    "revoke_install",
    "set_channel",
    "upsert_install",
]
