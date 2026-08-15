"""Persistence helpers for NL alert rules and alert events."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from eden.storage.postgres import get_postgres_client

_NL_RULE_COLUMNS = (
    "id, org_id, name, nl_text, compiled_eql, triage_enabled, "
    "channels, enabled, severity, created_by, last_fired_at, created_at, "
    "updated_at"
)
def _normalize_nl_rule_severity(raw: str | None) -> str:
    """Map portal/EQL aliases to persisted ``nl_alert_rules.severity``."""
    s = (raw or "warning").lower()
    if s in ("critical", "crit", "p0"):
        return "critical"
    if s in ("high", "error", "err", "p1"):
        return "high"
    if s in ("info", "p3"):
        return "info"
    if s in ("warning", "warn", "medium", "p2"):
        return "warning"
    return "warning"

_ALERT_EVENT_COLUMNS = (
    "id, org_id, rule_id, title, severity, payload, triage_verdict, "
    "triage_reason, triage_confidence, incident_id, acknowledged, "
    "created_at, updated_at"
)

_SUPPRESSION_RULE_COLUMNS = (
    "id, org_id, pattern, reason, window_hours, enabled, "
    "created_by_user_id, created_at, updated_at"
)


def _ts(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


async def create_nl_rule(
    *,
    org_id: str,
    name: str,
    nl_text: str,
    compiled_eql: str,
    triage_enabled: bool = True,
    channels: dict[str, Any] | None = None,
    enabled: bool = True,
    severity: str = "warning",
    created_by: str | None = None,
) -> dict[str, Any]:
    rule_id = str(uuid.uuid4())
    sev = _normalize_nl_rule_severity(severity)
    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO nl_alert_rules (
            id, org_id, name, nl_text, compiled_eql,
            triage_enabled, channels, enabled, severity, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
        """,
        rule_id,
        org_id,
        name,
        nl_text,
        compiled_eql,
        triage_enabled,
        json.dumps(channels or {"in_app": True}),
        enabled,
        sev,
        created_by,
    )
    return await get_nl_rule(org_id, rule_id)


async def get_nl_rule(org_id: str, rule_id: str) -> dict[str, Any] | None:
    client = await get_postgres_client()
    row = await client.fetchrow(
        f"SELECT {_NL_RULE_COLUMNS} FROM nl_alert_rules WHERE org_id = $1 AND id = $2",
        org_id,
        rule_id,
    )
    return _rule_row(row) if row else None


async def list_nl_rules(org_id: str) -> list[dict[str, Any]]:
    client = await get_postgres_client()
    rows = await client.fetch(
        f"""
        SELECT {_NL_RULE_COLUMNS} FROM nl_alert_rules
        WHERE org_id = $1
        ORDER BY created_at DESC
        """,
        org_id,
    )
    return [_rule_row(r) for r in rows]


async def update_nl_rule(
    org_id: str,
    rule_id: str,
    *,
    name: str | None = None,
    nl_text: str | None = None,
    compiled_eql: str | None = None,
    triage_enabled: bool | None = None,
    channels: dict[str, Any] | None = None,
    enabled: bool | None = None,
    severity: str | None = None,
) -> dict[str, Any] | None:
    sets: list[str] = []
    params: list[Any] = [org_id, rule_id]
    idx = 3
    for field, value in (
        ("name", name),
        ("nl_text", nl_text),
        ("compiled_eql", compiled_eql),
        ("triage_enabled", triage_enabled),
        ("enabled", enabled),
        ("severity", _normalize_nl_rule_severity(severity) if severity is not None else None),
    ):
        if value is not None:
            sets.append(f"{field} = ${idx}")
            params.append(value)
            idx += 1
    if channels is not None:
        sets.append(f"channels = ${idx}::jsonb")
        params.append(json.dumps(channels))
        idx += 1
    if not sets:
        return await get_nl_rule(org_id, rule_id)
    client = await get_postgres_client()
    await client.execute(
        f"UPDATE nl_alert_rules SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE org_id = $1 AND id = $2",
        *params,
    )
    return await get_nl_rule(org_id, rule_id)


