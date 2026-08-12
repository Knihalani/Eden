"""CRUD for improvement_plans inbox (N23)."""

from __future__ import annotations

import contextlib
import json
import uuid
from datetime import datetime
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
    if d.get("parent_plan_id"):
        d["parent_plan_id"] = str(d["parent_plan_id"])
    return d


async def emit_event(
    org_id: str,
    plan_id: str,
    event_type: str,
    *,
    actor: str | None = None,
    detail: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """Append-only lifecycle event (FEAT-30 gap 3).

    Best-effort, mirrors the ``automation_runs`` pattern (migration 102):
    a system/agent transition should never fail because its audit trail
    couldn't be written. Never raises.
    """
    client = await get_postgres_client()
    if client is None:
        return
    with contextlib.suppress(Exception):
        await client.execute(
            """
            INSERT INTO improvement_plan_events (
                id, org_id, plan_id, event_type, actor, detail, payload
            ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb)
            """,
            str(uuid.uuid4()),
            org_id,
            plan_id,
            event_type,
            actor,
            detail,
            json.dumps(payload or {}),
        )


async def list_events(
    org_id: str, plan_id: str, *, limit: int = 200
) -> list[dict[str, Any]]:
    """Full append-only event trail for a plan, oldest first."""
    client = await get_postgres_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, event_type, actor, detail, payload, created_at
            FROM improvement_plan_events
            WHERE org_id = $1 AND plan_id = $2::uuid
            ORDER BY created_at ASC
            LIMIT $3
            """,
            org_id,
            plan_id,
            limit,
        )
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for r in rows or []:
        d = dict(r)
        d["id"] = str(d["id"])
        d["created_at"] = _ts(d.get("created_at"))
        payload = d.get("payload")
        if isinstance(payload, str):
            try:
                d["payload"] = json.loads(payload)
            except Exception:
                d["payload"] = {}
        out.append(d)
    return out


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
    parent_plan_id: str | None = None,
) -> dict[str, Any] | None:
    plan_id = str(uuid.uuid4())
    client = await get_postgres_client()
    if client is None:
        return None
    # M13 (§6.6): stamp base_ref_sha at draft so cockpit can badge stale
    # plans and approve can detect HEAD drift.
    evid = dict(evidence or {})
    if "base_ref_sha" not in evid:
        sha = await _resolve_base_ref_sha(org_id, agent_id)
        if sha:
            evid["base_ref_sha"] = sha
    try:
        await client.execute(
            """
            INSERT INTO improvement_plans (
                id, org_id, run_id, agent_id, plan_kind, status, title,
                summary, source_ref, source_fingerprint, diff_unified,
                files_changed, evidence, triage_snapshot,
                estimated_blast_radius, llm_cost_usd, parent_plan_id
            ) VALUES (
                $1::uuid, $2, $3::uuid, $4, $5, $6, $7,
                $8, $9, $10, $11,
                $12::jsonb, $13::jsonb, $14::jsonb,
                $15, $16, $17::uuid
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
            json.dumps(evid),
            json.dumps(triage_snapshot) if triage_snapshot else None,
            estimated_blast_radius,
            llm_cost_usd,
            parent_plan_id,
        )
    except Exception:
        return None
    await emit_event(
        org_id,
        plan_id,
        "created",
        payload={"plan_kind": plan_kind, "status": status, "source_ref": source_ref},
    )
    return await get_plan(org_id, plan_id)


async def _resolve_base_ref_sha(org_id: str, agent_id: str | None) -> str | None:
    """Best-effort HEAD sha for the org's linked repo (M13 §6.6)."""
    try:
        from eden.providers.factory import get_repo_provider_for_org

        provider = await get_repo_provider_for_org(org_id, agent_id=agent_id)
        if provider is None:
            return None
        commits = await provider.get_recent_commits(limit=1)
        if commits:
            sha = getattr(commits[0], "sha", None) or (
                commits[0].get("sha") if isinstance(commits[0], dict) else None
            )
            if isinstance(sha, str) and sha:
                return sha
    except Exception:
        return None
    return None


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


async def find_open_by_fingerprint(org_id: str, source_fingerprint: str) -> dict[str, Any] | None:
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
        ORDER BY created_at DESC
        LIMIT 1
        """,
        org_id,
        source_fingerprint,
        list(_OPEN_STATUSES),
    )
    return _row(row) if row else None


async def find_open_fingerprints(org_id: str, fingerprints: list[str]) -> set[str]:
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
        f"UPDATE improvement_plans SET {', '.join(sets)} " f"WHERE org_id = $1 AND id = $2::uuid",
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
    await emit_event(
        org_id, plan_id, "approved", actor=approved_by, payload={"status": status}
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
    await emit_event(
        org_id,
        plan_id,
        "pr_opened",
        actor=approved_by,
        payload={"pr_url": pr_url, "pr_number": pr_number, "github_branch": github_branch},
    )
    return await get_plan(org_id, plan_id)


async def find_by_pr(*, repo_full_name: str, pr_number: int) -> dict[str, Any] | None:
    """Locate the ``improvement_plans`` row a GitHub PR belongs to.

    Used by the GitHub webhook (Phase 2b) to sync plan status on merge/
    close. No ``org_id`` is known at webhook-receipt time, so this scans
    by the PR's canonical ``html_url`` (globally unique) — safe because
    ``pr_number`` alone can collide across repos/orgs but the full URL
    can't.
    """
    if not repo_full_name or not pr_number:
        return None
    client = await get_postgres_client()
    if client is None:
        return None
    expected_url = f"https://github.com/{repo_full_name}/pull/{pr_number}"
    row = await client.fetchrow(
        """
        SELECT * FROM improvement_plans
        WHERE pr_number = $1 AND pr_url = $2
        ORDER BY updated_at DESC
        LIMIT 1
        """,
        int(pr_number),
        expected_url,
    )
    return _row(row) if row else None


async def find_by_branch(*, github_branch: str) -> dict[str, Any] | None:
    """Locate the plan behind an ``eden/improve-*`` head branch (M9, §4.3).

    Used by the GitHub webhook's check_run/check_suite ingestion, where
    the payload carries a head branch but not always a PR number. Branch
    names embed ``plan_id[:12]`` (``approve.approve_plan``), so they are
    unique per plan; most-recently-updated wins defensively anyway.
    """
    if not github_branch:
        return None
    client = await get_postgres_client()
    if client is None:
        return None
    row = await client.fetchrow(
        """
        SELECT * FROM improvement_plans
        WHERE github_branch = $1
        ORDER BY updated_at DESC
        LIMIT 1
        """,
        github_branch,
    )
    return _row(row) if row else None


async def mark_merged(
    org_id: str,
    plan_id: str,
) -> dict[str, Any] | None:
    """PR linked to this plan merged on GitHub (Phase 2b webhook sync).

    Only transitions plans still in an "open" state — a plan already
    ``rejected``/``superseded``/``merged``/``closed`` is left alone so a
    duplicate or out-of-order webhook delivery can't clobber it.

    M13 (§6.3): also records ``merged`` outcomes into the codebase
    knowledge graph so PatchGenerator priors compound.
    """
    client = await get_postgres_client()
    if client is None:
        return None
    await client.execute(
        """
        UPDATE improvement_plans SET
            status = 'merged',
            updated_at = NOW()
        WHERE org_id = $1 AND id = $2::uuid
          AND status = ANY($3::text[])
        """,
        org_id,
        plan_id,
        list(_OPEN_STATUSES),
    )
    plan = await get_plan(org_id, plan_id)
    if plan is not None and plan.get("status") == "merged":
        try:
            from eden.patches.knowledge_graph import record_plan_outcome

            await record_plan_outcome(org_id, plan, "merged")
        except Exception:
            pass
        await emit_event(org_id, plan_id, "merged")
        # Wave 4 (4.1): open the post-merge watch (1h/24h/7d) so the
        # PostMergeMonitor comparator can catch production regressions.
        # Best-effort — a watch failure never breaks the merge.
        try:
            from eden.improvement.post_merge_monitor import PostMergeMonitor

            await PostMergeMonitor().schedule_for_plan(org_id, plan)
        except Exception:
            pass
    return plan


async def mark_closed(
    org_id: str,
    plan_id: str,
    *,
    reason: str | None = None,
    write_rejection: bool = True,
) -> dict[str, Any] | None:
    """PR linked to this plan closed on GitHub without merging (2b).

    M13 (§6.3): records ``rejected`` KG outcomes + rejection-memory
    so the next sweep does not regenerate the same closed-unmerged fix.
    """
    client = await get_postgres_client()
    if client is None:
        return None
    await client.execute(
        """
        UPDATE improvement_plans SET
            status = 'closed',
            rejection_reason = COALESCE($3, rejection_reason),
            updated_at = NOW()
        WHERE org_id = $1 AND id = $2::uuid
          AND status = ANY($4::text[])
        """,
        org_id,
        plan_id,
        reason,
        list(_OPEN_STATUSES),
    )
    plan = await get_plan(org_id, plan_id)
    if plan is not None and plan.get("status") == "closed":
        try:
            from eden.patches.knowledge_graph import record_plan_outcome

            await record_plan_outcome(org_id, plan, "rejected")
        except Exception:
            pass
        if write_rejection:
            with contextlib.suppress(Exception):
                await write_rejection_memory(
                    org_id,
                    plan,
                    rejection_reason=reason or "pr_closed_without_merge",
                )
        await emit_event(org_id, plan_id, "closed", detail=reason)
    return plan


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
    await emit_event(
        org_id, plan_id, "rejected", actor=rejected_by, detail=rejection_reason
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
    await emit_event(
        org_id,
        plan_id,
        "snoozed",
        payload={"snoozed_until": _ts(snoozed_until)},
    )
    return await get_plan(org_id, plan_id)


def _rejection_title_hash(title: str) -> str:
    import hashlib

    return hashlib.sha256((title or "")[:200].encode()).hexdigest()[:16]


def _first_file_path(files: list[Any] | None) -> str | None:
    if not files:
        return None
    first = files[0]
    if isinstance(first, str) and first:
        return first
    if isinstance(first, dict):
        path = first.get("path") or first.get("file")
        if isinstance(path, str) and path:
            return path
    return None


def _rejection_ttl_days(rejection_type: str) -> int:
    try:
        from eden.config import get_settings

        settings = get_settings()
        if rejection_type == "user_fixed":
            return int(getattr(settings, "patch_rejection_memory_user_fixed_days", 90) or 90)
        return int(getattr(settings, "patch_rejection_memory_wontfix_days", 30) or 30)
    except Exception:
        return 90 if rejection_type == "user_fixed" else 30


def _infer_rejection_type(reason: str) -> str:
    lowered = (reason or "").lower()
    if "user_fixed" in lowered or "already fixed" in lowered:
        return "user_fixed"
    if "outdated" in lowered:
        return "outdated"
    return "wontfix"


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
    file_path = _first_file_path(files) or fp or "unknown"
    title = (plan.get("title") or "")[:200]
    title_hash = _rejection_title_hash(title)
    rejection_type = _infer_rejection_type(rejection_reason)
    ttl_days = max(1, _rejection_ttl_days(rejection_type))
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
                $5, $6, $7, NOW() + make_interval(days => $8::int)
            )
            """,
            mem_id,
            org_id,
            file_path,
            title_hash,
            rejection_type,
            rejected_by,
            rejection_reason,
            ttl_days,
        )
    except Exception:
        pass


