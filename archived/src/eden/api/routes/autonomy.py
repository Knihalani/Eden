"""Autonomy policy settings API (N22).

Exposes the org-level (and per-agent) autonomous-maintenance safety
envelope so the portal Settings → Autonomy matrix can read + edit it, and
surfaces the decision audit log for the N06 compliance pack.

    GET   /orgs/{org_id}/settings/autonomy
    PATCH /orgs/{org_id}/settings/autonomy
    GET   /orgs/{org_id}/settings/autonomy/audit
    GET   /orgs/{org_id}/settings/autonomy/budget

An optional ``agent_id`` query param scopes to a per-agent override.
Gated behind ``closed_loop_orchestrator_v1`` (the loop that consumes it).
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access
from eden.api.utils.redact import redact_all

logger = logging.getLogger(__name__)

_FLAG = "closed_loop_orchestrator_v1"

router = APIRouter(
    prefix="/orgs/{org_id}/settings/autonomy",
    tags=["autonomy"],
    dependencies=[
        Depends(require_feature_flag(_FLAG)),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)


def _ok(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": "autonomy_policy",
        "live": True,
        "trace_id": f"aut_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


class AutonomyPatch(BaseModel):
    maintenance_mode: str | None = None  # autonomous | assisted | observe
    auto_runtime_heal: bool | None = None
    auto_code_patch_pr: bool | None = None
    auto_code_patch_merge: bool | None = None
    auto_prompt_canary: bool | None = None
    auto_nudge_promote: bool | None = None
    auto_guardrail_promote: bool | None = None
    # Wave 6 — opt into the earned-autonomy program (org may then earn
    # auto_code_patch_merge automatically on a clean-merge streak).
    earned_autonomy_enabled: bool | None = None
    daily_maintenance_budget_usd: float | None = None
    max_auto_rollbacks_per_day: int | None = None
    auto_merge_max_per_week: int | None = None  # M15 (§9) canary volume cap
    compliance_profile: str | None = None  # standard | hipaa | soc2_strict


@router.get("")
async def get_autonomy(
    org_id: str = Depends(require_path_org_access),
    agent_id: str | None = Query(None),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    from eden.closed_loop.autonomy_policy import check_budget, resolve

    policy = await resolve(org_id, agent_id)
    ok, spent, limit = await check_budget(org_id, policy)
    data = policy.to_json()
    data["effective_mode"] = policy.effective_mode()
    data["budget"] = {
        "spent_usd": round(spent, 4),
        "limit_usd": limit,
        "within_budget": ok,
    }
    # M10 (§5.2 risk mitigation): counterfactual — how many reversible
    # heals were denied in the last 7d because auto_runtime_heal is off.
    data["would_have_healed_count"] = await _would_have_healed_count(org_id)
    return _ok(data)


async def _would_have_healed_count(org_id: str) -> int:
    """Count N22 heal-tier denials in the last 7 days (audit already written)."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return 0
        row = await client.fetchrow(
            """
            SELECT COUNT(*)::int AS n
            FROM autonomy_audit_log
            WHERE org_id = $1
              AND tier_applied = 'auto_runtime_heal'
              AND decision IN ('deny', 'require_approval')
              AND created_at > NOW() - INTERVAL '7 days'
            """,
            org_id,
        )
        return int((row or {}).get("n") or 0)
    except Exception as exc:
        logger.debug("would_have_healed_count failed: %s", redact_all(str(exc)))
        return 0


