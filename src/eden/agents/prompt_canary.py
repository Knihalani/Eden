"""Prompt canary assignment — per-tenant A/B traffic split.

Phase 7.2c: the canary logic that lets ``PromptLoader`` pick between
the global active prompt and a tenant-specific candidate based on a
``traffic_pct``. The roll is deterministic per ``(tenant_id, agent,
current_minute)`` so a given tenant stays on the same variant for a
full minute at a time — avoids prompt thrashing where the same call
flickers between two versions within a session.

Decision flow when ``PromptLoader`` resolves a prompt:

    1. Look up ``prompt_version_assignments`` for ``(tenant, agent)``.
    2. If any active rows exist, roll the dice per row's ``traffic_pct``.
    3. The highest-``traffic_pct`` row that wins the roll wins. Ties
       broken by the highest version.
    4. Fall back to the global ``prompt_versions.active = TRUE`` row.
    5. Fall back to the class constant ``SYSTEM_PROMPT``.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import UTC
from typing import Any

logger = logging.getLogger(__name__)


def _stable_roll(tenant_id: str, agent: str, minute: int) -> float:
    """Deterministic hash → [0.0, 1.0) for a (tenant, agent, minute).

    Hashing the inputs makes the roll stable for the same minute
    (avoiding prompt thrashing) but uniformly distributed across
    tenants and minutes (avoiding bias). MD5 is fine here — we
    don't need cryptographic strength, just uniformity.
    """
    raw = f"{tenant_id}:{agent}:{minute}".encode()
    h = hashlib.md5(raw).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def pick_canary_version(
    assignments: list[dict[str, Any]],
    tenant_id: str,
    agent: str,
) -> dict[str, Any] | None:
    """Given a list of active canary assignments for (tenant, agent),
    decide which one wins for this call.

    Each assignment has at least ``version`` and ``traffic_pct``.
    Returns the chosen assignment dict, or ``None`` if the global
    active version should be used.

    B-13 (Session 24): clamps ``traffic_pct`` to [0, 100] at function
    entry. Stale DB rows with ``traffic_pct = 150`` otherwise
    double-bucket the roll (assignments cumulatively exceed 1.0 →
    every tenant lands on the inflated row). Bad rows are still
    returned (the caller's UI shows the truth) but the roll below
    treats them as 100.
    """
    if not assignments:
        return None
    # B-13 (Session 24): validate + clamp every pct at entry. We
    # mutate the dict in place so the caller's view (e.g. an admin
    # dashboard listing) reflects the corrected value too.
    for row in assignments:
        pct = row.get("traffic_pct")
        if pct is None:
            row["traffic_pct"] = 0.0
            continue
        pct_f = float(pct)
        if pct_f < 0.0 or pct_f > 100.0:
            logger.warning(
                "pick_canary_version: traffic_pct=%.1f out of "
                "[0, 100] for (tenant=%s, agent=%s, version=%s); "
                "clamping to 100",
                pct_f, tenant_id, agent, row.get("version"),
            )
            row["traffic_pct"] = 100.0
        else:
            row["traffic_pct"] = pct_f

    from datetime import datetime
    minute = int(datetime.now(UTC).timestamp()) // 60
    roll = _stable_roll(tenant_id, agent, minute)

    cumulative = 0.0
    # Sort by traffic_pct DESC so the largest bucket fills first.
    sorted_rows = sorted(assignments, key=lambda a: -a["traffic_pct"])
    for row in sorted_rows:
        cumulative += float(row["traffic_pct"]) / 100.0
        if roll < cumulative:
            return row
    return sorted_rows[-1]  # floating point edge case

async def resolve_canary_arm(
    org_id: str,
    agent_id: str,
    session_id: str | None = None,
) -> str | None:
    """Tag ExtraWorkEvent / SessionOutcome with control | treatment | None.

    Reuse a session's existing arm when present. Otherwise inherit the
    live canary only if exactly one active experiment exists on the
    agent. Multiple experiments stay None (UNKNOWN-UNTIL-CODE).
    """
    if not org_id or not agent_id:
        return None
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception:
        return None
    if client is None:
        return None

    sid = (session_id or "").strip() or None
    if sid:
        try:
            row = await client.fetchrow(
                """
                SELECT canary_arm FROM extra_work_events
                WHERE org_id = $1 AND session_id = $2
                  AND canary_arm IN ('control', 'treatment')
                ORDER BY observed_at DESC
                LIMIT 1
                """,
                org_id,
                sid,
            )
            if row and row["canary_arm"]:
                return str(row["canary_arm"])
            row = await client.fetchrow(
                """
                SELECT canary_arm FROM session_outcomes
                WHERE org_id = $1 AND session_id = $2
                  AND canary_arm IN ('control', 'treatment')
                ORDER BY observed_at DESC
                LIMIT 1
                """,
                org_id,
                sid,
            )
            if row and row["canary_arm"]:
                return str(row["canary_arm"])
        except Exception as exc:
            logger.debug("resolve_canary_arm: session lookup failed: %s", exc)

    try:
        experiments = await client.fetch(
            """
            SELECT experiment_id, control_version, candidate_version
              FROM prompt_canary_experiments
             WHERE tenant_id = $1 AND agent = $2 AND status = 'active'
            """,
            org_id,
            agent_id,
        )
    except Exception as exc:
        logger.debug("resolve_canary_arm: experiment lookup failed: %s", exc)
        return None
    if len(experiments) != 1:
        return None

    exp = dict(experiments[0])
    try:
        rows = await client.fetch(
            """
            SELECT version, traffic_pct, experiment_id
              FROM prompt_version_assignments
             WHERE tenant_id = $1 AND agent = $2 AND status = 'active'
               AND (expires_at IS NULL OR expires_at > NOW())
               AND experiment_id = $3
            """,
            org_id,
            agent_id,
            exp["experiment_id"],
        )
    except Exception as exc:
        logger.debug("resolve_canary_arm: assignment lookup failed: %s", exc)
        return None
    assignments = [dict(r) for r in rows]
    chosen = pick_canary_version(assignments, org_id, agent_id)
    candidate = exp.get("candidate_version")
    if chosen is not None and candidate is not None:
        try:
            if int(chosen.get("version") or -1) == int(candidate):
                return "treatment"
        except (TypeError, ValueError):
            pass
    return "control"