async def is_rejection_active(
    org_id: str,
    *,
    title: str | None = None,
    file_paths: list[str] | None = None,
    fingerprint: str | None = None,
) -> bool:
    """Return True when an unexpired rejection-memory row matches."""
    paths = [p for p in (file_paths or []) if p]
    if fingerprint:
        paths.append(fingerprint)
    title_hash = _rejection_title_hash(title or "") if title else None
    if not paths and not title_hash:
        return False
    try:
        client = await get_postgres_client()
        if client is None:
            return False
        clauses = ["org_id = $1", "expires_at > NOW()"]
        args: list[Any] = [org_id]
        path_clause = ""
        title_clause = ""
        if paths:
            args.append(paths)
            path_clause = f"file_path = ANY(${len(args)}::text[])"
        if title_hash:
            args.append(title_hash)
            title_clause = f"title_hash = ${len(args)}"
        match = " OR ".join(c for c in (path_clause, title_clause) if c)
        if not match:
            return False
        clauses.append(f"({match})")
        row = await client.fetchrow(
            f"""
            SELECT 1 FROM pr_rejection_memory
            WHERE {' AND '.join(clauses)}
            ORDER BY id
            LIMIT 1
            """,
            *args,
        )
        return row is not None
    except Exception:
        return False


async def count_code_patches_today(org_id: str) -> int:
    """Count code_patch plans created for org since UTC midnight."""
    try:
        client = await get_postgres_client()
        if client is None:
            return 0
        row = await client.fetchrow(
            """
            SELECT COUNT(*)::int AS n
            FROM improvement_plans
            WHERE org_id = $1
              AND plan_kind = 'code_patch'
              AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
            """,
            org_id,
        )
        return int((row or {}).get("n") or 0)
    except Exception:
        return 0


async def find_blocking_by_fingerprint(
    org_id: str, source_fingerprint: str
) -> dict[str, Any] | None:
    """Open plan or active snooze for fingerprint (blocks recreate)."""
    if not source_fingerprint:
        return None
    existing = await find_open_by_fingerprint(org_id, source_fingerprint)
    if existing is not None:
        return existing
    client = await get_postgres_client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT * FROM improvement_plans
            WHERE org_id = $1 AND source_fingerprint = $2
              AND status = 'snoozed'
              AND (snoozed_until IS NULL OR snoozed_until > NOW())
            ORDER BY created_at DESC
            LIMIT 1
            """,
            org_id,
            source_fingerprint,
        )
        return _row(row) if row else None
    except Exception:
        return None
