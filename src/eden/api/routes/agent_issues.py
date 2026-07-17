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
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.api.utils.redact import redact_all
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
    regression_case_id = getattr(i, "regression_case_id", None)
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
        "experiment_id": getattr(i, "experiment_id", None),
        "experiment_result": getattr(i, "experiment_result", None),
        "regression_case_id": regression_case_id,
        "regression_memory": {
            "enabled": True,
            "case_id": regression_case_id,
            "label": "Regression Memory",
            "ci_gate": bool(regression_case_id),
        },
        "first_seen": i.first_seen.isoformat() if i.first_seen else None,
        "last_seen": i.last_seen.isoformat() if i.last_seen else None,
    }


class ResolveRequest(BaseModel):
    status: str = "resolved"  # resolved | ignored


class TriageRequest(BaseModel):
    force: bool = False


class RegressionCaseRequest(BaseModel):
    max_traces: int = Field(default=3, ge=1, le=10)
    auto: bool = True


class CreateExperimentRequest(BaseModel):
    control_variant: str = "production"
    treatment_variant: str = "candidate"
    min_samples: int = 100


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
    regression_cases: list[dict[str, Any]] = []
    regression_run: dict[str, Any] | None = None
    evolution: dict[str, Any] | None = None
    if ok and target == "resolved":
        try:
            from eden.evaluation.regression_builder import on_issue_resolved

            regression_cases = await on_issue_resolved(org_id, issue_id)
        except Exception as exc:
            logger.debug("regression on resolve failed: %s", redact_all(str(exc)))
        try:
            from eden.evaluation.regression_runner import RegressionRunner

            issue = await _repo.get_issue(org_id, issue_id)
            agent_id = issue.agent_id if issue else None
            run = await RegressionRunner().run_suite(
                org_id, agent_id=agent_id, change_id=f"issue-resolve-{issue_id}"
            )
            regression_run = run.to_dict()
        except Exception as exc:
            logger.debug("regression run on resolve failed: %s", redact_all(str(exc)))
        try:
            from eden.agents.evolution.components import IssuePromptEvolver

            evolution = await IssuePromptEvolver().evolve_from_issue(
                org_id, issue_id
            )
        except Exception as exc:
            logger.debug("issue prompt evolution failed: %s", redact_all(str(exc)))
        try:
            from eden.kb.flywheel.coordinator import get_flywheel_coordinator

            issue = await _repo.get_issue(org_id, issue_id)
            if issue:
                await get_flywheel_coordinator().on_issue_resolved(
                    {
                        "org_id": org_id,
                        "id": issue.id,
                        "agent_id": issue.agent_id,
                        "title": issue.title,
                        "kind": issue.kind,
                        "stumble_count": issue.stumble_count,
                        "triage_result": issue.triage_result,
                    }
                )
        except Exception as exc:
            logger.debug("flywheel on resolve failed: %s", redact_all(str(exc)))
    return _ok(
        "agent_issues",
        {
            "issue_id": issue_id,
            "status": target,
            "updated": ok,
            "regression_cases": regression_cases,
            "regression_run": regression_run,
            "prompt_evolution": evolution,
        },
    )


@router.post("/agent-issues/{issue_id}/triage")
async def triage_issue(
    org_id: str = Path(...),
    issue_id: str = Path(...),
    body: TriageRequest = Body(default=TriageRequest()),
) -> dict[str, Any]:
    from eden.issues.triage_agent import TriageAgent

    return await TriageAgent().triage(org_id, issue_id, force=body.force)


@router.get("/agent-issues/{issue_id}/triage")
async def get_issue_triage(
    org_id: str = Path(...), issue_id: str = Path(...)
) -> dict[str, Any]:
    """Return the cached triage result (no recompute)."""
    issue = await _repo.get_issue(org_id, issue_id)
    if issue is None:
        return {
            "status": "not_found",
            "feature": "agent_issue_triage",
            "live": True,
            "data": {"issue_id": issue_id},
        }
    return _ok(
        "agent_issue_triage",
        {
            "issue_id": issue_id,
            "triage_result": issue.triage_result or {},
            "cached": bool(issue.triage_result),
        },
    )


def _serialize_stumble(row: dict[str, Any]) -> dict[str, Any]:
    d = dict(row)
    for k, v in list(d.items()):
        if isinstance(v, datetime):
            d[k] = v.isoformat()
        elif isinstance(v, uuid.UUID):
            d[k] = str(v)
    return d