async def list_enabled_suppression_patterns(org_id: str) -> list[dict[str, Any]]:
    """Enabled org patterns for ``AlertTriageJudge`` (FEAT-134)."""
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT pattern, reason, window_hours
        FROM alert_suppression_rules
        WHERE org_id = $1 AND enabled = TRUE
        ORDER BY created_at ASC
        """,
        org_id,
    )
    return [
        {
            "pattern": str(row["pattern"]),
            "reason": str(row.get("reason") or ""),
            "window_hours": (
                int(row["window_hours"])
                if row.get("window_hours") is not None
                else None
            ),
        }
        for row in rows
    ]


async def list_suppression_rules(org_id: str) -> list[dict[str, Any]]:
    client = await get_postgres_client()
    rows = await client.fetch(
        f"""
        SELECT {_SUPPRESSION_RULE_COLUMNS} FROM alert_suppression_rules
        WHERE org_id = $1
        ORDER BY created_at DESC
        """,
        org_id,
    )
    return [_suppression_row(r) for r in rows]


async def create_suppression_rule(
    *,
    org_id: str,
    pattern: str,
    reason: str = "",
    window_hours: int | None = None,
    enabled: bool = True,
    created_by_user_id: str | None = None,
) -> dict[str, Any]:
    rule_id = str(uuid.uuid4())
    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO alert_suppression_rules (
            id, org_id, pattern, reason, window_hours, enabled, created_by_user_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        """,
        rule_id,
        org_id,
        pattern,
        reason,
        window_hours,
        enabled,
        created_by_user_id,
    )
    return await get_suppression_rule(org_id, rule_id)  # type: ignore[return-value]


async def get_suppression_rule(
    org_id: str, rule_id: str
) -> dict[str, Any] | None:
    client = await get_postgres_client()
    row = await client.fetchrow(
        f"""
        SELECT {_SUPPRESSION_RULE_COLUMNS} FROM alert_suppression_rules
        WHERE org_id = $1 AND id = $2
        """,
        org_id,
        rule_id,
    )
    return _suppression_row(row) if row else None


async def update_suppression_rule(
    org_id: str,
    rule_id: str,
    *,
    pattern: str | None = None,
    reason: str | None = None,
    window_hours: int | None = None,
    enabled: bool | None = None,
) -> dict[str, Any] | None:
    sets: list[str] = []
    params: list[Any] = [org_id, rule_id]
    idx = 3
    for field, value in (
        ("pattern", pattern),
        ("reason", reason),
        ("window_hours", window_hours),
        ("enabled", enabled),
    ):
        if value is not None:
            sets.append(f"{field} = ${idx}")
            params.append(value)
            idx += 1
    if not sets:
        return await get_suppression_rule(org_id, rule_id)
    client = await get_postgres_client()
    await client.execute(
        f"""
        UPDATE alert_suppression_rules
        SET {', '.join(sets)}, updated_at = NOW()
        WHERE org_id = $1 AND id = $2
        """,
        *params,
    )
    return await get_suppression_rule(org_id, rule_id)


async def delete_suppression_rule(org_id: str, rule_id: str) -> bool:
    client = await get_postgres_client()
    result = await client.execute(
        "DELETE FROM alert_suppression_rules WHERE org_id = $1 AND id = $2",
        org_id,
        rule_id,
    )
    return result != "DELETE 0"


def validate_suppression_pattern(pattern: str) -> str | None:
    """Return an error message when ``pattern`` is unusable."""
    trimmed = pattern.strip()
    if not trimmed:
        return "Pattern is required"
    if len(trimmed) > 512:
        return "Pattern must be at most 512 characters"
    try:
        re.compile(trimmed, re.IGNORECASE)
    except re.error:
        return None
    return None


async def delete_nl_rule(org_id: str, rule_id: str) -> bool:
    client = await get_postgres_client()
    result = await client.execute(
        "DELETE FROM nl_alert_rules WHERE org_id = $1 AND id = $2",
        org_id,
        rule_id,
    )
    return result != "DELETE 0"


