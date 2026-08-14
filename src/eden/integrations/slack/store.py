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
    granted_scopes: str = "",
) -> dict[str, Any] | None:
    """Persist a Slack workspace install. Token is encrypted at rest."""
    from eden.integrations.slack.oauth import HISTORY_SCOPES

    scopes = (granted_scopes or "").strip()
    scope_set = {s.strip() for s in scopes.split(",") if s.strip()}
    history_ok = all(s in scope_set for s in HISTORY_SCOPES)
    client = await _pg()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            INSERT INTO org_slack_installs
                (id, org_id, team_id, team_name, bot_token_enc,
                 bot_user_id, installed_by_user_id, granted_scopes,
                 history_consented_at)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8,
                    CASE WHEN $9 THEN NOW() ELSE NULL END)
            ON CONFLICT (org_id, team_id) DO UPDATE SET
                team_name = EXCLUDED.team_name,
                bot_token_enc = EXCLUDED.bot_token_enc,
                bot_user_id = EXCLUDED.bot_user_id,
                granted_scopes = EXCLUDED.granted_scopes,
                history_consented_at = COALESCE(
                    EXCLUDED.history_consented_at,
                    org_slack_installs.history_consented_at
                ),
                revoked_at = NULL,
                updated_at = NOW()
            RETURNING id, org_id, team_id, team_name, bot_user_id,
                      installed_at, revoked_at, granted_scopes,
                      history_consented_at
            """,
            str(uuid.uuid4()),
            org_id,
            team_id,
            team_name,
            encrypt_value(bot_token),
            bot_user_id,
            installed_by_user_id,
            scopes,
            history_ok,
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
                   installed_at, revoked_at, granted_scopes,
                   history_consented_at
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
        await client.execute(
            "DELETE FROM extra_work_candidates WHERE org_id = $1",
            org_id,
        )
        return True
    except Exception as exc:
        logger.debug("slack_store: revoke failed: %s", exc)
        return False


# ── agent_slack_channels ────────────────────────────────────────────


def is_forbidden_channel_id(channel_id: str) -> bool:
    """DMs (D…) and user ids (U… / W…) are not pickable channels."""
    cid = (channel_id or "").strip()
    if not cid:
        return True
    return cid[0] in {"D", "U", "W"}



async def set_channel(
    org_id: str,
    *,
    agent_id: str | None,
    channel_id: str,
    channel_name: str = "",
    set_by_user_id: str | None = None,
) -> bool:
    """Bind an agent (or the org default) as the notify channel."""
    if is_forbidden_channel_id(channel_id):
        logger.warning("slack_store: set_channel refused non-channel %s", channel_id)
        return False
    client = await _pg()
    if client is None:
        return False
    try:
        if agent_id:
            await client.execute(
                """
                UPDATE agent_slack_channels SET is_notify = false, updated_at = NOW()
                WHERE org_id = $1 AND agent_id = $2 AND is_notify
                """,
                org_id,
                agent_id,
            )
        else:
            await client.execute(
                """
                UPDATE agent_slack_channels SET is_notify = false, updated_at = NOW()
                WHERE org_id = $1 AND agent_id IS NULL AND is_notify
                """,
                org_id,
            )
        await client.execute(
            """
            INSERT INTO agent_slack_channels
                (id, org_id, agent_id, channel_id, channel_name, set_by_user_id, is_notify)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, true)
            ON CONFLICT (org_id, (COALESCE(agent_id, '')), channel_id) DO UPDATE SET
                channel_name = EXCLUDED.channel_name,
                set_by_user_id = EXCLUDED.set_by_user_id,
                is_notify = true,
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