@router.get("/stumbles")
async def list_stumbles(
    org_id: str = Path(...),
    fingerprint: str | None = Query(None),
    trace_id: str | None = Query(None),
    kind: str | None = Query(None),
    agent_id: str | None = Query(None),
    since: datetime | None = Query(
        None, description="ISO-8601; only stumbles detected at/after this time."
    ),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    rows = await _repo.list_stumbles(
        org_id,
        fingerprint=fingerprint,
        trace_id=trace_id,
        kind=kind,
        agent_id=agent_id,
        since=since,
        limit=limit,
    )
    out = [_serialize_stumble(r) for r in rows]
    return _ok("agent_stumbles", {"stumbles": out, "count": len(out)})


@router.get("/stumbles/{stumble_id}")
async def get_stumble(
    org_id: str = Path(...),
    stumble_id: str = Path(...),
) -> dict[str, Any]:
    row = await _repo.get_stumble(org_id, stumble_id)
    if row is None:
        return {
            "status": "not_found",
            "feature": "agent_stumble",
            "live": True,
            "data": {"stumble_id": stumble_id},
        }
    return _ok("agent_stumble", {"stumble": _serialize_stumble(row)})


class StumbleCreateRequest(BaseModel):
    trace_id: str = Field(..., min_length=1, max_length=256)
    kind: str = Field(
        "self_diagnostic",
        description="Stumble kind (SDK self-report defaults to self_diagnostic).",
    )
    title: str = Field(..., min_length=1, max_length=512)
    detail: dict[str, Any] = Field(default_factory=dict)
    severity: str | None = None
    session_id: str | None = None
    user_id: str | None = None
    agent_id: str | None = None
    span_id: str | None = None


@router.post("/stumbles")
async def create_stumble(
    org_id: str = Path(...),
    body: StumbleCreateRequest = Body(...),
) -> dict[str, Any]:
    """SDK / self-diagnostic stumble create (F28).

    Thin wrapper over :class:`StumbleWriter` so agents can self-report a
    stumble via ``eden.record_stumble()``. Goes through the same
    dedup + promotion path as detector-created stumbles.
    """
    from eden.issues.models import StumbleCreate
    from eden.issues.stumble_writer import StumbleWriter

    sc = StumbleCreate(
        org_id=org_id,
        trace_id=body.trace_id,
        kind=body.kind or "self_diagnostic",
        title=body.title,
        detail=body.detail or {},
        detected_by="sdk",
        severity=body.severity,  # type: ignore[arg-type]
        session_id=body.session_id,
        user_id=body.user_id,
        agent_id=body.agent_id,
        span_id=body.span_id,
    )
    result = await StumbleWriter().create(sc)
    return _ok("agent_stumble_create", result)


class DetectionSettingsRequest(BaseModel):
    detection_profile: str | None = Field(
        default=None, description="minimal | standard | advanced"
    )
    slm_enabled: bool | None = None


@router.get("/settings/detection")
async def get_detection_settings_route(
    org_id: str = Path(...),
) -> dict[str, Any]:
    from eden.issues.detection_settings import get_detection_settings

    settings = await get_detection_settings(org_id)
    return _ok("detection_settings", settings)


@router.patch("/settings/detection")
async def patch_detection_settings_route(
    org_id: str = Path(...),
    body: DetectionSettingsRequest = Body(default=DetectionSettingsRequest()),
) -> dict[str, Any]:
    from eden.issues.detection_settings import set_detection_settings

    try:
        settings = await set_detection_settings(
            org_id,
            detection_profile=body.detection_profile,
            slm_enabled=body.slm_enabled,
        )
    except ValueError as exc:
        return {
            "status": "invalid",
            "feature": "detection_settings",
            "live": True,
            "data": {"error": str(exc)},
        }
    return _ok("detection_settings", settings)


@router.post("/agent-issues/{issue_id}/export-fixture")
async def export_fixture(
    org_id: str = Path(...), issue_id: str = Path(...)
) -> dict[str, Any]:
    from eden.issues.fixture_export import export_issue_fixture

    result = await export_issue_fixture(org_id, issue_id)
    if result.get("status") == "not_found":
        return {
            "status": "not_found",
            "feature": "failure_fixture_export",
            "data": {"issue_id": issue_id},
        }
    return _ok("failure_fixture_export", result)


@router.post("/agent-issues/{issue_id}/experiments")
async def create_issue_experiment(
    org_id: str = Path(...),
    issue_id: str = Path(...),
    body: CreateExperimentRequest = Body(default=CreateExperimentRequest()),
) -> dict[str, Any]:
    from eden.experiments.issue_link import IssueExperimentWizard

    return await IssueExperimentWizard().create(
        org_id,
        issue_id,
        control_variant=body.control_variant,
        treatment_variant=body.treatment_variant,
        min_samples=body.min_samples,
    )


@router.get("/agent-issues/{issue_id}/experiments")
async def list_issue_experiments(
    org_id: str = Path(...), issue_id: str = Path(...)
) -> dict[str, Any]:
    from eden.experiments.issue_link import IssueExperimentWizard

    exps = await IssueExperimentWizard().list_for_issue(org_id, issue_id)
    return _ok("issue_experiments", {"experiments": exps, "count": len(exps)})


@router.get("/agent-issues/{issue_id}/experiments/{link_id}/report")
async def issue_experiment_report(
    org_id: str = Path(...),
    issue_id: str = Path(...),
    link_id: str = Path(...),
) -> dict[str, Any]:
    from eden.experiments.issue_link import IssueExperimentWizard

    return await IssueExperimentWizard().report(org_id, issue_id, link_id)


@router.get("/agent-issues/{issue_id}/regression-cases")
async def list_regression_cases(
    org_id: str = Path(...), issue_id: str = Path(...)
) -> dict[str, Any]:
    from eden.evaluation.regression_builder import RegressionCaseBuilder

    cases = await RegressionCaseBuilder().list_for_issue(org_id, issue_id)
    return _ok(
        "regression_eval",
        {"cases": [c.to_dict() for c in cases], "count": len(cases)},
    )


@router.post("/agent-issues/{issue_id}/regression-cases")
async def create_regression_cases(
    org_id: str = Path(...),
    issue_id: str = Path(...),
    body: RegressionCaseRequest = Body(default=RegressionCaseRequest()),
) -> dict[str, Any]:
    from eden.evaluation.regression_builder import RegressionCaseBuilder

    cases = await RegressionCaseBuilder().from_issue(
        org_id, issue_id, max_traces=body.max_traces, auto=body.auto
    )
    return _ok(
        "regression_eval",
        {"cases": [c.to_dict() for c in cases], "count": len(cases)},
    )

