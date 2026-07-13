"""WS2 learn-in-production API routes (F39/F40/F41/F42/F44/N19)."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}",
    tags=["learn"],
    dependencies=[Depends(get_current_user)],
)


def _ok(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": f"lrn_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


# ── F39 Nudges ──────────────────────────────────────────────────────


class NudgeCreateRequest(BaseModel):
    agent_id: str
    name: str
    trigger: dict[str, Any] = Field(default_factory=dict)
    action_type: str = "system_append"
    content: str
    mode: str = "shadow"
    source_issue_id: str | None = None


@router.get("/nudges")
async def list_nudges(
    org_id: str = Path(...),
    agent_id: str | None = Query(None),
) -> dict[str, Any]:
    from eden.nudges.engine import NudgeEngine

    engine = NudgeEngine()
    if agent_id:
        nudges = await engine.list_active(org_id, agent_id, modes=("shadow", "promoted", "archived"))
    else:
        nudges = []
    return _ok(
        "runtime_nudge",
        {
            "nudges": [
                {
                    "id": str(n.id),
                    "agent_id": n.agent_id,
                    "name": n.name,
                    "mode": n.mode,
                    "action_type": n.action_type,
                }
                for n in nudges
            ]
        },
    )


@router.post("/nudges")
async def create_nudge(
    org_id: str = Path(...),
    body: NudgeCreateRequest = Body(...),
) -> dict[str, Any]:
    from eden.nudges.engine import NudgeEngine
    from eden.promotion.evidence_gate import EvidenceGate

    engine = NudgeEngine()
    nudge_id = await engine.create_shadow(
        org_id,
        agent_id=body.agent_id,
        name=body.name,
        trigger=body.trigger,
        action_type=body.action_type,
        content=body.content,
        source_issue_id=body.source_issue_id,
    )
    if nudge_id and body.mode == "shadow":
        await EvidenceGate().enqueue(org_id, kind="nudge", ref_id=nudge_id)
    return _ok("runtime_nudge", {"nudge_id": nudge_id, "mode": body.mode})


@router.post("/nudges/{nudge_id}/promote")
async def promote_nudge(org_id: str = Path(...), nudge_id: str = Path(...)) -> dict[str, Any]:
    from eden.promotion.evidence_gate import EvidenceGate

    gate = EvidenceGate()
    candidates = await gate.list_queue(org_id, status="shadow")
    candidate = next((c for c in candidates if str(c.get("ref_id")) == nudge_id), None)
    if candidate:
        report = await gate.promote_if_passed(org_id, str(candidate["id"]))
        return _ok("evidence_gate", {"report": report.__dict__, "nudge_id": nudge_id})
    from eden.nudges.engine import NudgeEngine

    ok = await NudgeEngine().set_mode(org_id, nudge_id, "promoted")
    return _ok("runtime_nudge", {"nudge_id": nudge_id, "promoted": ok})


@router.post("/nudges/{nudge_id}/archive")
async def archive_nudge(org_id: str = Path(...), nudge_id: str = Path(...)) -> dict[str, Any]:
    from eden.nudges.engine import NudgeEngine

    ok = await NudgeEngine().set_mode(org_id, nudge_id, "archived")
    return _ok("runtime_nudge", {"nudge_id": nudge_id, "archived": ok})


# ── F41 Promotions ──────────────────────────────────────────────────


@router.get("/promotions")
async def list_promotions(
    org_id: str = Path(...),
    status: str | None = Query(None),
) -> dict[str, Any]:
    from eden.promotion.evidence_gate import EvidenceGate

    items = await EvidenceGate().list_queue(org_id, status=status)
    return _ok("evidence_gate", {"promotions": items})


@router.get("/promotions/{candidate_id}")
async def get_promotion(org_id: str = Path(...), candidate_id: str = Path(...)) -> dict[str, Any]:
    from eden.promotion.evidence_gate import EvidenceGate

    gate = EvidenceGate()
    candidate = await gate.get_candidate(org_id, candidate_id)
    if not candidate:
        return {"status": "not_found", "feature": "evidence_gate", "live": True, "data": {}}
    report = await gate.evaluate(org_id, candidate_id)
    return _ok(
        "evidence_gate",
        {"candidate": candidate, "report": report.__dict__},
    )


@router.post("/promotions/{candidate_id}/approve")
async def approve_promotion(
    org_id: str = Path(...), candidate_id: str = Path(...)
) -> dict[str, Any]:
    from eden.promotion.evidence_gate import EvidenceGate

    report = await EvidenceGate().promote_if_passed(org_id, candidate_id)
    return _ok("evidence_gate", {"report": report.__dict__})


@router.post("/promotions/{candidate_id}/reject")
async def reject_promotion(
    org_id: str = Path(...),
    candidate_id: str = Path(...),
    reason: str = Query("manual_reject"),
) -> dict[str, Any]:
    from eden.promotion.evidence_gate import EvidenceGate

    ok = await EvidenceGate().demote(org_id, candidate_id, reason=reason)
    return _ok("evidence_gate", {"rejected": ok, "reason": reason})


# ── F40 Book ────────────────────────────────────────────────────────


class BookConfigRequest(BaseModel):
    enabled: bool = False
    max_tokens: int = 2000


@router.get("/agents/{agent_id}/book")
async def get_book(org_id: str = Path(...), agent_id: str = Path(...)) -> dict[str, Any]:
    from eden.kb.book.generator import BookGenerator

    book = await BookGenerator().get_latest(org_id, agent_id)
    config = await BookGenerator().get_config(org_id, agent_id)
    return _ok("agent_book", {"book": book, "config": config})


@router.post("/agents/{agent_id}/book/regenerate")
async def regenerate_book(org_id: str = Path(...), agent_id: str = Path(...)) -> dict[str, Any]:
    from eden.kb.book.generator import BookGenerator

    book = await BookGenerator().generate(org_id, agent_id, publish_mode="manual")
    return _ok("agent_book", {"book": book})


@router.patch("/agents/{agent_id}/book/config")
async def patch_book_config(
    org_id: str = Path(...),
    agent_id: str = Path(...),
    body: BookConfigRequest = Body(...),
) -> dict[str, Any]:
    from eden.kb.book.generator import BookGenerator

    ok = await BookGenerator().set_config(
        org_id, agent_id, enabled=body.enabled, max_tokens=body.max_tokens
    )
    return _ok("agent_book", {"updated": ok, "config": body.model_dump()})


# ── F42 Drift ───────────────────────────────────────────────────────


@router.get("/agents/{agent_id}/drift")
async def get_drift_scores(org_id: str = Path(...), agent_id: str = Path(...)) -> dict[str, Any]:
    from eden.insights.drift_reports import DriftReportBuilder

    report = await DriftReportBuilder().get_latest(org_id, agent_id)
    if report:
        return _ok("behavioral_drift", {"report": report})
    computed = await DriftReportBuilder().compute_report(org_id, agent_id)
    return _ok("behavioral_drift", {"report": computed})


@router.get("/agents/{agent_id}/drift/report/latest")
async def get_drift_report(org_id: str = Path(...), agent_id: str = Path(...)) -> dict[str, Any]:
    from eden.insights.drift_reports import DriftReportBuilder

    report = await DriftReportBuilder().get_latest(org_id, agent_id)
    return _ok("behavioral_drift", {"report": report})


@router.post("/agents/{agent_id}/drift/compute")
async def compute_drift(org_id: str = Path(...), agent_id: str = Path(...)) -> dict[str, Any]:
    from eden.insights.drift_reports import DriftReportBuilder

    report = await DriftReportBuilder().compute_report(org_id, agent_id)
    return _ok("behavioral_drift", {"report": report})


# ── F44 Production eval slices ────────────────────────────────────


@router.get("/production-datasets")
async def list_production_datasets(org_id: str = Path(...)) -> dict[str, Any]:
    from eden.evaluation.auto_curator import AutoCurator

    slices = await AutoCurator().list_slices(org_id, "default-agent")
    return _ok("auto_eval_slices", {"slices": slices})


@router.get("/production-datasets/{agent_id}")
async def get_agent_slices(org_id: str = Path(...), agent_id: str = Path(...)) -> dict[str, Any]:
    from eden.evaluation.auto_curator import AutoCurator

    slices = await AutoCurator().list_slices(org_id, agent_id)
    return _ok("auto_eval_slices", {"agent_id": agent_id, "slices": slices})


@router.post("/production-datasets/refresh")
async def refresh_slices(
    org_id: str = Path(...),
    agent_id: str | None = Query(None),
) -> dict[str, Any]:
    from eden.evaluation.auto_curator import AutoCurator

    result = await AutoCurator().run_for_org(org_id, agent_id=agent_id)
    return _ok("auto_eval_slices", result)


# ── N19 Flywheel ────────────────────────────────────────────────────


@router.get("/kb/flywheel/status")
async def flywheel_status(org_id: str = Path(...)) -> dict[str, Any]:
    from eden.kb.flywheel.coordinator import get_flywheel_coordinator

    status = await get_flywheel_coordinator().get_status(org_id)
    return _ok("kb_flywheel", status)


@router.get("/issues/{issue_id}/kb-suggestions")
async def kb_suggestions(org_id: str = Path(...), issue_id: str = Path(...)) -> dict[str, Any]:
    from eden.issues.repo import IssuesRepo
    from eden.kb.flywheel.coordinator import get_flywheel_coordinator

    issue = await IssuesRepo().get_issue(org_id, issue_id)
    if issue is None:
        return {"status": "not_found", "feature": "kb_flywheel", "live": True, "data": {}}
    suggestions = await get_flywheel_coordinator().suggest_for_issue(
        {
            "org_id": org_id,
            "id": issue_id,
            "title": issue.title,
            "triage_result": issue.triage_result,
        }
    )
    return _ok("kb_flywheel", {"issue_id": issue_id, "suggestions": suggestions})