async def save_agent_channels(
    org_id: str,
    *,
    agent_id: str,
    watch: list[dict[str, Any]],
    notify_channel_id: str | None,
    notify_channel_name: str = "",
    set_by_user_id: str | None = None,
) -> bool:
    """Replace watch rows and the notify row for one agent.

    Notify may be one of the watch channels. DMs and user ids are dropped.
    """
    if not agent_id:
        return False
    client = await _pg()
    if client is None:
        return False
    cleaned: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in watch:
        cid = str(raw.get("channel_id") or "").strip()
        name = str(raw.get("channel_name") or "").strip()
        if not cid or is_forbidden_channel_id(cid) or cid in seen:
            continue
        seen.add(cid)
        cleaned.append((cid, name))
    notify_id = (notify_channel_id or "").strip() or None
    if notify_id and is_forbidden_channel_id(notify_id):
        logger.warning("slack_store: notify refused non-channel %s", notify_id)
        notify_id = None
    if notify_id and notify_id not in seen:
        cleaned.append((notify_id, (notify_channel_name or "").strip()))
        seen.add(notify_id)
    try:
        await client.execute(
            "DELETE FROM agent_slack_channels WHERE org_id = $1 AND agent_id = $2",
            org_id,
            agent_id,
        )
        for cid, name in cleaned:
            await client.execute(
                """
                INSERT INTO agent_slack_channels
                    (id, org_id, agent_id, channel_id, channel_name,
                     set_by_user_id, is_notify)
                VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
                """,
                str(uuid.uuid4()),
                org_id,
                agent_id,
                cid,
                name,
                set_by_user_id,
                bool(notify_id and cid == notify_id),
            )
        return True
    except Exception as exc:
        logger.warning("slack_store: save_agent_channels failed: %s", exc)
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
                ORDER BY CASE WHEN is_notify THEN 0 ELSE 1 END, updated_at DESC
                LIMIT 1
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
            SELECT agent_id, channel_id, channel_name, updated_at,
                   COALESCE(is_notify, false) AS is_notify
            FROM agent_slack_channels
            WHERE org_id = $1
            ORDER BY is_notify DESC, updated_at DESC
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



def needs_reconsent(install: dict[str, Any] | None) -> bool:
    """True when history scopes are missing or not yet consented."""
    from eden.integrations.slack.oauth import HISTORY_SCOPES

    if not install:
        return True
    scopes = {
        s.strip()
        for s in str(install.get("granted_scopes") or "").split(",")
        if s.strip()
    }
    if not all(s in scopes for s in HISTORY_SCOPES):
        return True
    return not install.get("history_consented_at")


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
    if canary_arm is None:
        try:
            from eden.agents.prompt_canary import resolve_canary_arm

            canary_arm = await resolve_canary_arm(org_id, agent_id, session_id)
        except Exception as exc:
            logger.debug("slack_store: resolve_canary_arm failed: %s", exc)
            canary_arm = None
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
            RETURNING id, org_id, agent_id, event_id, kind, confidence,
                      polarity, help_contract_id, session_id, snippet,
                      path, canary_arm, user_id
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
        if row is None:
            return None
        result = dict(row)
        result.setdefault("polarity", polarity)
        result.setdefault("path", path)
        result.setdefault("snippet", snippet)
        result.setdefault("session_id", session_id)
        result.setdefault("help_contract_id", help_contract_id)
        result.setdefault("user_id", user_id)
        result.setdefault("canary_arm", canary_arm)
        try:
            from eden.issues.issue_promoter import promote_from_extra_work

            await promote_from_extra_work(result)
        except Exception as exc:
            logger.debug("slack_store: help_miss promote failed: %s", exc)
        return result
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
    """Encrypted 7-day candidate. Stage-3 uncertain while Stage 4 is off."""
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


def _exec_rowcount(status: object) -> int:
    parts = str(status or "").split()
    if parts and parts[-1].isdigit():
        return int(parts[-1])
    return 0


async def expire_candidates() -> int:
    """Delete extra_work_candidates past the 7-day TTL. Not a chat index."""
    client = await _pg()
    if client is None:
        return 0
    try:
        status = await client.execute(
            "DELETE FROM extra_work_candidates WHERE expires_at < NOW()"
        )
        return _exec_rowcount(status)
    except Exception as exc:
        logger.debug("slack_store: expire_candidates failed: %s", exc)
        return 0


async def delete_candidates_for_org(org_id: str) -> int:
    """Disconnect / kick: drop the encrypted buffer for the workspace."""
    client = await _pg()
    if client is None or not org_id:
        return 0
    try:
        status = await client.execute(
            "DELETE FROM extra_work_candidates WHERE org_id = $1",
            org_id,
        )
        return _exec_rowcount(status)
    except Exception as exc:
        logger.debug("slack_store: delete_candidates_for_org failed: %s", exc)
        return 0


