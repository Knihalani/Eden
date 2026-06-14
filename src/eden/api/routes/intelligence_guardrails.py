"""Intelligence Gap — Runtime Protection & Guardrails (Cat 15) routes.

Default behaviour for ``/guardrails/evaluate`` is
``verdict: "allow"`` with ``live: false`` so production flows
don't break before a real policy exists. A real policy is
what flips the verdict.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_feature_flag
from eden.guardrails import (
    ContentPolicyEnforcer,
    EvalToGuardrailLink,
    GuardrailMetrics,
    GuardrailPolicy,
    HallucinationBlocker,
    InterventionEngine,
    InterventionLog,
    LLMFirewall,
    PIIFirewall,
    PromptInjectionDetector,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/guardrails",
    tags=["intelligence-guardrails"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)

_policy = GuardrailPolicy()
_injection = PromptInjectionDetector()
_pii = PIIFirewall()
_hallu = HallucinationBlocker()
_content = ContentPolicyEnforcer()
_engine = InterventionEngine()
_promote = EvalToGuardrailLink()
_firewall = LLMFirewall()
_log = InterventionLog()
_metrics = GuardrailMetrics()


class PolicyCreateRequest(BaseModel):
    name: str
    type: str
    spec: dict[str, Any]
    action: str = "allow"


class EvaluateRequest(BaseModel):
    text: str
    context: str | None = None


class InjectScanRequest(BaseModel):
    text: str


class PIIRedactRequest(BaseModel):
    text: str


class HallucinationCheckRequest(BaseModel):
    candidate: str
    context: str


class ContentEnforceRequest(BaseModel):
    text: str


class PromoteRequest(BaseModel):
    judge_name: str
    threshold: float


class FirewallRequest(BaseModel):
    prompt: str


@router.post("/policies")
async def create_policy(
    org_id: str = Path(...),
    body: PolicyCreateRequest = Body(...),
) -> dict[str, Any]:
    return await _policy.create(
        org_id,
        name=body.name,
        type=body.type,
        spec=body.spec,
        action=body.action,
    )


@router.get("/policies")
async def list_policies(org_id: str = Path(...)) -> dict[str, Any]:
    return await _policy.list(org_id)


@router.post("/evaluate")
async def evaluate(
    org_id: str = Path(...),
    body: EvaluateRequest = Body(...),
    trace_id: str | None = Query(None),
) -> dict[str, Any]:
    """Evaluate all active policies for ``text`` and return a verdict.

    Default is ``verdict: "allow"`` with ``live: false`` so
    production flows don't break before a real policy exists.
    A real policy is what flips the verdict to ``live: true``.
    """
    return await _engine.evaluate_and_act(
        org_id, text=body.text, context=body.context,
        trace_id=trace_id,
    )


@router.post("/injection/scan")
async def injection_scan(
    org_id: str = Path(...),
    body: InjectScanRequest = Body(...),
) -> dict[str, Any]:
    return await _injection.scan(org_id, text=body.text)


@router.post("/pii/redact")
async def pii_redact(
    org_id: str = Path(...),
    body: PIIRedactRequest = Body(...),
) -> dict[str, Any]:
    return await _pii.redact(org_id, text=body.text)


@router.post("/hallucination/check")
async def hallucination_check(
    org_id: str = Path(...),
    body: HallucinationCheckRequest = Body(...),
) -> dict[str, Any]:
    return await _hallu.check(
        org_id, candidate=body.candidate, context=body.context
    )


@router.post("/content/enforce")
async def content_enforce(
    org_id: str = Path(...),
    body: ContentEnforceRequest = Body(...),
) -> dict[str, Any]:
    return await _content.enforce(org_id, text=body.text)


@router.post("/promote-judge")
async def promote_judge(
    org_id: str = Path(...),
    body: PromoteRequest = Body(...),
) -> dict[str, Any]:
    return await _promote.promote(
        org_id, judge_name=body.judge_name, threshold=body.threshold
    )


@router.post("/firewall")
async def firewall(
    org_id: str = Path(...),
    body: FirewallRequest = Body(...),
) -> dict[str, Any]:
    return await _firewall.firewall(org_id, prompt=body.prompt)


@router.get("/log")
async def log(
    org_id: str = Path(...),
    limit: int = Query(50, ge=1, le=500),
    since: str | None = Query(None),
) -> dict[str, Any]:
    return await _log.query(org_id, limit=limit, since=since)


@router.get("/metrics")
async def metrics(org_id: str = Path(...)) -> dict[str, Any]:
    return await _metrics.dashboard(org_id)


# ─── Scan history (Phase A.9) ────────────────────────────────────

# The portal's /guardrails page had been showing hardcoded mock data
# for "recent injection attempts" and "PII redactions" because the
# underlying scan endpoints are stateless (single-shot per request).
# This endpoint exposes the persisted ``intervention_log`` history so
# the page can render real scans.
#
# Each row in ``intervention_log`` carries an ``action`` field
# (e.g. ``"injection_block"``, ``"pii_redact"``, ``"hallucination_warn"``).
# The portal groups by ``action`` prefix, so we return the full log
# and let the client filter — the dataset is small (<500 rows).

@router.get("/scan-history")
async def scan_history(
    org_id: str = Path(...),
    limit: int = Query(100, ge=1, le=500),
    action_prefix: str | None = Query(
        None,
        description="Optional filter: only return rows whose action starts with this prefix "
        "(e.g. 'injection' to get injection blocks).",
    ),
) -> dict[str, Any]:
    """Return the org's recent scan history, optionally filtered by action prefix.

    Response shape: ``{scans: [...], count: N}``. Each row has
    ``trace_id``, ``action``, ``policy_id``, ``created_at``, ``details``.
    The portal's /guardrails page groups these by ``action`` to render
    the "Recent injection attempts" and "PII redactions" feeds.
    """
    from eden.guardrails.intervention import _fetch_intervention_log

    try:
        rows = await _fetch_intervention_log(org_id, limit=limit, since=None)
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("guardrails: scan-history fetch failed: %s", exc)
        rows = []
    if action_prefix:
        rows = [
            r for r in rows
            if str(r.get("action", "")).startswith(action_prefix)
        ]
    return {"scans": rows, "count": len(rows)}
