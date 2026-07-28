"""Intelligence Gap — Runtime Protection & Guardrails (Cat 15) routes.

Incomplete / unevaluable policy sets fail closed on
``/guardrails/evaluate`` (``verdict: "block"``, ``live: false``).
Enforced detector policies flip the envelope to ``live: true``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel

from eden.api.deps import require_feature_flag, require_path_org_access
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import safe_detail
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
        # Path org membership only — same gate as portal guardrails.
        # require_org_member keyed off X-Org-Id/cookie preferred org and
        # 403'd evaluate when that disagreed with path {org_id}.
        Depends(require_path_org_access),
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
    # "input" (inbound prompt) / "output" (outbound completion) / "both"
    # (the default — applies regardless of call direction, matching the
    # pre-``direction`` enforcement behaviour). See
    # ``eden.guardrails.policy.VALID_DIRECTIONS`` / ``GuardrailPolicy.create``.
    direction: str = "both"


class EvaluateRequest(BaseModel):
    text: str
    context: str | None = None
    # "input" (guarding an inbound prompt) / "output" (guarding an
    # outbound completion) / "both" (bypass direction filtering).
    # Left unset by most callers today — inferred below from whether
    # ``context`` was supplied (a grounding ``context`` only makes
    # sense for an output check; plain input checks typically omit
    # it), so an org's direction-scoped policies apply sensibly
    # without every existing caller having to be updated first.
    direction: str | None = None


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
    org_id: str = Depends(require_path_org_access),
    body: PolicyCreateRequest = Body(...),
) -> dict[str, Any]:
    return await _policy.create(
        org_id,
        name=body.name,
        type=body.type,
        spec=body.spec,
        action=body.action,
        direction=body.direction,
    )


@router.get("/policies")
async def list_policies(
    org_id: str = Depends(require_path_org_access),
) -> dict[str, Any]:
    return await _policy.list(org_id)


@router.post("/evaluate")
async def evaluate(
    org_id: str = Depends(require_path_org_access),
    body: EvaluateRequest = Body(...),
    trace_id: str | None = Query(None),
) -> dict[str, Any]:
    """Evaluate all active, direction-matching policies for ``text``.

    Incomplete policy sets fail closed (``block``, ``live: false``).
    Enforced detector policies flip the envelope to ``live: true``.
    """
    direction = body.direction
    if direction not in ("input", "output", "both"):
        # Not declared explicitly — infer from what's available at
        # this call site: a grounding ``context`` implies an output
        # (hallucination) check; its absence implies an input check.
        direction = "output" if body.context else "input"
    return await _engine.evaluate_and_act(
        org_id, text=body.text, context=body.context,
        trace_id=trace_id, direction=direction,
    )


@router.post("/injection/scan")
async def injection_scan(
    org_id: str = Depends(require_path_org_access),
    body: InjectScanRequest = Body(...),
) -> dict[str, Any]:
    return await _injection.scan(org_id, text=body.text)


@router.post("/pii/redact")
async def pii_redact(
    org_id: str = Depends(require_path_org_access),
    body: PIIRedactRequest = Body(...),
) -> dict[str, Any]:
    return await _pii.redact(org_id, text=body.text)


@router.post("/hallucination/check")
async def hallucination_check(
    org_id: str = Depends(require_path_org_access),
    body: HallucinationCheckRequest = Body(...),
) -> dict[str, Any]:
    return await _hallu.check(
        org_id, candidate=body.candidate, context=body.context
    )


@router.post("/content/enforce")
async def content_enforce(
    org_id: str = Depends(require_path_org_access),
    body: ContentEnforceRequest = Body(...),
) -> dict[str, Any]:
    return await _content.enforce(org_id, text=body.text)


@router.post("/promote-judge")
async def promote_judge(
    org_id: str = Depends(require_path_org_access),
    body: PromoteRequest = Body(...),
) -> dict[str, Any]:
    return await _promote.promote(
        org_id, judge_name=body.judge_name, threshold=body.threshold
    )


@router.post("/firewall")
async def firewall(
    org_id: str = Depends(require_path_org_access),
    body: FirewallRequest = Body(...),
) -> dict[str, Any]:
    return await _firewall.firewall(org_id, prompt=body.prompt)


@router.get("/log")
async def log(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=500),
    since: str | None = Query(None),
) -> dict[str, Any]:
    return await _log.query(org_id, limit=limit, since=since)


@router.get("/metrics")
async def metrics(
    org_id: str = Depends(require_path_org_access),
) -> dict[str, Any]:
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
    org_id: str = Depends(require_path_org_access),
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
    from eden.storage.postgres import get_postgres_client

    if await get_postgres_client() is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    try:
        rows = await _fetch_intervention_log(org_id, limit=limit, since=None)
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("guardrails: scan-history fetch failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Failed to load scan history"),
        ) from exc
    if action_prefix:
        prefix = action_prefix.lower()
        filtered: list[dict[str, Any]] = []
        for r in rows:
            action = str(r.get("action") or "").lower()
            reason = str(r.get("reason") or "").lower()
            verdict = str(r.get("verdict") or "").lower()
            if action.startswith(prefix):
                filtered.append(r)
                continue
            # Legacy rows: action was not persisted — match reason/verdict.
            if prefix == "injection" and "injection" in reason:
                filtered.append(r)
            elif prefix == "pii" and (
                "pii" in reason
                or (r.get("edited_text") and verdict in ("redact", "warn", "block"))
            ):
                filtered.append(r)
            elif reason.startswith(f"action={prefix}"):
                filtered.append(r)
        rows = filtered
    return {"scans": rows, "count": len(rows)}