# store.py append — Path B pointers + help rollup helpers

_POINTERS: list[dict[str, Any]] = []
_OUTCOMES: list[dict[str, Any]] = []
_CONTRACTS: dict[tuple[str, str], dict[str, Any]] = {}
_HELPED: dict[tuple[str, str], str] = {}


def parse_permalink_ts(value: str) -> str | None:
    """``p135854651500008`` -> ``1358546515.000008``. None if no ts."""
    import re

    if not value:
        return None
    raw = str(value).strip()
    m = re.search(r"p(\d{10})(\d+)", raw)
    if m:
        return f"{m.group(1)}.{m.group(2).rjust(6, "0")[:6]}"
    if re.fullmatch(r"\d+\.\d+", raw):
        return raw
    return None


async def save_pointer(
    org_id: str,
    *,
    channel_id: str,
    ts: str,
    agent_id: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any] | None:
    """Persist chat.postMessage channel+ts for Path B. No ts -> no join."""
    if not channel_id or not ts:
        return None
    from datetime import UTC, datetime

    pointer = {
        "org_id": org_id,
        "channel_id": str(channel_id),
        "ts": str(ts),
        "agent_id": agent_id,
        "session_id": session_id,
        "opened_at": datetime.now(UTC).isoformat(),
        "window_closed_at": None,
    }
    _POINTERS.append(pointer)
    if session_id:
        client = await _pg()
        if client is not None:
            try:
                await client.execute(
                    """
                    UPDATE agent_sessions
                    SET metadata = coalesce(metadata, '{}'::jsonb)
                        || $3::jsonb
                    WHERE org_id = $1 AND id = $2::uuid
                    """,
                    org_id,
                    session_id,
                    json.dumps({"slack": {"channel": channel_id, "ts": ts}}),
                )
            except Exception as exc:
                logger.debug("slack_store: save_pointer session failed: %s", exc)
    return pointer


def get_pointers(
    org_id: str, *, session_id: str | None = None, agent_id: str | None = None
) -> list[dict[str, Any]]:
    rows = [p for p in _POINTERS if p.get("org_id") == org_id]
    if session_id:
        rows = [p for p in rows if p.get("session_id") == session_id]
    if agent_id:
        rows = [p for p in rows if p.get("agent_id") == agent_id]
    return list(rows)


async def upsert_help_contract(
    org_id: str,
    *,
    agent_id: str,
    sentence: str,
    created_by: str,
    x_job: str | None = None,
    x_keywords: list[str] | None = None,
    y_person: str | None = None,
    y_slack_user_id: str | None = None,
) -> dict[str, Any]:
    """Write a new current contract; supersede the previous row."""
    row = {
        "id": str(uuid.uuid4()),
        "org_id": org_id,
        "agent_id": agent_id,
        "sentence": sentence,
        "x_job": x_job,
        "x_keywords": list(x_keywords or []),
        "y_person": y_person,
        "y_slack_user_id": y_slack_user_id,
        "created_by": created_by,
        "superseded_at": None,
    }
    _CONTRACTS[(org_id, agent_id)] = row
    client = await _pg()
    if client is None:
        return row
    try:
        await client.execute(
            """
            UPDATE help_contracts
            SET superseded_at = NOW()
            WHERE org_id = $1 AND agent_id = $2 AND superseded_at IS NULL
            """,
            org_id,
            agent_id,
        )
        await client.execute(
            """
            INSERT INTO help_contracts (
                id, org_id, agent_id, sentence, x_job, x_keywords,
                y_person, y_slack_user_id, created_by
            ) VALUES (
                $1::uuid, $2, $3, $4, $5, $6::text[], $7, $8, $9
            )
            """,
            row["id"],
            org_id,
            agent_id,
            sentence,
            x_job,
            row["x_keywords"],
            y_person,
            y_slack_user_id,
            created_by,
        )
    except Exception as exc:
        logger.debug("slack_store: upsert_help_contract failed: %s", exc)
    return row