@router.patch("")
async def patch_autonomy(
    org_id: str = Depends(require_path_org_access),
    agent_id: str | None = Query(None),
    body: AutonomyPatch = Body(...),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    from eden.closed_loop.autonomy_policy import upsert_policy

    patch = body.model_dump(exclude_none=True)
    compliance = patch.pop("compliance_profile", None)
    mode = patch.get("maintenance_mode")
    if mode is not None and mode not in ("autonomous", "assisted", "observe"):
        return {
            "status": "invalid",
            "feature": "autonomy_policy",
            "live": True,
            "data": {"error": f"invalid maintenance_mode {mode!r}"},
        }
    if compliance is not None and compliance not in (
        "standard",
        "hipaa",
        "soc2_strict",
    ):
        return {
            "status": "invalid",
            "feature": "autonomy_policy",
            "live": True,
            "data": {"error": f"invalid compliance_profile {compliance!r}"},
        }
    updated_by = (current_user or {}).get("sub") or (current_user or {}).get(
        "user_id"
    )
    policy = await upsert_policy(
        org_id,
        agent_id=agent_id,
        patch=patch,
        compliance_profile=compliance,
        updated_by=updated_by,
    )
    data = policy.to_json()
    data["effective_mode"] = policy.effective_mode()
    return _ok(data)


@router.get("/agents")
async def get_agents(
    org_id: str = Depends(require_path_org_access),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Wave 5 (5.2) — per-agent policy rows for the settings matrix.

    Lists every agent with an ``autonomy_policies`` override row and its
    resolved policy (org default + override merged). The portal renders
    one row per agent so mode / heal / budget can be scoped per agent.
    """
    rows: list[dict[str, Any]] = []
    try:
        from eden.closed_loop.autonomy_policy import resolve
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is not None:
            fetched = await client.fetch(
                """
                SELECT DISTINCT agent_id
                FROM autonomy_policies
                WHERE org_id = $1 AND agent_id IS NOT NULL
                ORDER BY agent_id ASC
                """,
                org_id,
            )
            for r in fetched or []:
                aid = str(r["agent_id"])
                policy = await resolve(org_id, aid)
                data = policy.to_json()
                data["effective_mode"] = policy.effective_mode()
                data["agent_id"] = aid
                data["has_override"] = True
                rows.append(data)
    except Exception as exc:
        logger.debug("autonomy agents failed: %s", redact_all(str(exc)))
    return _ok({"agents": rows, "count": len(rows)})


@router.get("/budget")
async def get_budget(
    org_id: str = Depends(require_path_org_access),
) -> dict[str, Any]:
    """M4 (D12): today's maintenance budget in one place — the unified
    ``autonomy:spend:`` ledger (``check_budget``), the patch count vs
    ``patch_max_per_day``, and today's suppressed-by-budget audit rows."""
    from eden.closed_loop.autonomy_policy import check_budget, resolve

    policy = await resolve(org_id)
    ok, spent, limit = await check_budget(org_id, policy)

    patches_used = 0
    patch_cap = 0
    try:
        from eden.config import get_settings
        from eden.improvement import plans_repo

        patch_cap = int(getattr(get_settings(), "patch_max_per_day", 10) or 0)
        patches_used = await plans_repo.count_code_patches_today(org_id)
    except Exception as exc:
        logger.debug("autonomy budget patch count failed: %s", redact_all(str(exc)))

    suppressed: list[dict[str, Any]] = []
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is not None:
            fetched = await client.fetch(
                """
                SELECT id, agent_id, action, tier_applied, decision,
                       reason, created_at
                FROM autonomy_audit_log
                WHERE org_id = $1
                  AND decision = 'deny'
                  AND tier_applied = 'budget'
                  AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
                ORDER BY created_at DESC
                LIMIT 50
                """,
                org_id,
            )
            for r in fetched or []:
                d = dict(r)
                for k, v in list(d.items()):
                    if isinstance(v, datetime):
                        d[k] = v.isoformat()
                    elif isinstance(v, uuid.UUID):
                        d[k] = str(v)
                suppressed.append(d)
    except Exception as exc:
        logger.debug("autonomy budget audit fetch failed: %s", redact_all(str(exc)))

    return _ok(
        {
            "budget": {
                "spent_usd": round(spent, 4),
                "limit_usd": limit,
                "within_budget": ok,
            },
            "patches": {
                "used_today": patches_used,
                "max_per_day": patch_cap,
                "within_cap": patch_cap <= 0 or patches_used < patch_cap,
            },
            "suppressed_by_budget": suppressed,
            "suppressed_count": len(suppressed),
        }
    )


@router.get("/earnings")
async def get_earnings(
    org_id: str = Depends(require_path_org_access),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Wave 6 (6.2) — the earned-autonomy ledger.

    Publishes the documented "5 consecutive clean auto-merges" metric:
    the proven clean-merge streak (every post-merge watch window ok),
    in-flight (still being watched) and breaking plans, plus the policy
    posture that decides whether the streak is *grantable*.
    """
    from eden.closed_loop.autonomy_policy import resolve
    from eden.improvement.earned_autonomy import clean_auto_merge_streak

    status = await clean_auto_merge_streak(org_id)
    policy = await resolve(org_id)
    status["policy"] = {
        "auto_code_patch_merge": bool(policy.auto_code_patch_merge),
        "earned_autonomy_enabled": bool(policy.earned_autonomy_enabled),
        "compliance_profile": policy.compliance_profile,
        "effective_mode": policy.effective_mode(),
    }
    return _ok(status)


@router.get("/audit")
async def get_audit(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(100, ge=1, le=500),
) -> dict[str, Any]:
    from eden.storage.postgres import get_postgres_client

    rows: list[dict[str, Any]] = []
    try:
        client = await get_postgres_client()
        if client is not None:
            fetched = await client.fetch(
                """
                SELECT id, org_id, agent_id, action, tier_applied,
                       decision, reason, created_at
                FROM autonomy_audit_log
                WHERE org_id = $1
                ORDER BY created_at DESC
                LIMIT $2
                """,
                org_id,
                int(limit),
            )
            for r in fetched or []:
                d = dict(r)
                for k, v in list(d.items()):
                    if isinstance(v, datetime):
                        d[k] = v.isoformat()
                    elif isinstance(v, uuid.UUID):
                        d[k] = str(v)
                rows.append(d)
    except Exception as exc:
        logger.debug("autonomy audit fetch failed: %s", redact_all(str(exc)))
    return _ok({"entries": rows, "count": len(rows)})
