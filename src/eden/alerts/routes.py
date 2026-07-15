"""F81 NL alert API routes."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.alerts.compiler import AlertCompiler
from eden.alerts import repo
from eden.alerts.triage_judge import AlertTriageJudge
from eden.api.deps import (
    eden_user_id_from_auth,
    get_current_user,
    resolve_eden_org_id,
)
from eden.api.utils.safe_error import safe_detail
from eden.dsl import AlertAsCode

logger = logging.getLogger(__name__)

router = APIRouter(tags=["nl-alerts"])


class CompileRequest(BaseModel):
    nl_text: str = Field(..., min_length=3, max_length=4_000)
    context: dict[str, Any] | None = None
    eql_override: str | None = None


class CompileResponse(BaseModel):
    eql: str
    warnings: list[str] = Field(default_factory=list)
    rule: dict[str, Any] = Field(default_factory=dict)
    suggested_name: str = ""


class NLRuleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    nl_text: str = Field(..., min_length=3, max_length=4_000)
    compiled_eql: str = Field(..., min_length=1)
    triage_enabled: bool = True
    channels: dict[str, Any] | None = None
    enabled: bool = True
    severity: str = "warning"
    interval_seconds: int = Field(default=3600, ge=60)


class NLRuleUpdate(BaseModel):
    name: str | None = None
    nl_text: str | None = None
    compiled_eql: str | None = None
    triage_enabled: bool | None = None
    channels: dict[str, Any] | None = None
    enabled: bool | None = None


class OverrideRequest(BaseModel):
    verdict: str = Field(..., pattern="^(real_incident|benign|duplicate)$")


async def _require_org_member(org_id: str, user: dict[str, Any]) -> str:
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        raise HTTPException(status_code=404, detail="User not found")
    eden_org_id = await resolve_eden_org_id(org_id)
    if not eden_org_id:
        raise HTTPException(status_code=404, detail="Organization not found")
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    membership = await client.fetchrow(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        eden_org_id,
        user_id,
    )
    if not membership:
        raise HTTPException(status_code=403, detail="Not a member of this organization")
    return eden_org_id


async def _require_org_admin(org_id: str, user: dict[str, Any]) -> str:
    eden_org_id = await _require_org_member(org_id, user)
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    user_id = await eden_user_id_from_auth(user)
    membership = await client.fetchrow(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        eden_org_id,
        user_id,
    )
    if membership and membership["role"] not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Admin role required")
    return eden_org_id


@router.post("/orgs/{org_id}/alerts/compile", response_model=CompileResponse)
async def compile_nl_alert(
    body: CompileRequest,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> CompileResponse:
    eden_org_id = await _require_org_member(org_id, user)
    try:
        result = await AlertCompiler().compile(
            eden_org_id,
            body.nl_text,
            context=body.context,
            eql_override=body.eql_override,
        )
    except Exception as exc:
        logger.exception("compile_nl_alert failed org=%s", org_id)
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Compile failed"),
        ) from None
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    return CompileResponse(
        eql=result.get("eql", ""),
        warnings=list(result.get("warnings") or []),
        rule=dict(result.get("rule") or {}),
        suggested_name=str(result.get("suggested_name") or ""),
    )


@router.get("/orgs/{org_id}/nl-alert-rules")
async def list_nl_alert_rules(
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    eden_org_id = await _require_org_member(org_id, user)
    rules = await repo.list_nl_rules(eden_org_id)
    return {"rules": rules, "total": len(rules)}


@router.post("/orgs/{org_id}/nl-alert-rules")
async def create_nl_alert_rule(
    body: NLRuleCreate,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    eden_org_id = await _require_org_admin(org_id, user)
    user_id = await eden_user_id_from_auth(user)
    try:
        rule = await repo.create_nl_rule(
            org_id=eden_org_id,
            name=body.name,
            nl_text=body.nl_text,
            compiled_eql=body.compiled_eql,
            triage_enabled=body.triage_enabled,
            channels=body.channels,
            enabled=body.enabled,
            created_by=user_id,
        )
        await AlertAsCode().compile(
            eden_org_id,
            name=body.name,
            eql_query=body.compiled_eql,
            interval_seconds=body.interval_seconds,
            severity=body.severity,
        )
    except Exception as exc:
        logger.exception("create_nl_alert_rule failed org=%s", org_id)
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Could not save rule"),
        ) from None
    return rule


@router.get("/orgs/{org_id}/nl-alert-rules/{rule_id}")
async def get_nl_alert_rule(
    org_id: str = Path(...),
    rule_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    eden_org_id = await _require_org_member(org_id, user)
    rule = await repo.get_nl_rule(eden_org_id, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    return rule


@router.patch("/orgs/{org_id}/nl-alert-rules/{rule_id}")
async def update_nl_alert_rule(
    body: NLRuleUpdate,
    org_id: str = Path(...),
    rule_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    eden_org_id = await _require_org_admin(org_id, user)
    rule = await repo.update_nl_rule(
        eden_org_id,
        rule_id,
        name=body.name,
        nl_text=body.nl_text,
        compiled_eql=body.compiled_eql,
        triage_enabled=body.triage_enabled,
        channels=body.channels,
        enabled=body.enabled,
    )
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    return rule


@router.delete("/orgs/{org_id}/nl-alert-rules/{rule_id}")
async def delete_nl_alert_rule(
    org_id: str = Path(...),
    rule_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    eden_org_id = await _require_org_admin(org_id, user)
    deleted = await repo.delete_nl_rule(eden_org_id, rule_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Rule not found")
    return {"status": "ok", "rule_id": rule_id}


@router.get("/orgs/{org_id}/alert-events")
async def list_alert_events(
    org_id: str = Path(...),
    verdict: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    eden_org_id = await _require_org_member(org_id, user)
    events, total = await repo.list_alert_events(
        eden_org_id,
        verdict=verdict,
        limit=limit,
        offset=offset,
    )
    return {"events": events, "total": total}


@router.post("/orgs/{org_id}/alerts/{alert_id}/override")
async def override_alert_verdict(
    body: OverrideRequest,
    org_id: str = Path(...),
    alert_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    eden_org_id = await _require_org_member(org_id, user)
    user_id = await eden_user_id_from_auth(user)
    feedback = await repo.record_triage_feedback(
        alert_event_id=alert_id,
        human_verdict=body.verdict,
        created_by=user_id,
    )
    return {"status": "ok", **feedback}