async def create_alert_event(
    *,
    org_id: str,
    rule_id: str | None,
    title: str,
    severity: str = "warning",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    event_id = str(uuid.uuid4())
    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO alert_events (
            id, org_id, rule_id, title, severity, payload, triage_verdict
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending')
        """,
        event_id,
        org_id,
        rule_id,
        title,
        severity,
        json.dumps(payload or {}),
    )
    row = await client.fetchrow(
        "SELECT * FROM alert_events WHERE id = $1",
        event_id,
    )
    return _event_row(row)


async def list_alert_events(
    org_id: str,
    *,
    verdict: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    client = await get_postgres_client()
    conditions = ["org_id = $1"]
    params: list[Any] = [org_id]
    idx = 2
    if verdict:
        conditions.append(f"triage_verdict = ${idx}")
        params.append(verdict)
        idx += 1
    where = " AND ".join(conditions)
    count_row = await client.fetchrow(
        f"SELECT COUNT(*) AS n FROM alert_events WHERE {where}",
        *params,
    )
    total = int(count_row["n"] if count_row else 0)
    rows = await client.fetch(
        f"""
        SELECT {_ALERT_EVENT_COLUMNS} FROM alert_events
        WHERE {where}
        ORDER BY created_at DESC
        LIMIT ${idx} OFFSET ${idx + 1}
        """,
        *params,
        limit,
        offset,
    )
    return [_event_row(r) for r in rows], total


async def set_alert_acknowledged(
    *,
    alert_event_id: str,
    org_id: str,
    acknowledged: bool,
) -> dict[str, Any] | None:
    """Set ``alert_events.acknowledged`` for an org-scoped event."""
    client = await get_postgres_client()
    row = await client.fetchrow(
        f"""
        UPDATE alert_events
        SET acknowledged = $3, updated_at = NOW()
        WHERE id = $1 AND org_id = $2
        RETURNING {_ALERT_EVENT_COLUMNS}
        """,
        alert_event_id,
        org_id,
        acknowledged,
    )
    return _event_row(row) if row else None


async def record_triage_feedback(
    *,
    alert_event_id: str,
    human_verdict: str,
    created_by: str | None,
    org_id: str | None = None,
) -> dict[str, Any] | None:
    """Record human override. When ``org_id`` is set, require event membership."""
    feedback_id = str(uuid.uuid4())
    client = await get_postgres_client()
    if org_id is not None:
        owned = await client.fetchrow(
            "SELECT id FROM alert_events WHERE id = $1 AND org_id = $2",
            alert_event_id,
            org_id,
        )
        if not owned:
            return None
    await client.execute(
        """
        INSERT INTO alert_triage_feedback (id, alert_event_id, human_verdict, created_by)
        VALUES ($1, $2, $3, $4)
        """,
        feedback_id,
        alert_event_id,
        human_verdict,
        created_by,
    )
    if org_id is not None:
        await client.execute(
            """
            UPDATE alert_events
            SET triage_verdict = $3, triage_reason = $4, updated_at = NOW()
            WHERE id = $1 AND org_id = $2
            """,
            alert_event_id,
            org_id,
            human_verdict,
            "Human override",
        )
    else:
        await client.execute(
            """
            UPDATE alert_events
            SET triage_verdict = $2, triage_reason = $3, updated_at = NOW()
            WHERE id = $1
            """,
            alert_event_id,
            human_verdict,
            "Human override",
        )
    return {
        "id": feedback_id,
        "alert_event_id": alert_event_id,
        "human_verdict": human_verdict,
        "created_by": created_by,
    }


def _suppression_row(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "org_id": str(row["org_id"]),
        "pattern": row["pattern"],
        "reason": row.get("reason") or "",
        "window_hours": (
            int(row["window_hours"])
            if row.get("window_hours") is not None
            else None
        ),
        "enabled": bool(row["enabled"]),
        "created_by_user_id": row.get("created_by_user_id"),
        "created_at": _ts(row.get("created_at")),
        "updated_at": _ts(row.get("updated_at")),
    }


def _rule_row(row: Any) -> dict[str, Any]:
    channels = row["channels"]
    if isinstance(channels, str):
        channels = json.loads(channels)
    return {
        "id": str(row["id"]),
        "org_id": str(row["org_id"]),
        "name": row["name"],
        "nl_text": row["nl_text"],
        "compiled_eql": row["compiled_eql"],
        "triage_enabled": bool(row["triage_enabled"]),
        "channels": channels if isinstance(channels, dict) else {},
        "enabled": bool(row["enabled"]),
        "severity": row.get("severity") or "warning",
        "created_by": row.get("created_by"),
        "last_fired_at": _ts(row.get("last_fired_at")),
        "created_at": _ts(row.get("created_at")),
        "updated_at": _ts(row.get("updated_at")),
    }


def _event_row(row: Any) -> dict[str, Any]:
    payload = row["payload"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    return {
        "id": str(row["id"]),
        "org_id": str(row["org_id"]),
        "rule_id": str(row["rule_id"]) if row.get("rule_id") else None,
        "title": row["title"],
        "severity": row["severity"],
        "payload": payload if isinstance(payload, dict) else {},
        "triage_verdict": row.get("triage_verdict"),
        "triage_reason": row.get("triage_reason"),
        "triage_confidence": (
            float(row["triage_confidence"])
            if row.get("triage_confidence") is not None
            else None
        ),
        "incident_id": str(row["incident_id"]) if row.get("incident_id") else None,
        "acknowledged": bool(row.get("acknowledged")),
        "created_at": _ts(row.get("created_at")),
        "updated_at": _ts(row.get("updated_at")),
    }