async def insert_session_outcome(
    org_id: str,
    *,
    agent_id: str,
    value: str,
    source: str,
    channel: str,
    explicit: bool,
    session_id: str | None = None,
    help_contract_id: str | None = None,
    trace_id: str | None = None,
    user_id: str | None = None,
    reason: str | None = None,
    confidence: str = "high",
    observed_at: str | None = None,
    canary_arm: str | None = None,
) -> dict[str, Any]:
    from datetime import UTC, datetime

    row = {
        "id": str(uuid.uuid4()),
        "org_id": org_id,
        "session_id": session_id,
        "agent_id": agent_id,
        "help_contract_id": help_contract_id,
        "trace_id": trace_id,
        "user_id": user_id,
        "value": value,
        "source": source,
        "channel": channel,
        "explicit": explicit,
        "reason": reason,
        "confidence": confidence,
        "observed_at": observed_at or datetime.now(UTC).isoformat(),
        "canary_arm": canary_arm,
    }
    _OUTCOMES.append(row)
    client = await _pg()
    if client is None:
        return row
    try:
        await client.execute(
            """
            INSERT INTO session_outcomes (
                id, org_id, session_id, agent_id, help_contract_id, trace_id,
                user_id, value, source, channel, explicit, reason,
                confidence, observed_at, canary_arm
            ) VALUES (
                $1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10, $11,
                $12, $13, $14::timestamptz, $15
            )
            """,
            row["id"],
            org_id,
            session_id,
            agent_id,
            help_contract_id,
            trace_id,
            user_id,
            value,
            source,
            channel,
            explicit,
            reason,
            confidence,
            row["observed_at"],
            canary_arm,
        )
    except Exception as exc:
        logger.debug("slack_store: insert_session_outcome failed: %s", exc)
    return row


# ExtraWorkEvent.surface enum (spec 4.2). Same 7 names as webhook persist.
_EXTRA_WORK_SURFACES = frozenset(
    {"slack", "linear", "jira", "github", "intercom", "zendesk", "webhook"}
)


def leftover_by_surface(events: list[dict[str, Any]]) -> dict[str, int]:
    """Integer leftover counts per fired surface. No rate, no zero-fill."""
    counts: dict[str, int] = {}
    for ev in events:
        if str(ev.get("polarity") or "") != "extra_work":
            continue
        surface = str(ev.get("surface") or "").strip().lower()
        if surface not in _EXTRA_WORK_SURFACES:
            continue
        counts[surface] = counts.get(surface, 0) + 1
    return {k: v for k, v in counts.items() if v > 0}


async def list_leftover_events(
    org_id: str, *, agent_id: str | None = None, limit: int = 20
) -> list[dict[str, Any]]:
    """Ambient / pointer hits for the leftover list. No fake sessions."""
    client = await _pg()
    if client is None:
        return []
    try:
        if agent_id:
            rows = await client.fetch(
                """
                SELECT id, org_id, session_id, agent_id, user_id, surface,
                       kind, path, join_key, snippet, confidence, polarity,
                       observed_at
                FROM extra_work_events
                WHERE org_id = $1 AND agent_id = $2
                  AND polarity = 'extra_work'
                ORDER BY observed_at DESC
                LIMIT $3
                """,
                org_id,
                agent_id,
                limit,
            )
        else:
            rows = await client.fetch(
                """
                SELECT id, org_id, session_id, agent_id, user_id, surface,
                       kind, path, join_key, snippet, confidence, polarity,
                       observed_at
                FROM extra_work_events
                WHERE org_id = $1 AND polarity = 'extra_work'
                ORDER BY observed_at DESC
                LIMIT $2
                """,
                org_id,
                limit,
            )
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.debug("slack_store: list_leftover_events failed: %s", exc)
        return []


