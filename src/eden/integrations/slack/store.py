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

import json
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



async def get_org_id_for_team(team_id: str) -> str | None:
    """Resolve an active install's org_id from Slack team_id."""
    client = await _pg()
    if client is None or not team_id:
        return None
    try:
        row = await client.fetchval(
            """
            SELECT org_id FROM org_slack_installs
            WHERE team_id = $1 AND revoked_at IS NULL
            ORDER BY installed_at DESC
            LIMIT 1
            """,
            team_id,
        )
        return str(row) if row else None
    except Exception as exc:
        logger.debug("slack_store: get_org_id_for_team failed: %s", exc)
        return None


async def get_agent_for_channel(
    org_id: str, channel_id: str
) -> dict[str, Any] | None:
    """Reverse map: invited, mapped channel → agent. Unmapped / org-default
    (``agent_id`` NULL) returns None — Stage 1 never indexes those."""
    client = await _pg()
    if client is None or not channel_id:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT agent_id, channel_id, channel_name
            FROM agent_slack_channels
            WHERE org_id = $1 AND channel_id = $2 AND agent_id IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            org_id,
            channel_id,
        )
        return dict(row) if row else None
    except Exception as exc:
        logger.debug("slack_store: get_agent_for_channel failed: %s", exc)
        return None


async def get_current_help_contract(
    org_id: str, agent_id: str
) -> dict[str, Any] | None:
    """Current (not superseded) help contract for (org, agent)."""
    client = await _pg()
    if client is None or not agent_id:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT id, org_id, agent_id, sentence, x_job, x_keywords,
                   y_person, y_slack_user_id, created_by, created_at,
                   updated_at, superseded_at
            FROM help_contracts
            WHERE org_id = $1 AND agent_id = $2 AND superseded_at IS NULL
            LIMIT 1
            """,
            org_id,
            agent_id,
        )
        return dict(row) if row else None
    except Exception as exc:
        logger.debug("slack_store: get_current_help_contract failed: %s", exc)
        return None


async def event_id_seen(org_id: str, event_id: str) -> bool:
    """True if this Slack event_id was already persisted for the org."""
    client = await _pg()
    if client is None or not event_id:
        return False
    try:
        found = await client.fetchval(
            """
            SELECT 1 FROM extra_work_events
            WHERE org_id = $1 AND event_id = $2
            LIMIT 1
            """,
            org_id,
            event_id,
        )
        return bool(found)
    except Exception as exc:
        logger.debug("slack_store: event_id_seen failed: %s", exc)
        return False


async def insert_extra_work_event(
    org_id: str,
    *,
    agent_id: str,
    event_id: str | None,
    user_id: str | None,
    help_contract_id: str | None,
    surface: str,
    kind: str,
    path: str,
    join_key: dict[str, Any],
    snippet: str | None,
    confidence: str,
    polarity: str,
    raw: dict[str, Any],
    observed_at: str,
    session_id: str | None = None,
    trace_id: str | None = None,
    window: dict[str, Any] | None = None,
    canary_arm: str | None = None,
) -> dict[str, Any] | None:
    """Insert a fired ExtraWorkEvent. Unique (org_id, event_id) is idempotent."""
    client = await _pg()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            INSERT INTO extra_work_events (
                org_id, session_id, agent_id, user_id, help_contract_id,
                trace_id, surface, kind, path, join_key, snippet, window,
                confidence, polarity, raw, event_id, observed_at, canary_arm
            ) VALUES (
                $1, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10::jsonb,
                $11, $12::jsonb, $13, $14, $15::jsonb, $16, $17::timestamptz, $18
            )
            ON CONFLICT (org_id, event_id) WHERE event_id IS NOT NULL
            DO NOTHING
            RETURNING id, org_id, agent_id, event_id, kind, confidence
            """,
            org_id,
            session_id,
            agent_id,
            user_id,
            help_contract_id,
            trace_id,
            surface,
            kind,
            path,
            json.dumps(join_key),
            (snippet or "")[:280] or None,
            json.dumps(window) if window is not None else None,
            confidence,
            polarity,
            json.dumps(raw),
            event_id,
            observed_at,
            canary_arm,
        )
        return dict(row) if row else None
    except Exception as exc:
        logger.warning("slack_store: insert_extra_work_event failed: %s", exc)
        return None


async def insert_candidate(
    org_id: str,
    *,
    channel_id: str,
    payload: dict[str, Any],
    agent_id: str | None = None,
    help_contract_id: str | None = None,
) -> dict[str, Any] | None:
    """Encrypted 7-day candidate. Unused while Stage 4 is off."""
    client = await _pg()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            INSERT INTO extra_work_candidates (
                org_id, agent_id, help_contract_id, channel_id,
                payload_enc, expires_at
            ) VALUES (
                $1, $2, $3::uuid, $4, $5, NOW() + INTERVAL '7 days'
            )
            RETURNING id, org_id, expires_at
            """,
            org_id,
            agent_id,
            help_contract_id,
            channel_id,
            encrypt_value(json.dumps(payload, separators=(",", ":"))),
        )
        return dict(row) if row else None
    except Exception as exc:
        logger.debug("slack_store: insert_candidate failed: %s", exc)
        return None


__all__ = [
    "clear_channel",
    "event_id_seen",
    "get_agent_for_channel",
    "get_bot_token",
    "get_channel",
    "get_current_help_contract",
    "get_install",
    "get_org_id_for_team",
    "insert_candidate",
    "insert_extra_work_event",
    "list_channels",
    "revoke_install",
    "set_channel",
    "upsert_install",
]
