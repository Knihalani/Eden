"""CRUD for improvement_plans inbox (N23)."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Any

from eden.storage.postgres import get_postgres_client

_OPEN_STATUSES = ("draft", "pending_review", "approved", "pr_opened")


def _ts(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _row(row: Any) -> dict[str, Any]:
    d = dict(row)
    for key in (
        "created_at",
        "updated_at",
        "approved_at",
        "rejected_at",
        "snoozed_until",
    ):
        if key in d:
            d[key] = _ts(d[key])
    for jkey in ("files_changed", "evidence", "triage_snapshot"):
        val = d.get(jkey)
        if isinstance(val, str):
            try:
                d[jkey] = json.loads(val)
            except Exception:
                d[jkey] = {} if jkey != "files_changed" else []
    if d.get("llm_cost_usd") is not None:
        d["llm_cost_usd"] = float(d["llm_cost_usd"])
    d["id"] = str(d["id"])
    if d.get("run_id"):
        d["run_id"] = str(d["run_id"])
    return d


async def create_plan(
    org_id: str,
    *,
    plan_kind: str,
    title: str,
    run_id: str | None = None,
    agent_id: str | None = None,
    summary: str | None = None,
    source_ref: str | None = None,
    source_fingerprint: str | None = None,
    diff_unified: str | None = None,
    files_changed: list[Any] | None = None,
    evidence: dict[str, Any] | None = None,
    triage_snapshot: dict[str, Any] | None = None,
    estimated_blast_radius: str | None = None,
    llm_cost_usd: float = 0.0,
    status: str = "draft",
) -> dict[str, Any] | None:
    plan_id = str(uuid.uuid4())
    client = await get_postgres_client()
    if client is None:
        return None
    try:
        await client.execute(
            """
            INSERT INTO improvement_plans (
                id, org_id, run_id, agent_id, plan_kind, status, title,
                summary, source_ref, source_fingerprint, diff_unified,
                files_changed, evidence, triage_snapshot,
                estimated_blast_radius, llm_cost_usd
            ) VALUES (
                $1::uuid, $2, $3::uuid, $4, $5, $6, $7,
                $8, $9, $10, $11,
                $12::jsonb, $13::jsonb, $14::jsonb,
                $15, $16
            )
            """,
            plan_id,
            org_id,
            run_id,
            agent_id,
            plan_kind,
            status,
            title,
            summary,
            source_ref,
            source_fingerprint,
            diff_unified,
            json.dumps(files_changed or []),
            json.dumps(evidence or {}),
            json.dumps(triage_snapshot) if triage_snapshot else None,
            estimated_blast_radius,
            llm_cost_usd,
        )
    except Exception:
        return None
    return await get_plan(org_id, plan_id)


async def get_plan(org_id: str, plan_id: str) -> dict[str, Any] | None:
    client = await get_postgres_client()
    if client is None:
        return None
    row = await client.fetchrow(
        "SELECT * FROM improvement_plans WHERE org_id = $1 AND id = $2::uuid",
        org_id,
        plan_id,
    )
    return _row(row) if row else None


async def list_plans(
    org_id: str,
    *,
    status: str | None = None,
    plan_kind: str | None = None,
    agent_id: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    client = await get_postgres_client()
    if client is None:
        return []
    clauses = ["org_id = $1"]
    args: list[Any] = [org_id]
    if status:
        args.append(status)
        clauses.append(f"status = ${len(args)}")
    if plan_kind:
        args.append(plan_kind)
        clauses.append(f"plan_kind = ${len(args)}")
    if agent_id:
        args.append(agent_id)
        clauses.append(f"agent_id = ${len(args)}")
    args.append(limit)
    sql = (
        "SELECT * FROM improvement_plans WHERE "
        + " AND ".join(clauses)
        + f" ORDER BY created_at DESC LIMIT ${len(args)}"
    )
    rows = await client.fetch(sql, *args)
    return [_row(r) for r in rows]


async def find_open_by_fingerprint(
    org_id: str, source_fingerprint: str
) -> dict[str, Any] | None:
    if not source_fingerprint:
        return None
    client = await get_postgres_client()
    if client is None:
        return None
    row = await client.fetchrow(
        """
        SELECT * FROM improvement_plans
        WHERE org_id = $1 AND source_fingerprint = $2
          AND status = ANY($3::text[])
        LIMIT 1
        """,
        org_id,
        source_fingerprint,
        list(_OPEN_STATUSES),
    )
    return _row(row) if row else None


async def find_open_fingerprints(
    org_id: str, fingerprints: list[str]
) -> set[str]:
    """Return fingerprints that already have an open plan (batch dedup check)."""
    fps = [fp for fp in fingerprints if fp]
    if not fps:
        return set()
    client = await get_postgres_client()
    if client is None:
        return set()
    rows = await client.fetch(
        """
        SELECT DISTINCT source_fingerprint
        FROM improvement_plans
        WHERE org_id = $1
          AND source_fingerprint = ANY($2::text[])
          AND status = ANY($3::text[])
        """,
        org_id,
        fps,
        list(_OPEN_STATUSES),
    )
    return {str(r["source_fingerprint"]) for r in rows or []}


async def supersede_drafts(
    org_id: str, source_fingerprint: str, *, except_plan_id: str | None = None
) -> int:
    client = await get_postgres_client()
    if client is None:
        return 0
    if except_plan_id:
        result = await client.execute(
            """
            UPDATE improvement_plans SET status = 'superseded', updated_at = NOW()
            WHERE org_id = $1 AND source_fingerprint = $2
              AND status = 'draft' AND id != $3::uuid
            """,
            org_id,
            source_fingerprint,
            except_plan_id,
        )
    else:
        result = await client.execute(
            """
            UPDATE improvement_plans SET status = 'superseded', updated_at = NOW()
            WHERE org_id = $1 AND source_fingerprint = $2 AND status = 'draft'
            """,
            org_id,
            source_fingerprint,
        )
    try:
        return int(result.split()[-1])
    except Exception:
        return 0


async def update_plan(
    org_id: str,
    plan_id: str,
    *,
    title: str | None = None,
    summary: str | None = None,
    diff_unified: str | None = None,
    diff_edited: bool | None = None,
) -> dict[str, Any] | None:
    sets: list[str] = ["updated_at = NOW()"]
    args: list[Any] = [org_id, plan_id]
    idx = 3
    for field, value in (
        ("title", title),
        ("summary", summary),
        ("diff_unified", diff_unified),
    ):
        if value is not None:
            sets.append(f"{field} = ${idx}")
            args.append(value)
            idx += 1
    if diff_edited is not None:
        sets.append(f"diff_edited = ${idx}")
        args.append(diff_edited)
        idx += 1
    if len(sets) == 1:
        return await get_plan(org_id, plan_id)
    client = await get_postgres_client()
    if client is None:
        return None
    await client.execute(
        f"UPDATE improvement_plans SET {', '.join(sets)} "
        f"WHERE org_id = $1 AND id = $2::uuid",
        *args,
    )
    return await get_plan(org_id, plan_id)


async def mark_approved(
    org_id: str,
    plan_id: str,
    *,
    approved_by: str | None = None,
    status: str = "approved",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    client = await get_postgres_client()
    if client is None:
        return None
    evidence_patch = json.dumps({"approve_metadata": metadata or {}})
    await client.execute(
        """
        UPDATE improvement_plans SET
            status = $3,
            approved_by = $4,
            approved_at = NOW(),
            updated_at = NOW(),
            evidence = evidence || $5::jsonb
        WHERE org_id = $1 AND id = $2::uuid
        """,
        org_id,
        plan_id,
        status,
        approved_by,
        evidence_patch,
    )
    return await get_plan(org_id, plan_id)


async def mark_pr_opened(
    org_id: str,
    plan_id: str,
    *,
    pr_url: str,
    pr_number: int | None,
    github_branch: str,
    approved_by: str | None = None,
) -> dict[str, Any] | None:
    client = await get_postgres_client()
    if client is None:
        return None
    await client.execute(
        """
        UPDATE improvement_plans SET
            status = 'pr_opened',
            pr_url = $3,
            pr_number = $4,
            github_branch = $5,
            approved_by = $6,
            approved_at = NOW(),
            updated_at = NOW()
        WHERE org_id = $1 AND id = $2::uuid
        """,
        org_id,
        plan_id,
        pr_url,
        pr_number,
        github_branch,
        approved_by,
    )
    return await get_plan(org_id, plan_id)


async def reject_plan(
    org_id: str,
    plan_id: str,
    *,
    rejected_by: str | None = None,
    rejection_reason: str | None = None,
) -> dict[str, Any] | None:
    client = await get_postgres_client()
    if client is None:
        return None
    await client.execute(
        """
        UPDATE improvement_plans SET
            status = 'rejected',
            rejected_by = $3,
            rejected_at = NOW(),
            rejection_reason = $4,
            updated_at = NOW()
        WHERE org_id = $1 AND id = $2::uuid
        """,
        org_id,
        plan_id,
        rejected_by,
        rejection_reason,
    )
    return await get_plan(org_id, plan_id)


async def snooze_plan(
    org_id: str,
    plan_id: str,
    *,
    snoozed_until: datetime,
) -> dict[str, Any] | None:
    client = await get_postgres_client()
    if client is None:
        return None
    await client.execute(
        """
        UPDATE improvement_plans SET
            status = 'snoozed',
            snoozed_until = $3,
            updated_at = NOW()
        WHERE org_id = $1 AND id = $2::uuid
        """,
        org_id,
        plan_id,
        snoozed_until,
    )
    return await get_plan(org_id, plan_id)


async def write_rejection_memory(
    org_id: str,
    plan: dict[str, Any],
    *,
    rejection_reason: str,
    rejected_by: str | None = None,
) -> None:
    """Best-effort pr_rejection_memory row for dedupe across sweeps."""
    fp = plan.get("source_fingerprint") or ""
    files = plan.get("files_changed") or []
    file_path = files[0] if files else fp or "unknown"
    title = (plan.get("title") or "")[:200]
    import hashlib

    title_hash = hashlib.sha256(title.encode()).hexdigest()[:16]
    mem_id = f"rej_{uuid.uuid4().hex[:16]}"
    try:
        client = await get_postgres_client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO pr_rejection_memory (
                id, org_id, file_path, signal_type, title_hash,
                rejection_type, rejected_by_user_id, reason, expires_at
            ) VALUES (
                $1, $2, $3, 'improvement_plan', $4,
                'wontfix', $5, $6, NOW() + INTERVAL '7 days'
            )
            """,
            mem_id,
            org_id,
            file_path,
            title_hash,
            rejected_by,
            rejection_reason,
        )
    except Exception:
        pass
