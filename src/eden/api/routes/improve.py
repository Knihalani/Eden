"""N17 Improvement Cockpit API + N23 improvement agent routes."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import (
    _try_resolve_token_payload,
    require_org_admin,
    require_path_org_access,
)
from eden.api.utils.clerk_auth import extract_user_id
from eden.api.utils.redact import redact_all
from eden.improvement import plans_repo, runs_repo
from eden.improvement import settings as imp_settings
from eden.improvement.agent import ImprovementAgent
from eden.improvement.approve import ApproveBlockedError, approve_plan, reject_plan_audited
from eden.improvement.cockpit_aggregator import (
    ImprovementCockpitAggregator,
    snooze_item,
)
from eden.improvement.schedule import resolved_schedule
from eden.improvement.supervise import manual_merge_plan, manual_revert_plan

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/improve",
    tags=["improve"],
    dependencies=[Depends(require_path_org_access)],
)

_aggregator = ImprovementCockpitAggregator()

def _ok(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": f"imp_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }

def _require_agent_v1(org_id: str) -> None:
    """Sync fallback — global flag only (prefer _require_agent_v1_async)."""
    from eden.config import get_settings

    if getattr(get_settings(), "improvement_agent_v1", False):
        return
    raise HTTPException(
        status_code=503,
        detail="improvement_agent_v1 is disabled for this org",
    )

async def _require_agent_v1_async(org_id: str) -> None:
    from eden.preview.gates import improvement_agent_enabled

    if await improvement_agent_enabled(org_id):
        return
    raise HTTPException(
        status_code=503,
        detail="improvement_agent_v1 is disabled for this org",
    )

class SnoozeRequest(BaseModel):
    hours: int = Field(default=24, ge=1, le=168)

class AutofixRequest(BaseModel):
    dry_run: bool = True

class PlanPatchRequest(BaseModel):
    title: str | None = None
    summary: str | None = None
    diff_unified: str | None = None

class RejectRequest(BaseModel):
    reason: str = Field(default="", max_length=2000)

class MergePlanRequest(BaseModel):
    force: bool = False

class SnoozePlanRequest(BaseModel):
    snoozed_until: str | None = None
    hours: int = Field(default=168, ge=1, le=720)

class ScheduleUpdateRequest(BaseModel):
    improvement_schedule_cron: str | None = None
    improvement_max_plans_per_sweep: int | None = Field(default=None, ge=1, le=25)

class ManualRunRequest(BaseModel):
    agent_id: str | None = None
    issue_id: str | None = None

class IterateRequest(BaseModel):
    """OOM 9.4b: user feedback for a portal-triggered guardian follow-up."""

    feedback: str = Field(default="", max_length=4000)

@router.get("/queue")
async def get_queue(
    org_id: str = Depends(require_path_org_access),
    agent_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=200),
) -> dict[str, Any]:
    queue = await _aggregator.list_queue(org_id, agent_id=agent_id, limit=limit)
    return _ok("improvement_cockpit", queue.to_dict())

@router.get("/plans")
async def list_plans(
    org_id: str = Depends(require_path_org_access),
    status: str | None = Query(None),
    plan_kind: str | None = Query(None),
    agent_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    await _require_agent_v1_async(org_id)
    plans = await plans_repo.list_plans(
        org_id,
        status=status,
        plan_kind=plan_kind,
        agent_id=agent_id,
        limit=limit,
    )
    return _ok("improvement_plans", {"plans": plans, "count": len(plans)})

@router.get("/plans/{plan_id}")
async def get_plan(
    org_id: str = Depends(require_path_org_access),
    plan_id: str = Path(...),
) -> dict[str, Any]:
    await _require_agent_v1_async(org_id)
    plan = await plans_repo.get_plan(org_id, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="plan not found")
    return _ok("improvement_plans", {"plan": plan})

@router.get("/plans/{plan_id}/post-merge-windows")
async def get_plan_post_merge_windows(
    org_id: str = Depends(require_path_org_access),
    plan_id: str = Path(...),
) -> dict[str, Any]:
    """Wave 4 (4.3) — post-merge watch windows for a plan.

    Returns the 1h/24h/7d ``post_merge_windows`` rows (oldest first). An
    empty list means the plan predates the watch (or has no merged PR).
    """
    await _require_agent_v1_async(org_id)
    plan = await plans_repo.get_plan(org_id, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="plan not found")
    windows = await _list_post_merge_windows(org_id, plan_id)
    return _ok("improvement_plans", {"windows": windows})


async def _list_post_merge_windows(org_id: str, plan_id: str) -> list[dict[str, Any]]:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT id, plan_id, agent_id, window_hours, status,
                   opened_at, closes_at, pre_issue_rate, post_issue_rate,
                   delta_pct, follow_up_plan_id, evaluated_at
            FROM post_merge_windows
            WHERE org_id = $1 AND plan_id = $2
            ORDER BY window_hours ASC
            """,
            org_id,
            plan_id,
        )
        out: list[dict[str, Any]] = []
        for r in rows or []:
            d = dict(r)
            d["id"] = str(d["id"])
            d["plan_id"] = str(d["plan_id"])
            if d.get("follow_up_plan_id"):
                d["follow_up_plan_id"] = str(d["follow_up_plan_id"])
            out.append(d)
        return out
    except Exception as exc:
        logger.warning(
            "improve: post-merge windows read failed: %s", redact_all(str(exc))
        )
        return []


