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

Public surface (used by ``PromptLoader`` and tests):

    * ``_stable_roll``  — the deterministic per-(tenant, agent, minute)
      hash → [0, 1) value.
    * ``pick_canary_version`` — the pure-function dice roller.
    * ``fetch_active_assignments`` — async DB helper that returns
      the active rows for a (tenant, agent) tuple.
    * ``resolve_prompt_version`` — async end-to-end: queries the DB,
      rolls the dice, and returns the chosen version (or ``None`` to
      fall back to the global active).
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _stable_roll(tenant_id: str, agent: str, minute: int) -> float:
    """Deterministic hash → [0.0, 1.0) for a (tenant, agent, minute).

    Hashing the inputs makes the roll stable for the same minute
    (avoiding prompt thrashing) but uniformly distributed across
    tenants and minutes (avoiding bias). MD5 is fine here — we
    don't need cryptographic strength, just uniformity.
    """
    raw = f"{tenant_id}:{agent}:{minute}".encode("utf-8")
    h = hashlib.md5(raw).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def pick_canary_version(
    assignments: list[dict[str, Any]],
    tenant_id: str,
    agent: str,
) -> Optional[dict[str, Any]]:
    """Given a list of active canary assignments for (tenant, agent),
    decide which one wins for this call.

    Each assignment has at least ``version`` and ``traffic_pct``.
    Returns the chosen assignment dict, or ``None`` if the global
    active version should be used.
    """
    if not assignments:
        return None
    from datetime import datetime, timezone
    minute = int(datetime.now(timezone.utc).timestamp()) // 60
    roll = _stable_roll(tenant_id, agent, minute)

    cumulative = 0.0
    # Sort by traffic_pct DESC so the largest bucket fills first.
    sorted_rows = sorted(assignments, key=lambda a: -a["traffic_pct"])
    for row in sorted_rows:
        cumulative += float(row["traffic_pct"]) / 100.0
        if roll < cumulative:
            return row
    return sorted_rows[-1]  # floating point edge case


async def fetch_active_assignments(
    tenant_id: str,
    agent: str,
) -> list[dict[str, Any]]:
    """Return the active canary assignments for (tenant, agent).

    Reads from ``prompt_version_assignments``. Returns ``[]`` on any
    DB error — the caller falls back to the global active version.

    Each row has at least:
        ``version``        — int
        ``traffic_pct``    — int 0-100
        ``experiment_id``  — UUID str
    """
    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
    except Exception as exc:  # pragma: no cover - best-effort
        logger.debug(f"fetch_active_assignments: postgres unavailable: {exc}")
        return []
    if not client:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT version, traffic_pct, experiment_id
            FROM prompt_version_assignments
            WHERE tenant_id = $1
              AND agent = $2
              AND status = 'active'
              AND (expires_at IS NULL OR expires_at > NOW())
            """,
            tenant_id,
            agent,
        )
    except Exception as exc:
        logger.debug(f"fetch_active_assignments: query failed: {exc}")
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append({
            "version": int(r.get("version") or 0),
            "traffic_pct": int(r.get("traffic_pct") or 0),
            "experiment_id": str(r.get("experiment_id") or ""),
        })
    return out


async def resolve_prompt_version(
    tenant_id: str,
    agent: str,
) -> Optional[int]:
    """End-to-end canary resolution: fetch assignments, roll the
    dice, return the chosen version, or ``None`` if the global
    active version should be used.

    This is the helper ``PromptLoader`` should call from its async
    variant. It is intentionally side-effect-free: the actual prompt
    text comes from ``prompt_versions`` based on the returned
    version, and the caller is responsible for falling back to the
    class-level ``SYSTEM_PROMPT`` if the version is not in the KB.
    """
    assignments = await fetch_active_assignments(tenant_id, agent)
    choice = pick_canary_version(assignments, tenant_id, agent)
    if not choice:
        return None
    return int(choice["version"])
