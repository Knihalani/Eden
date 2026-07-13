"""N17 Improvement Cockpit API + F04 autofix helper for MCP."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user
from eden.api.utils.redact import redact_all
from eden.improvement.cockpit_aggregator import (
    ImprovementCockpitAggregator,
    snooze_item,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/improve",
    tags=["improve"],
    dependencies=[Depends(get_current_user)],
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


class SnoozeRequest(BaseModel):
    hours: int = Field(default=24, ge=1, le=168)


class AutofixRequest(BaseModel):
    dry_run: bool = True


@router.get("/queue")
async def get_queue(
    org_id: str = Path(...),
    agent_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=200),
) -> dict[str, Any]:
    queue = await _aggregator.list_queue(org_id, agent_id=agent_id, limit=limit)
    return _ok("improvement_cockpit", queue.to_dict())


@router.post("/items/{item_ref:path}/snooze")
async def snooze(
    org_id: str = Path(...),
    item_ref: str = Path(...),
    body: SnoozeRequest = Body(default=SnoozeRequest()),
) -> dict[str, Any]:
    until = datetime.now(UTC) + timedelta(hours=body.hours)
    snooze_item(org_id, item_ref, until)
    return _ok(
        "improvement_cockpit",
        {"item_ref": item_ref, "snoozed_until": until.isoformat()},
    )


@router.post("/items/{item_ref:path}/approve")
async def approve(
    org_id: str = Path(...),
    item_ref: str = Path(...),
    applied_by: str | None = Query(None),
) -> dict[str, Any]:
    """Route approve to the underlying closed-loop / patch surface."""
    if item_ref.startswith("closed_loop:"):
        action_id = item_ref.split(":", 1)[1]
        from eden.llmops.closed_loop_executor import ClosedLoopExecutor

        result = await ClosedLoopExecutor().approve(
            org_id, action_id=action_id, applied_by=applied_by
        )
        return _ok("improvement_cockpit", {"item_ref": item_ref, "result": result})

    if item_ref.startswith("proposed_patch:"):
        return _ok(
            "improvement_cockpit",
            {
                "item_ref": item_ref,
                "status": "ack",
                "message": "Open /pr-suggestions to merge or open PR",
            },
        )

    return _ok(
        "improvement_cockpit",
        {
            "item_ref": item_ref,
            "status": "unsupported",
            "message": "Approve not wired for this item type",
        },
    )


@router.post("/autofix/{issue_id}")
async def autofix(
    org_id: str = Path(...),
    issue_id: str = Path(...),
    body: AutofixRequest = Body(default=AutofixRequest()),
) -> dict[str, Any]:
    """F04 ``run_autofix`` backend — dry_run returns triage/context only."""
    from eden.issues.repo import IssuesRepo

    issue = await IssuesRepo().get_issue(org_id, issue_id)
    if issue is None:
        return {
            "status": "not_found",
            "feature": "improvement_cockpit",
            "live": True,
            "data": {"issue_id": issue_id},
        }

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

    from eden.code_change.issue_patch_trigger import propose_patch_for_issue

    result = await propose_patch_for_issue(org_id, issue_id)
    return _ok(
        "improvement_cockpit",
        {"issue_id": issue_id, "dry_run": False, "result": result},
    )