@router.get("/plans/{plan_id}/events")
async def get_plan_events(
    org_id: str = Depends(require_path_org_access),
    plan_id: str = Path(...),
) -> dict[str, Any]:
    """FEAT-30 gap 3 — append-only event trail (``improvement_plan_events``).

    Oldest-first; best-effort table (see ``plans_repo.emit_event``), so an
    empty list can mean either a plan predating this table or a plan with
    no recorded transitions yet — both render the same "no events yet".
    """
    await _require_agent_v1_async(org_id)
    plan = await plans_repo.get_plan(org_id, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="plan not found")
    events = await plans_repo.list_events(org_id, plan_id)
    return _ok("improvement_plans", {"events": events})

@router.patch("/plans/{plan_id}")
async def patch_plan(
    org_id: str = Depends(require_path_org_access),
    plan_id: str = Path(...),
    body: PlanPatchRequest = Body(...),
) -> dict[str, Any]:
    await _require_agent_v1_async(org_id)
    plan = await plans_repo.get_plan(org_id, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="plan not found")
    updated = await plans_repo.update_plan(
        org_id,
        plan_id,
        title=body.title,
        summary=body.summary,
        diff_unified=body.diff_unified,
        diff_edited=True if body.diff_unified is not None else None,
    )
    return _ok("improvement_plans", {"plan": updated})

def _actor_from_payload(payload: dict | None) -> str | None:
    """Derive actor id from the authenticated session (ignore client params)."""
    if not payload:
        return None
    return extract_user_id(payload) or payload.get("sub")


@router.post("/plans/{plan_id}/approve")
async def approve_plan_route(
    org_id: str = Depends(require_path_org_access),
    plan_id: str = Path(...),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict[str, Any]:
    await require_org_admin(org_id, payload)
    await _require_agent_v1_async(org_id)
    applied_by = _actor_from_payload(payload)
    try:
        result = await approve_plan(org_id, plan_id, approved_by=applied_by)
    except ApproveBlockedError as exc:
        raise HTTPException(
            status_code=403,
            detail={"blocked_reason": exc.reason},
        ) from exc
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="plan not found")
    if result.get("status") == "invalid_state":
        raise HTTPException(status_code=409, detail=result)
    if result.get("status") in ("stub_pending", "not_implemented"):
        raise HTTPException(status_code=501, detail=result)
    if result.get("status") == "unsupported_kind":
        raise HTTPException(status_code=400, detail=result)
    if result.get("status") == "error":
        raise HTTPException(status_code=503, detail=result)
    return _ok("improvement_plans", result)