async def list_help_miss_leftovers(
    org_id: str,
    *,
    agent_id: str,
    help_contract_id: str | None = None,
    kinds: list[str] | None = None,
    limit: int = 3,
) -> list[dict[str, Any]]:
    """Up to three ExtraWorkEvent hits for one HelpMiss group."""
    if not org_id or not agent_id or not kinds:
        return []
    client = await _pg()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, org_id, session_id, agent_id, help_contract_id,
                   trace_id, surface, kind, path, snippet, confidence,
                   polarity, observed_at
            FROM extra_work_events
            WHERE org_id = $1 AND agent_id = $2
              AND polarity = 'extra_work'
              AND confidence IN ('high', 'medium')
              AND snippet IS NOT NULL AND btrim(snippet) <> ''
              AND kind = ANY($3::text[])
              AND coalesce(help_contract_id::text, '') = $4
            ORDER BY observed_at DESC
            LIMIT $5
            """,
            org_id,
            agent_id,
            list(kinds),
            (help_contract_id or "").strip(),
            max(1, int(limit or 3)),
        )
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.debug("slack_store: list_help_miss_leftovers failed: %s", exc)
        return []


async def help_counts(org_id: str, *, agent_id: str | None = None) -> dict[str, Any]:
    client = await _pg()
    out: dict[str, Any] = {
        "helped": 0,
        "not_helped": 0,
        "unknown": 0,
        "leftover_7d": 0,
        "by_surface": {},
    }
    if client is None:
        return out
    try:
        agent_filter = "AND agent_id = $2" if agent_id else ""
        args: list[Any] = [org_id]
        if agent_id:
            args.append(agent_id)
        rows = await client.fetch(
            f"""
            SELECT helped, count(*) AS n
            FROM session_summaries
            WHERE org_id = $1 {agent_filter}
            GROUP BY helped
            """,
            *args,
        )
        for r in rows:
            key = str(r["helped"] or "unknown")
            if key in ("helped", "not_helped", "unknown"):
                out[key] = int(r["n"])
        surface_rows = await client.fetch(
            f"""
            SELECT surface, count(*) AS n
            FROM extra_work_events
            WHERE org_id = $1 {agent_filter}
              AND polarity = 'extra_work'
              AND observed_at >= NOW() - INTERVAL '7 days'
            GROUP BY surface
            """,
            *args,
        )
        by_surface: dict[str, int] = {}
        for r in surface_rows:
            n = int(r["n"] or 0)
            if n <= 0:
                continue
            surface = str(r["surface"] or "").strip().lower()
            if surface not in _EXTRA_WORK_SURFACES:
                continue
            by_surface[surface] = by_surface.get(surface, 0) + n
        out["by_surface"] = by_surface
        out["leftover_7d"] = sum(by_surface.values())
    except Exception as exc:
        logger.debug("slack_store: help_counts failed: %s", exc)
    return out


async def set_session_helped(org_id: str, session_id: str, value: str) -> None:
    if value not in ("helped", "not_helped", "unknown"):
        return
    _HELPED[(org_id, session_id)] = value
    client = await _pg()
    if client is None:
        return
    try:
        await client.execute(
            """
            UPDATE session_summaries
            SET helped = $3
            WHERE org_id = $1 AND session_id = $2
            """,
            org_id,
            session_id,
            value,
        )
    except Exception as exc:
        logger.debug("slack_store: set_session_helped failed: %s", exc)


def memory_outcomes(org_id: str, session_id: str | None = None) -> list[dict[str, Any]]:
    rows = [r for r in _OUTCOMES if r.get("org_id") == org_id]
    if session_id:
        rows = [r for r in rows if r.get("session_id") == session_id]
    return list(rows)


#: Spec §4.2.2 same-thread default. No existing constant in-tree.
POINTER_WINDOW_SECONDS = 30 * 60


def list_due_pointers(*, now_iso: str | None = None) -> list[dict[str, Any]]:
    """In-memory Path B pointers whose 30-min window has closed."""
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)
    if now_iso:
        try:
            now = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        except ValueError:
            pass
    due: list[dict[str, Any]] = []
    for p in _POINTERS:
        if p.get("window_closed_at"):
            continue
        opened = p.get("opened_at")
        try:
            opened_dt = (
                datetime.fromisoformat(str(opened).replace("Z", "+00:00"))
                if opened
                else now
            )
        except ValueError:
            opened_dt = now
        if now - opened_dt >= timedelta(seconds=POINTER_WINDOW_SECONDS):
            due.append(p)
    return due


async def list_due_pointers_from_sessions() -> list[dict[str, Any]]:
    """Durable Path B pointers on agent_sessions.metadata.slack."""
    client = await _pg()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id::text AS session_id, org_id, agent_id, metadata,
                   ended_at, started_at
            FROM agent_sessions
            WHERE metadata -> 'slack' ? 'ts'
              AND metadata -> 'slack' ? 'channel'
              AND COALESCE(metadata -> 'slack' ->> 'window_closed_at', '') = ''
              AND COALESCE(ended_at, started_at)
                    <= NOW() - make_interval(secs => $1)
            LIMIT 200
            """,
            POINTER_WINDOW_SECONDS,
        )
    except Exception as exc:
        logger.debug("slack_store: list_due_pointers_from_sessions failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        slack = (r.get("metadata") or {}).get("slack") or {}
        if not isinstance(slack, dict):
            continue
        channel = str(slack.get("channel") or slack.get("channel_id") or "")
        ts = str(slack.get("ts") or "")
        if not channel or not ts:
            continue
        out.append(
            {
                "org_id": str(r.get("org_id") or ""),
                "channel_id": channel,
                "ts": ts,
                "agent_id": r.get("agent_id"),
                "session_id": r.get("session_id"),
            }
        )
    return out


async def mark_pointer_closed(
    org_id: str, *, session_id: str | None, channel_id: str, ts: str
) -> None:
    from datetime import UTC, datetime

    closed = datetime.now(UTC).isoformat()
    for p in _POINTERS:
        if (
            p.get("org_id") == org_id
            and p.get("channel_id") == channel_id
            and p.get("ts") == ts
        ):
            p["window_closed_at"] = closed
    if not session_id:
        return
    client = await _pg()
    if client is None:
        return
    try:
        await client.execute(
            """
            UPDATE agent_sessions
            SET metadata = jsonb_set(
                coalesce(metadata, '{}'::jsonb),
                '{slack,window_closed_at}',
                to_jsonb($3::text),
                true
            )
            WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id,
            session_id,
            closed,
        )
    except Exception as exc:
        logger.debug("slack_store: mark_pointer_closed failed: %s", exc)


_BACKFILLED: set[tuple[str, str]] = set()


async def is_channel_backfilled(org_id: str, channel_id: str) -> bool:
    if (org_id, channel_id) in _BACKFILLED:
        return True
    client = await _pg()
    if client is None:
        return False
    try:
        found = await client.fetchval(
            """
            SELECT 1 FROM agent_slack_channels
            WHERE org_id = $1 AND channel_id = $2
              AND history_backfilled_at IS NOT NULL
            LIMIT 1
            """,
            org_id,
            channel_id,
        )
        return bool(found)
    except Exception as exc:
        logger.debug("slack_store: is_channel_backfilled failed: %s", exc)
        return False


async def mark_channel_backfilled(org_id: str, channel_id: str) -> None:
    _BACKFILLED.add((org_id, channel_id))
    client = await _pg()
    if client is None:
        return
    try:
        await client.execute(
            """
            UPDATE agent_slack_channels
            SET history_backfilled_at = NOW()
            WHERE org_id = $1 AND channel_id = $2
              AND history_backfilled_at IS NULL
            """,
            org_id,
            channel_id,
        )
    except Exception as exc:
        logger.debug("slack_store: mark_channel_backfilled failed: %s", exc)


__all__ = [
    "clear_channel",
    "is_channel_backfilled",
    "mark_channel_backfilled",
    "event_id_seen",
    "get_agent_for_channel",
    "get_bot_token",
    "get_channel",
    "get_current_help_contract",
    "get_install",
    "get_org_id_for_team",
    "get_pointers",
    "help_counts",
    "delete_candidates_for_org",
    "expire_candidates",
    "insert_candidate",
    "insert_extra_work_event",
    "insert_session_outcome",
    "list_channels",
    "list_due_pointers",
    "list_due_pointers_from_sessions",
    "list_leftover_events",
    "list_help_miss_leftovers",
    "leftover_by_surface",
    "mark_pointer_closed",
    "memory_outcomes",
    "needs_reconsent",
    "POINTER_WINDOW_SECONDS",
    "parse_permalink_ts",
    "revoke_install",
    "save_pointer",
    "save_agent_channels",
    "is_forbidden_channel_id",
    "set_channel",
    "set_session_helped",
    "upsert_help_contract",
    "upsert_install",
]
