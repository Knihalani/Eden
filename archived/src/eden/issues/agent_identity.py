"""Resolve caller-supplied agent identifiers to canonical registration ids.

BUG-13: stumbles/issues written with synthetic telemetry labels (framework
instrumentation ids, fleet display names) are invisible when the portal
filters by the registered ``agent_id``. Resolve on write via
``agent_registrations`` and ``agent_identity_aliases`` (BUG-6).
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _normalize(agent_id: str | None) -> str | None:
    if agent_id is None:
        return None
    trimmed = str(agent_id).strip()
    return trimmed or None


async def resolve_agent_id(org_id: str, agent_id: str | None) -> str | None:
    """Map *agent_id* to the org's canonical registration id when possible.

    Resolution order:

    1. Empty / whitespace → ``None``
    2. Exact match in ``agent_registrations`` → keep as-is
    3. ``agent_identity_aliases.synthetic_label`` → mapped ``agent_id``
    4. Otherwise → return the trimmed caller value unchanged (fail open)
    """
    normalized = _normalize(agent_id)
    if normalized is None:
        return None

    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("agent_identity: postgres unavailable: %s", exc)
        return normalized
    if pg is None:
        return normalized

    try:
        row = await pg.fetchrow(
            """
            SELECT agent_id
            FROM agent_registrations
            WHERE org_id = $1 AND agent_id = $2
            ORDER BY agent_id
            LIMIT 1
            """,
            org_id,
            normalized,
        )
        if row is not None:
            return str(row["agent_id"])
    except Exception as exc:
        logger.debug("agent_identity: registration lookup failed: %s", exc)

    try:
        row = await pg.fetchrow(
            """
            SELECT agent_id
            FROM agent_identity_aliases
            WHERE org_id = $1 AND synthetic_label = $2
            ORDER BY agent_id
            LIMIT 1
            """,
            org_id,
            normalized,
        )
        if row is not None:
            return str(row["agent_id"])
    except Exception as exc:
        logger.debug("agent_identity: alias lookup failed: %s", exc)

    return normalized


def agent_id_filter_sql(
    *,
    org_param: int,
    agent_param: int,
    table_alias: str = "",
) -> str:
    """SQL fragment matching a canonical agent id or its synthetic aliases.

    *org_param* and *agent_param* are 1-based ``$n`` positions for the
    org id and canonical agent id bind args respectively.
    """
    prefix = f"{table_alias}." if table_alias else ""
    return (
        f"({prefix}agent_id = ${agent_param} OR {prefix}agent_id IN ("
        f"SELECT synthetic_label FROM agent_identity_aliases "
        f"WHERE org_id = ${org_param} AND agent_id = ${agent_param}))"
    )
