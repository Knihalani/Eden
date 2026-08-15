"""WS2 learn-in-production API routes (F39/F40/F41/F42/F44/N19)."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

import yaml
from fastapi import APIRouter, Body, Depends, File, HTTPException, Path, Query, UploadFile
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.utils.redact import redact_all
from eden.preview.gates import (
    artifacts_enabled,
    ledger_enabled,
    preview_disabled_envelope,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}",
    tags=["learn"],
    dependencies=[Depends(get_current_user), Depends(require_path_org_access)],
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
    org_id: str = Depends(require_path_org_access),
    agent_id: str | None = Query(None),
) -> dict[str, Any]:
    if not await artifacts_enabled(org_id):
        return preview_disabled_envelope("artifacts")
    from eden.nudges.engine import NudgeEngine

    engine = NudgeEngine()
    if agent_id:
        nudges = await engine.list_active(org_id, agent_id, modes=("shadow", "promoted", "archived"))
    else:
        nudges = await _list_org_artifacts(org_id)
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


async def _list_org_artifacts(org_id: str):
    from eden.nudges.models import Nudge
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return []
    rows = await client.fetch(
        """
        SELECT id, org_id, agent_id, name, trigger, action_type,
               content, mode, source_issue_id, evidence
        FROM nudges
        WHERE org_id = $1 AND mode = ANY($2::text[])
        ORDER BY created_at DESC
        LIMIT 200
        """,
        org_id,
        ["shadow", "promoted", "archived"],
    )
    return [Nudge.from_row(dict(r)) for r in rows or []]


@router.post("/nudges")
async def create_nudge(
    org_id: str = Depends(require_path_org_access),
    body: NudgeCreateRequest = Body(...),
) -> dict[str, Any]:
    if not await artifacts_enabled(org_id):
        return preview_disabled_envelope("artifacts")
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
async def promote_nudge(org_id: str = Depends(require_path_org_access), nudge_id: str = Path(...)) -> dict[str, Any]:
    if not await artifacts_enabled(org_id):
        return preview_disabled_envelope("artifacts")
    from eden.llmops.warm_learn import warm_learn_caches
    from eden.promotion.evidence_gate import EvidenceGate

    gate = EvidenceGate()
    candidates = await gate.list_queue(org_id, status=None, limit=200)
    candidate = next(
        (c for c in candidates if str(c.get("ref_id")) == nudge_id and c.get("status") != "demoted"),
        None,
    )
    if not candidate:
        cid = await gate.enqueue(org_id, kind="nudge", ref_id=nudge_id, status="shadow")
        if not cid:
            return {
                "status": "error",
                "feature": "evidence_gate",
                "live": True,
                "data": {"message": "Failed to enqueue promotion candidate"},
            }
        candidate = await gate.get_candidate(org_id, cid)
    if not candidate:
        return {
            "status": "error",
            "feature": "evidence_gate",
            "live": True,
            "data": {"message": "Promotion candidate not found"},
        }
    report = await gate.promote_if_passed(org_id, str(candidate["id"]))
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client:
            agent_id = await client.fetchval(
                "SELECT agent_id FROM nudges WHERE id = $1::uuid AND org_id = $2",
                nudge_id,
                org_id,
            )
            if agent_id:
                await warm_learn_caches(org_id, str(agent_id))
    except Exception as exc:
        logger.debug("warm after promote failed: %s", redact_all(str(exc)))
    return _ok(
        "evidence_gate",
        {
            "report": report.__dict__,
            "nudge_id": nudge_id,
            "promoted": report.passed,
        },
    )


@router.post("/nudges/{nudge_id}/archive")
async def archive_nudge(org_id: str = Depends(require_path_org_access), nudge_id: str = Path(...)) -> dict[str, Any]:
    from eden.nudges.engine import NudgeEngine

    ok = await NudgeEngine().set_mode(org_id, nudge_id, "archived")
    return _ok("runtime_nudge", {"nudge_id": nudge_id, "archived": ok})


# ── F41 Promotions ──────────────────────────────────────────────────


@router.get("/promotions")
async def list_promotions(
    org_id: str = Depends(require_path_org_access),
    status: str | None = Query(None),
) -> dict[str, Any]:
    from eden.promotion.evidence_gate import EvidenceGate

    items = await EvidenceGate().list_queue(org_id, status=status)
    return _ok("evidence_gate", {"promotions": items})


@router.get("/promotions/{candidate_id}")
async def get_promotion(org_id: str = Depends(require_path_org_access), candidate_id: str = Path(...)) -> dict[str, Any]:
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
    org_id: str = Depends(require_path_org_access), candidate_id: str = Path(...)
) -> dict[str, Any]:
    from eden.promotion.evidence_gate import EvidenceGate

    report = await EvidenceGate().promote_if_passed(org_id, candidate_id)
    return _ok("evidence_gate", {"report": report.__dict__})


@router.post("/promotions/{candidate_id}/reject")
async def reject_promotion(
    org_id: str = Depends(require_path_org_access),
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
async def get_book(org_id: str = Depends(require_path_org_access), agent_id: str = Path(...)) -> dict[str, Any]:
    if await ledger_enabled(org_id):
        from eden.kb.ledger.generator import LedgerGenerator

        ledger = await LedgerGenerator().get_latest(org_id, agent_id)
        config = await LedgerGenerator().get_config(org_id, agent_id)
        return _ok("agent_ledger", {"ledger": ledger, "book": ledger, "config": config})
    from eden.kb.book.generator import BookGenerator

    book = await BookGenerator().get_latest(org_id, agent_id)
    config = await BookGenerator().get_config(org_id, agent_id)
    return _ok("agent_book", {"book": book, "config": config})


@router.post("/agents/{agent_id}/book/regenerate")
async def regenerate_book(org_id: str = Depends(require_path_org_access), agent_id: str = Path(...)) -> dict[str, Any]:
    from eden.kb.book.generator import BookGenerator

    book = await BookGenerator().generate(org_id, agent_id, publish_mode="manual")
    return _ok("agent_book", {"book": book})


@router.patch("/agents/{agent_id}/book/config")
async def patch_book_config(
    org_id: str = Depends(require_path_org_access),
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
async def get_drift_scores(org_id: str = Depends(require_path_org_access), agent_id: str = Path(...)) -> dict[str, Any]:
    from eden.insights.drift_reports import DriftReportBuilder

    report = await DriftReportBuilder().get_latest(org_id, agent_id)
    if report:
        return _ok("behavioral_drift", {"report": report})
    computed = await DriftReportBuilder().compute_report(org_id, agent_id)
    return _ok("behavioral_drift", {"report": computed})


@router.get("/agents/{agent_id}/drift/report/latest")
async def get_drift_report(org_id: str = Depends(require_path_org_access), agent_id: str = Path(...)) -> dict[str, Any]:
    from eden.insights.drift_reports import DriftReportBuilder

    report = await DriftReportBuilder().get_latest(org_id, agent_id)
    return _ok("behavioral_drift", {"report": report})


@router.post("/agents/{agent_id}/drift/compute")
async def compute_drift(org_id: str = Depends(require_path_org_access), agent_id: str = Path(...)) -> dict[str, Any]:
    from eden.insights.drift_reports import DriftReportBuilder

    report = await DriftReportBuilder().compute_report(org_id, agent_id)
    return _ok("behavioral_drift", {"report": report})


# ── F44 Production eval slices ────────────────────────────────────


@router.get("/production-datasets")
async def list_production_datasets(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    from eden.evaluation.auto_curator import AutoCurator

    slices = await AutoCurator().list_slices(org_id, "default-agent")
    return _ok("auto_eval_slices", {"slices": slices})


@router.get("/production-datasets/{agent_id}")
async def get_agent_slices(org_id: str = Depends(require_path_org_access), agent_id: str = Path(...)) -> dict[str, Any]:
    from eden.evaluation.auto_curator import AutoCurator

    slices = await AutoCurator().list_slices(org_id, agent_id)
    return _ok("auto_eval_slices", {"agent_id": agent_id, "slices": slices})


@router.post("/production-datasets/refresh")
async def refresh_slices(
    org_id: str = Depends(require_path_org_access),
    agent_id: str | None = Query(None),
) -> dict[str, Any]:
    from eden.evaluation.auto_curator import AutoCurator

    result = await AutoCurator().run_for_org(org_id, agent_id=agent_id)
    return _ok("auto_eval_slices", result)


# ── N19 Flywheel ────────────────────────────────────────────────────


@router.get("/kb/flywheel/status")
async def flywheel_status(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    from eden.kb.flywheel.coordinator import get_flywheel_coordinator

    status = await get_flywheel_coordinator().get_status(org_id)
    return _ok("kb_flywheel", status)


@router.get("/issues/{issue_id}/kb-suggestions")
async def kb_suggestions(org_id: str = Depends(require_path_org_access), issue_id: str = Path(...)) -> dict[str, Any]:
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


# ── Artifacts API aliases (/artifacts ↔ nudges) ─────────────────────


@router.get("/artifacts")
async def list_artifacts(
    org_id: str = Depends(require_path_org_access),
    agent_id: str | None = Query(None),
    mode: str | None = Query(None),
) -> dict[str, Any]:
    if not await artifacts_enabled(org_id):
        return preview_disabled_envelope("artifacts")
    from eden.nudges.cost_estimator import CostEstimator
    from eden.nudges.engine import NudgeEngine

    engine = NudgeEngine()
    modes = (mode,) if mode else ("shadow", "promoted", "archived")
    if agent_id:
        nudges = await engine.list_active(org_id, agent_id, modes=modes)
    else:
        nudges = await _list_org_artifacts(org_id)
        if mode:
            nudges = [n for n in nudges if n.mode == mode]
    est = CostEstimator()
    return _ok(
        "artifacts",
        {
            "artifacts": [
                {
                    "id": str(n.id),
                    "agent_id": n.agent_id,
                    "name": n.name,
                    "mode": n.mode,
                    "action_type": n.action_type,
                    "trigger": n.trigger,
                    "content": n.content,
                    "source_issue_id": str(n.source_issue_id) if n.source_issue_id else None,
                    "evidence": n.evidence or {},
                    "cost": est.estimate(n.content).__dict__,
                }
                for n in nudges
            ]
        },
    )


@router.post("/artifacts")
async def create_artifact(
    org_id: str = Depends(require_path_org_access),
    body: NudgeCreateRequest = Body(...),
) -> dict[str, Any]:
    return await create_nudge(org_id, body)


@router.post("/artifacts/{artifact_id}/promote")
async def promote_artifact(org_id: str = Depends(require_path_org_access), artifact_id: str = Path(...)) -> dict[str, Any]:
    return await promote_nudge(org_id, artifact_id)


@router.post("/artifacts/{artifact_id}/archive")
async def archive_artifact(org_id: str = Depends(require_path_org_access), artifact_id: str = Path(...)) -> dict[str, Any]:
    return await archive_nudge(org_id, artifact_id)


class ArtifactNLRequest(BaseModel):
    agent_id: str
    description: str


@router.post("/artifacts/author")
async def author_artifact_nl(
    org_id: str = Depends(require_path_org_access),
    body: ArtifactNLRequest = Body(...),
) -> dict[str, Any]:
    if not await artifacts_enabled(org_id):
        return preview_disabled_envelope("artifacts")
    from eden.nudges.author import ArtifactAuthor

    aid = await ArtifactAuthor().from_nl(
        org_id, agent_id=body.agent_id, description=body.description
    )
    return _ok("artifacts", {"artifact_id": aid})


@router.post("/agents/{agent_id}/artifacts/context")
async def upload_artifact_context(
    org_id: str = Depends(require_path_org_access),
    agent_id: str = Path(...),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """FEAT-148 — upload team .txt/.md context for Book/Ledger synthesis."""
    if not await artifacts_enabled(org_id):
        return preview_disabled_envelope("artifacts")
    from eden.kb.artifact_context import (
        infer_context_content_type,
        insert_agent_context,
        is_allowed_context_filename,
        serialize_context_row,
    )

    safe_name = (file.filename or "context.txt").split("/")[-1].split("\\")[-1]
    if not is_allowed_context_filename(safe_name):
        raise HTTPException(
            status_code=400,
            detail="Only .txt and .md files are accepted for team context uploads.",
        )
    raw = await file.read(512 * 1024 + 1)
    if len(raw) > 512 * 1024:
        raise HTTPException(status_code=413, detail="Context file too large (512KB max)")
    try:
        text_content = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be UTF-8 encoded text") from None
    if not text_content.strip():
        raise HTTPException(status_code=400, detail="Context file is empty")

    content_type = infer_context_content_type(safe_name)
    if file.content_type and file.content_type.startswith("text/"):
        content_type = file.content_type

    row = await insert_agent_context(
        org_id,
        agent_id,
        filename=safe_name,
        content=text_content,
        content_type=content_type,
        created_by=str(user.get("user_id") or "unknown"),
    )
    if row is None:
        raise HTTPException(status_code=503, detail="Failed to store team context")
    payload = serialize_context_row(row)
    payload["agent_id"] = agent_id
    return _ok("artifact_context", payload)


@router.get("/agents/{agent_id}/artifacts/context")
async def list_artifact_context(
    org_id: str = Depends(require_path_org_access),
    agent_id: str = Path(...),
    limit: int = Query(20, ge=1, le=100),
) -> dict[str, Any]:
    """FEAT-148 — list team-uploaded context rows for an agent."""
    if not await artifacts_enabled(org_id):
        return preview_disabled_envelope("artifacts")
    from eden.kb.artifact_context import list_agent_context, serialize_context_row

    rows = await list_agent_context(org_id, agent_id, limit=limit)
    return _ok(
        "artifact_context",
        {"items": [serialize_context_row(r) for r in rows]},
    )


@router.get("/artifacts/demotions")
async def list_artifact_demotions(
    org_id: str = Depends(require_path_org_access),
    agent_id: str | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
) -> dict[str, Any]:
    """FEAT-157 — recent artifact demotions from promotion_candidates + archived nudges."""
    if not await artifacts_enabled(org_id):
        return preview_disabled_envelope("artifacts")

    items: list[dict[str, Any]] = []
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return _ok("artifacts", {"demotions": [], "items": []})

        if agent_id:
            gate_rows = await client.fetch(
                """
                SELECT pc.id AS candidate_id, pc.ref_id, pc.demoted_at, pc.evidence,
                       n.id AS artifact_id, n.agent_id, n.name, n.mode, n.content
                FROM promotion_candidates pc
                JOIN nudges n ON n.id::text = pc.ref_id
                WHERE pc.org_id = $1
                  AND pc.kind = 'nudge'
                  AND pc.status = 'demoted'
                  AND n.agent_id = $2
                ORDER BY pc.demoted_at DESC NULLS LAST
                LIMIT $3
                """,
                org_id,
                agent_id,
                limit,
            )
        else:
            gate_rows = await client.fetch(
                """
                SELECT pc.id AS candidate_id, pc.ref_id, pc.demoted_at, pc.evidence,
                       n.id AS artifact_id, n.agent_id, n.name, n.mode, n.content
                FROM promotion_candidates pc
                JOIN nudges n ON n.id::text = pc.ref_id
                WHERE pc.org_id = $1
                  AND pc.kind = 'nudge'
                  AND pc.status = 'demoted'
                ORDER BY pc.demoted_at DESC NULLS LAST
                LIMIT $2
                """,
                org_id,
                limit,
            )

        for row in gate_rows or []:
            evidence = row.get("evidence") or {}
            if isinstance(evidence, str):
                import json as _json

                try:
                    evidence = _json.loads(evidence)
                except Exception:
                    evidence = {}
            demoted_at = row.get("demoted_at")
            if isinstance(demoted_at, datetime):
                demoted_at = demoted_at.isoformat()
            items.append(
                {
                    "artifact_id": str(row.get("artifact_id") or row.get("ref_id") or ""),
                    "agent_id": row.get("agent_id"),
                    "name": row.get("name"),
                    "mode": row.get("mode"),
                    "reason": str(evidence.get("demote_reason") or "demoted"),
                    "demoted_at": demoted_at,
                    "source": "evidence_gate",
                    "content_preview": (str(row.get("content") or "")[:200]),
                }
            )

        seen = {item["artifact_id"] for item in items}
        remaining = max(0, limit - len(items))
        if remaining > 0:
            if agent_id:
                archived_rows = await client.fetch(
                    """
                    SELECT id, agent_id, name, mode, content, archived_at, evidence
                    FROM nudges
                    WHERE org_id = $1 AND agent_id = $2 AND mode = 'archived'
                      AND archived_at IS NOT NULL
                    ORDER BY archived_at DESC
                    LIMIT $3
                    """,
                    org_id,
                    agent_id,
                    remaining,
                )
            else:
                archived_rows = await client.fetch(
                    """
                    SELECT id, agent_id, name, mode, content, archived_at, evidence
                    FROM nudges
                    WHERE org_id = $1 AND mode = 'archived'
                      AND archived_at IS NOT NULL
                    ORDER BY archived_at DESC
                    LIMIT $2
                    """,
                    org_id,
                    remaining,
                )
            for row in archived_rows or []:
                aid = str(row["id"])
                if aid in seen:
                    continue
                evidence = row.get("evidence") or {}
                if isinstance(evidence, str):
                    import json as _json

                    try:
                        evidence = _json.loads(evidence)
                    except Exception:
                        evidence = {}
                archived_at = row.get("archived_at")
                if isinstance(archived_at, datetime):
                    archived_at = archived_at.isoformat()
                reason = (
                    evidence.get("demote_reason")
                    or evidence.get("archive_reason")
                    or "archived"
                )
                items.append(
                    {
                        "artifact_id": aid,
                        "agent_id": row.get("agent_id"),
                        "name": row.get("name"),
                        "mode": row.get("mode"),
                        "reason": str(reason),
                        "demoted_at": archived_at,
                        "source": "archived_nudge",
                        "content_preview": (str(row.get("content") or "")[:200]),
                    }
                )
    except Exception as exc:
        logger.debug(
            "list_artifact_demotions failed: %s", redact_all(str(exc))
        )

    return _ok("artifacts", {"demotions": items, "items": items})


@router.get("/artifacts/export")
async def export_artifacts_yaml(
    org_id: str = Depends(require_path_org_access),
    agent_id: str = Query(...),
) -> dict[str, Any]:
    if not await artifacts_enabled(org_id):
        return preview_disabled_envelope("artifacts")
    nudges = await _list_org_artifacts(org_id)
    nudges = [n for n in nudges if n.agent_id == agent_id]
    tree = {
        "agent_id": agent_id,
        "exported_at": datetime.now(UTC).isoformat(),
        "artifacts": [
            {
                "id": str(n.id),
                "name": n.name,
                "mode": n.mode,
                "trigger": n.trigger,
                "action_type": n.action_type,
                "content": n.content,
            }
            for n in nudges
        ],
    }
    return _ok(
        "artifacts_export",
        {"yaml": yaml.safe_dump(tree, sort_keys=False), "tree": tree},
    )


# ── Ledger API aliases (/ledger ↔ book) ─────────────────────────────


@router.get("/ledger")
async def list_ledgers(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    if not await ledger_enabled(org_id):
        return preview_disabled_envelope("ledger")
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            raise HTTPException(status_code=503, detail="Database unavailable")
        rows = await client.fetch(
            """
            SELECT agent_id, version, inject_enabled, updated_at
            FROM agent_ledgers
            WHERE org_id = $1
            ORDER BY updated_at DESC
            LIMIT 100
            """,
            org_id,
        )
        return _ok("ledger", {"ledgers": [dict(r) for r in rows or []]})
    except HTTPException:
        raise
    except Exception as exc:
        # Do not return ok+[] — portal would show a false empty state.
        logger.warning("list ledgers: %s", redact_all(str(exc)))
        raise HTTPException(status_code=503, detail="Database unavailable") from exc


@router.get("/agents/{agent_id}/ledger")
async def get_ledger(org_id: str = Depends(require_path_org_access), agent_id: str = Path(...)) -> dict[str, Any]:
    if not await ledger_enabled(org_id):
        return preview_disabled_envelope("ledger")
    from eden.kb.ledger.generator import LedgerGenerator

    ledger = await LedgerGenerator().get_latest(org_id, agent_id)
    config = await LedgerGenerator().get_config(org_id, agent_id)
    return _ok("agent_ledger", {"ledger": ledger, "config": config})


@router.get("/agents/{agent_id}/ledger/diff")
async def ledger_diff(
    org_id: str = Depends(require_path_org_access),
    agent_id: str = Path(...),
    since_version: int = Query(0),
) -> dict[str, Any]:
    if not await ledger_enabled(org_id):
        return preview_disabled_envelope("ledger")
    from eden.kb.ledger.generator import LedgerGenerator

    diff = await LedgerGenerator().diff_since_version(org_id, agent_id, since_version)
    return _ok("agent_ledger", {"diff": diff})


class LedgerPreviewRequest(BaseModel):
    task: str = ""


@router.post("/agents/{agent_id}/ledger/preview")
async def ledger_preview(
    org_id: str = Depends(require_path_org_access),
    agent_id: str = Path(...),
    body: LedgerPreviewRequest = Body(...),
) -> dict[str, Any]:
    if not await ledger_enabled(org_id):
        return preview_disabled_envelope("ledger")
    from eden.kb.ledger.retrieve import LedgerRetriever

    preview = await LedgerRetriever().preview(org_id, agent_id, body.task)
    return _ok("agent_ledger", {"preview": preview})


@router.post("/agents/{agent_id}/ledger/regenerate")
async def regenerate_ledger(org_id: str = Depends(require_path_org_access), agent_id: str = Path(...)) -> dict[str, Any]:
    if not await ledger_enabled(org_id):
        return preview_disabled_envelope("ledger")
    from eden.kb.ledger.generator import LedgerGenerator
    from eden.llmops.warm_learn import warm_learn_caches

    ledger = await LedgerGenerator().get_latest(org_id, agent_id)
    await warm_learn_caches(org_id, agent_id)
    return _ok("agent_ledger", {"ledger": ledger, "regenerated": True})


@router.get("/improve/scorecard")
async def improve_scorecard(
    org_id: str = Depends(require_path_org_access),
    suite: str = Query("smoke"),
) -> dict[str, Any]:
    # Canonical impl ships with the API package (not bench/) so Docker
    # images that only COPY src/ can serve this route.
    from eden.llmops.evolution_scorecard import run_scorecard

    result = run_scorecard(suite=suite)
    return _ok("evolution_scorecard", result)


@router.get("/onboarding/improvement-loop")
async def improvement_loop_status(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    """Live teachable improvement-loop checklist (not a static page)."""
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    steps: list[dict[str, Any]] = [
        {
            "id": "sdk",
            "label": "Connect SDK",
            "href": "/agents/connect",
            "done": False,
        },
        {
            "id": "trace",
            "label": "First production trace",
            "href": "/traces",
            "done": False,
        },
        {
            "id": "issue",
            "label": "First detected issue",
            "href": "/issues",
            "done": False,
        },
        {
            "id": "queue",
            "label": "Open Improve queue",
            "href": "/improve",
            "done": False,
        },
        {
            "id": "artifact",
            "label": "First Artifact candidate",
            "href": "/artifacts",
            "done": False,
        },
        {
            "id": "prompts",
            "label": "Prompts registry",
            "href": "/prompts",
            "done": False,
        },
        {
            "id": "ledger",
            "label": "Enable Ledger draft",
            "href": "/ledger",
            "done": False,
        },
    ]
    counts = {
        "api_keys": 0,
        "traces": 0,
        "issues": 0,
        "artifacts": 0,
        "prompts": 0,
        "ledgers": 0,
    }
    if client is not None:
        try:
            counts["api_keys"] = int(
                await client.fetchval(
                    # ``org_api_keys`` is the canonical table
                    # (migrations/009_org_api_keys.sql). This used to read
                    # ``api_keys``, which no migration creates, so the
                    # "SDK connected" onboarding predicate was always 0.
                    "SELECT COUNT(*) FROM org_api_keys "
                    "WHERE org_id = $1 AND revoked_at IS NULL",
                    org_id,
                )
                or 0
            )
        except Exception:
            try:
                counts["api_keys"] = int(
                    await client.fetchval(
                        "SELECT COUNT(*) FROM organization_api_keys WHERE org_id = $1",
                        org_id,
                    )
                    or 0
                )
            except Exception:
                counts["api_keys"] = 0
        try:
            counts["traces"] = int(
                await client.fetchval(
                    """
                    SELECT COUNT(DISTINCT trace_id) FROM telemetry_events
                    WHERE tenant_id = $1
                    """,
                    org_id,
                )
                or 0
            )
        except Exception:
            counts["traces"] = 0
        try:
            counts["issues"] = int(
                await client.fetchval(
                    "SELECT COUNT(*) FROM agent_issues WHERE org_id = $1",
                    org_id,
                )
                or 0
            )
        except Exception:
            counts["issues"] = 0
        try:
            counts["artifacts"] = int(
                await client.fetchval(
                    "SELECT COUNT(*) FROM nudges WHERE org_id = $1",
                    org_id,
                )
                or 0
            )
        except Exception:
            counts["artifacts"] = 0
        try:
            counts["prompts"] = int(
                await client.fetchval(
                    "SELECT COUNT(*) FROM prompts WHERE org_id = $1",
                    org_id,
                )
                or 0
            )
        except Exception:
            try:
                counts["prompts"] = int(
                    await client.fetchval(
                        "SELECT COUNT(*) FROM prompt_registry WHERE org_id = $1",
                        org_id,
                    )
                    or 0
                )
            except Exception:
                counts["prompts"] = 0
        try:
            counts["ledgers"] = int(
                await client.fetchval(
                    """
                    SELECT COUNT(*) FROM agent_ledgers
                    WHERE org_id = $1 AND inject_enabled = true
                    """,
                    org_id,
                )
                or 0
            )
        except Exception:
            try:
                counts["ledgers"] = int(
                    await client.fetchval(
                        "SELECT COUNT(*) FROM agent_book_config WHERE org_id = $1 AND enabled = true",
                        org_id,
                    )
                    or 0
                )
            except Exception:
                counts["ledgers"] = 0

    done_map = {
        "sdk": counts["api_keys"] > 0 or counts["traces"] > 0,
        "trace": counts["traces"] > 0,
        "issue": counts["issues"] > 0,
        # Queue is teachable once issues exist (master–detail act path is ready).
        "queue": counts["issues"] > 0,
        "artifact": counts["artifacts"] > 0,
        "prompts": counts["prompts"] > 0,
        "ledger": counts["ledgers"] > 0,
    }
    for step in steps:
        step["done"] = bool(done_map.get(str(step["id"]), False))
    completed = sum(1 for s in steps if s["done"])
    return _ok(
        "improvement_loop",
        {
            "steps": steps,
            "completed": completed,
            "total": len(steps),
            "counts": counts,
            "next_step": next((s for s in steps if not s["done"]), None),
        },
    )


@router.patch("/agents/{agent_id}/ledger/config")
async def patch_ledger_config(
    org_id: str = Depends(require_path_org_access),
    agent_id: str = Path(...),
    body: BookConfigRequest = Body(...),
) -> dict[str, Any]:
    if not await ledger_enabled(org_id):
        return preview_disabled_envelope("ledger")
    from eden.kb.ledger.generator import LedgerGenerator

    ok = await LedgerGenerator().set_config(
        org_id, agent_id, enabled=body.enabled, max_tokens=body.max_tokens
    )
    from eden.llmops.warm_learn import warm_learn_caches

    await warm_learn_caches(org_id, agent_id)
    return _ok("agent_ledger", {"updated": ok, "config": body.model_dump()})