@router.post("/plans/{plan_id}/reject")
async def reject_plan_route(
    org_id: str = Depends(require_path_org_access),
    plan_id: str = Path(...),
    body: RejectRequest = Body(default_factory=RejectRequest),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict[str, Any]:
    await require_org_admin(org_id, payload)
    await _require_agent_v1_async(org_id)
    rejected_by = _actor_from_payload(payload)
    plan = await plans_repo.get_plan(org_id, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="plan not found")
    updated = await reject_plan_audited(
        org_id,
        plan_id,
        rejected_by=rejected_by,
        rejection_reason=body.reason,
    )
    await plans_repo.write_rejection_memory(
        org_id, plan, rejection_reason=body.reason, rejected_by=rejected_by
    )
    return _ok("improvement_plans", {"plan": updated})

@router.post("/plans/{plan_id}/snooze")
async def snooze_plan_route(
    org_id: str = Depends(require_path_org_access),
    plan_id: str = Path(...),
    body: SnoozePlanRequest = Body(default_factory=SnoozePlanRequest),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict[str, Any]:
    await require_org_admin(org_id, payload)
    await _require_agent_v1_async(org_id)
    if body.snoozed_until:
        try:
            until = datetime.fromisoformat(body.snoozed_until.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail="snoozed_until must be a valid ISO-8601 datetime",
            ) from exc
    else:
        until = datetime.now(UTC) + timedelta(hours=body.hours)
    plan = await plans_repo.get_plan(org_id, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="plan not found")
    updated = await plans_repo.snooze_plan(org_id, plan_id, snoozed_until=until)
    return _ok("improvement_plans", {"plan": updated, "snoozed_until": until.isoformat()})

@router.post("/plans/{plan_id}/merge")
async def merge_plan_route(
    org_id: str = Depends(require_path_org_access),
    plan_id: str = Path(...),
    body: MergePlanRequest = Body(default_factory=MergePlanRequest),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict[str, Any]:
    """Operator supervision — merge the open PR for a ``pr_opened`` plan."""
    await require_org_admin(org_id, payload)
    await _require_agent_v1_async(org_id)
    merged_by = _actor_from_payload(payload)
    result = await manual_merge_plan(
        org_id,
        plan_id,
        merged_by=merged_by,
        force=body.force,
    )
    status = result.get("status")
    if status == "not_found":
        raise HTTPException(status_code=404, detail="plan not found")
    if status == "invalid_state":
        raise HTTPException(status_code=409, detail=result)
    if status == "unsupported_kind":
        raise HTTPException(status_code=400, detail=result)
    if status == "blocked":
        raise HTTPException(
            status_code=403,
            detail={"blocked_reason": result.get("blocked_reason"), **result},
        )
    if status == "error":
        raise HTTPException(status_code=503, detail=result)
    return _ok("improvement_plans", result)

@router.post("/plans/{plan_id}/revert")
async def revert_plan_route(
    org_id: str = Depends(require_path_org_access),
    plan_id: str = Path(...),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict[str, Any]:
    """Operator supervision — draft + approve a revert for a merged plan."""
    await require_org_admin(org_id, payload)
    await _require_agent_v1_async(org_id)
    reverted_by = _actor_from_payload(payload)
    result = await manual_revert_plan(org_id, plan_id, reverted_by=reverted_by)
    status = result.get("status")
    if status == "not_found":
        raise HTTPException(status_code=404, detail="plan not found")
    if status == "invalid_state":
        raise HTTPException(status_code=409, detail=result)
    if status == "unsupported_kind":
        raise HTTPException(status_code=400, detail=result)
    if status == "blocked":
        raise HTTPException(
            status_code=403,
            detail={"blocked_reason": result.get("blocked_reason"), **result},
        )
    if status == "error":
        raise HTTPException(status_code=503, detail=result)
    return _ok("improvement_plans", result)

@router.post("/plans/{plan_id}/iterate")
async def iterate_plan_route(
    org_id: str = Depends(require_path_org_access),
    plan_id: str = Path(...),
    body: IterateRequest = Body(default_factory=IterateRequest),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict[str, Any]:
    """OOM 9.4b — portal "Request changes" on an open-PR plan.

    Creates a new guardian follow-up draft linked to this plan via
    ``parent_plan_id``.  Requires admin access + improvement_agent_v1.
    Accepts any plan in draft / pending_review / pr_opened state.
    """
    await require_org_admin(org_id, payload)
    await _require_agent_v1_async(org_id)
    plan = await plans_repo.get_plan(org_id, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="plan not found")
    allowed_states = {"draft", "pending_review", "pr_opened"}
    if plan.get("status") not in allowed_states:
        raise HTTPException(
            status_code=409,
            detail=(
                f"plan status '{plan.get('status')}' does not support iteration; "
                f"expected one of: {', '.join(sorted(allowed_states))}"
            ),
        )
    from eden.improvement.guardian import request_follow_up

    follow_up = await request_follow_up(org_id, plan, feedback=body.feedback)
    if follow_up is None:
        raise HTTPException(
            status_code=503,
            detail="Guardian follow-up draft failed; retry later",
        )
    return _ok(
        "improvement_plans",
        {"follow_up_plan": follow_up, "parent_plan_id": plan_id},
    )

@router.get("/runs")
async def list_runs(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    await _require_agent_v1_async(org_id)
    runs = await runs_repo.list_runs(org_id, limit=limit)
    watermark = await runs_repo.get_watermark(org_id)
    return _ok(
        "improvement_runs",
        {
            "runs": runs,
            "count": len(runs),
            "watermark": watermark.isoformat(),
        },
    )

@router.get("/runs/{run_id}")
async def get_run(
    org_id: str = Depends(require_path_org_access),
    run_id: str = Path(...),
) -> dict[str, Any]:
    await _require_agent_v1_async(org_id)
    run = await runs_repo.get_run(org_id, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    return _ok("improvement_runs", {"run": run})

@router.post("/runs")
async def trigger_run(
    org_id: str = Depends(require_path_org_access),
    body: ManualRunRequest = Body(default_factory=ManualRunRequest),
) -> dict[str, Any]:
    await _require_agent_v1_async(org_id)
    result = await ImprovementAgent().sweep(
        org_id,
        agent_id=body.agent_id,
        issue_id=body.issue_id,
        trigger="manual",
    )
    return _ok("improvement_runs", result)

@router.get("/schedule")
async def get_schedule(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    await _require_agent_v1_async(org_id)
    sched = await resolved_schedule(org_id)
    return _ok("improvement_schedule", sched)

@router.put("/schedule")
async def put_schedule(
    org_id: str = Depends(require_path_org_access),
    body: ScheduleUpdateRequest = Body(...),
) -> dict[str, Any]:
    await _require_agent_v1_async(org_id)
    updated = await imp_settings.update_settings(
        org_id,
        improvement_schedule_cron=body.improvement_schedule_cron,
        improvement_max_plans_per_sweep=body.improvement_max_plans_per_sweep,
    )
    sched = await resolved_schedule(org_id)
    return _ok("improvement_schedule", {**sched, **updated})

@router.post("/items/{item_ref:path}/snooze")
async def snooze(
    org_id: str = Depends(require_path_org_access),
    item_ref: str = Path(...),
    body: SnoozeRequest = Body(default_factory=SnoozeRequest),
) -> dict[str, Any]:
    until = datetime.now(UTC) + timedelta(hours=body.hours)
    await snooze_item(org_id, item_ref, until)
    return _ok(
        "improvement_cockpit",
        {"item_ref": item_ref, "snoozed_until": until.isoformat()},
    )

@router.post("/items/{item_ref:path}/approve")
async def approve(
    org_id: str = Depends(require_path_org_access),
    item_ref: str = Path(...),
    applied_by: str | None = Query(None),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict[str, Any]:
    """Route approve to the underlying closed-loop / patch surface."""
    if item_ref.startswith("closed_loop:"):
        await require_org_admin(org_id, payload)
        await _require_agent_v1_async(org_id)
        action_id = item_ref.split(":", 1)[1]
        from eden.llmops.closed_loop_executor import ClosedLoopExecutor

        result = await ClosedLoopExecutor().approve(
            org_id, action_id=action_id, applied_by=applied_by
        )
        return _ok("improvement_cockpit", {"item_ref": item_ref, "result": result})

    if item_ref.startswith("improvement_plan:"):
        await _require_agent_v1_async(org_id)
        plan_id = item_ref.split(":", 1)[1]
        try:
            result = await approve_plan(org_id, plan_id, approved_by=applied_by)
        except ApproveBlockedError as exc:
            raise HTTPException(
                status_code=403,
                detail={
                    "item_ref": item_ref,
                    "status": "blocked",
                    "blocked_reason": exc.reason,
                },
            ) from exc
        status = result.get("status")
        if status == "not_found":
            raise HTTPException(status_code=404, detail=result)
        if status == "invalid_state":
            raise HTTPException(status_code=409, detail=result)
        if status in ("stub_pending", "not_implemented"):
            raise HTTPException(status_code=501, detail=result)
        if status == "unsupported_kind":
            raise HTTPException(status_code=400, detail=result)
        if status == "error":
            raise HTTPException(status_code=503, detail=result)
        return _ok("improvement_cockpit", {"item_ref": item_ref, "result": result})

    raise HTTPException(
        status_code=400,
        detail={
            "item_ref": item_ref,
            "status": "unsupported",
            "message": "Approve not wired for this item type",
        },
    )

@router.post("/autofix/{issue_id}")
async def autofix(
    org_id: str = Depends(require_path_org_access),
    issue_id: str = Path(...),
    body: AutofixRequest = Body(default_factory=AutofixRequest),
) -> dict[str, Any]:
    """F04 ``run_autofix`` backend — dry_run returns triage/context only."""
    from eden.issues.repo import IssuesRepo

    issue = await IssuesRepo().get_issue(org_id, issue_id)
    if issue is None:
        raise HTTPException(status_code=404, detail="issue not found")

    triage = issue.triage_result
    if not triage:
        try:
            from eden.issues.triage_agent import TriageAgent

            triage_env = await TriageAgent().triage(org_id, issue_id)
            if isinstance(triage_env, dict):
                triage = triage_env.get("data") or triage_env.get("triage_result") or triage_env
        except Exception as exc:
            logger.debug("autofix triage failed: %s", redact_all(str(exc)))
            triage = {"error": str(exc)}

    if body.dry_run:
        return _ok(
            "improvement_cockpit",
            {
                "issue_id": issue_id,
                "dry_run": True,
                "patch_summary": {
                    "title": issue.title,
                    "fingerprint": issue.fingerprint,
                    "triage": triage,
                },
            },
        )

    from eden.improvement.issue_patch_trigger import propose_plan_for_issue

    result = await propose_plan_for_issue(org_id, issue_id)
    return _ok(
        "improvement_cockpit",
        {"issue_id": issue_id, "dry_run": False, "result": result},
    )
