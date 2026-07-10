"""Agent issues API (F28 / F29).

Read + resolve surface over the issues layer. Envelope style mirrors
``intelligence_autonomous.py`` (service returns a dict; the route wraps
it in the standard ``_ok_envelope`` shape).
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_feature_flag
from eden.issues.models import Issue
from eden.issues.repo import IssuesRepo

logger = logging.getLogger(__name__)

_FLAG = "agent_issues_v0"

router = APIRouter(
    prefix="/orgs/{org_id}",
    tags=["agent-issues"],
    dependencies=[
        Depends(require_feature_flag(_FLAG)),
        Depends(get_current_user),
    ],
)

_repo = IssuesRepo()


def _ok(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": f"iss_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


def _issue_dict(i: Issue) -> dict[str, Any]:
    return {
        "id": i.id,
        "org_id": i.org_id,
        "fingerprint": i.fingerprint,
        "kind": i.kind,
        "title": i.title,
        "status": i.status,
        "severity": i.severity,
        "agent_id": i.agent_id,
        "stumble_count": i.stumble_count,
        "user_count": i.user_count,
        "repetition_count": i.repetition_count,
        "affected_user_ids": i.affected_user_ids,
        "example_stumble_ids": i.example_stumble_ids,
        "triage_result": i.triage_result,
        "first_seen": i.first_seen.isoformat() if i.first_seen else None,
        "last_seen": i.last_seen.isoformat() if i.last_seen else None,
    }


class ResolveRequest(BaseModel):
    status: str = "resolved"  # resolved | ignored


@router.get("/agent-issues")
async def list_issues(
    org_id: str = Path(...),
    status: str | None = Query(None),
    severity: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    issues = await _repo.list_issues(
        org_id, status=status, severity=severity, limit=limit, offset=offset
    )
    return _ok(
        "agent_issues",
        {"issues": [_issue_dict(i) for i in issues], "count": len(issues)},
    )


@router.get("/agent-issues/{issue_id}")
async def get_issue(
    org_id: str = Path(...), issue_id: str = Path(...)
) -> dict[str, Any]:
    issue = await _repo.get_issue(org_id, issue_id)
    if issue is None:
        return {
            "status": "not_found",
            "feature": "agent_issues",
            "live": True,
            "data": {"issue_id": issue_id},
        }
    return _ok("agent_issues", {"issue": _issue_dict(issue)})


@router.post("/agent-issues/{issue_id}/resolve")
async def resolve_issue(
    org_id: str = Path(...),
    issue_id: str = Path(...),
    body: ResolveRequest = Body(default=ResolveRequest()),
) -> dict[str, Any]:
    target = body.status if body.status in ("resolved", "ignored") else "resolved"
    ok = await _repo.set_status(
        org_id, issue_id, target, set_resolved_at=(target == "resolved")
    )
    return _ok(
        "agent_issues",
        {"issue_id": issue_id, "status": target, "updated": ok},
    )


@router.get("/stumbles")
async def list_stumbles(
    org_id: str = Path(...),
    fingerprint: str | None = Query(None),
    trace_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    rows = await _repo.list_stumbles(
        org_id, fingerprint=fingerprint, trace_id=trace_id, limit=limit
    )
    # Serialize datetimes / uuids for JSON.
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        for k, v in list(d.items()):
            if isinstance(v, datetime):
                d[k] = v.isoformat()
            elif isinstance(v, uuid.UUID):
                d[k] = str(v)
        out.append(d)
    return _ok("agent_stumbles", {"stumbles": out, "count": len(out)})
